-- Stores whose prices include VAT but don't report it separately (WooCommerce tax = 0):
-- remove the implied VAT from the commission base, so commissions are on net sales.
-- Applies to new events only; existing ledger rows are never rewritten.
insert into public.app_settings(key, value) values ('implied_vat_bps_ils', '1800')
on conflict (key) do nothing;

-- Per-store override (e.g. a VAT-exempt "osek patur" store sets 0). Null = platform default.
alter table public.organizations add column if not exists implied_vat_bps int
  check (implied_vat_bps between 0 and 5000);

create or replace function public.commission_base_minor(
  p_store uuid, p_currency text, p_total bigint, p_tax bigint, p_ship bigint, p_ship_tax bigint
) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v_vat int;
begin
  if p_tax > 0 or p_ship_tax > 0 then
    -- Store reports tax: exclude tax and shipping exactly.
    return greatest(0, p_total - p_tax - p_ship - p_ship_tax);
  end if;
  select coalesce(o.implied_vat_bps, case when p_currency = 'ILS' then public.setting_int('implied_vat_bps_ils') else 0 end)
    into v_vat from public.organizations o where o.id = p_store;
  -- Prices include VAT: base = (total - shipping) / (1 + VAT).
  return greatest(0, round((p_total - p_ship)::numeric * 10000 / (10000 + coalesce(v_vat, 0)))::bigint);
end $$;
revoke execute on function public.commission_base_minor(uuid, text, bigint, bigint, bigint, bigint) from public, anon, authenticated;

-- Order ingestion now uses commission_base_minor (implied VAT aware).
create or replace function public.ingest_order_event(p_connection uuid, p_event jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.store_connections;
  o jsonb := p_event -> 'order';
  v_evt uuid; v_occ timestamptz; v_created timestamptz;
  v_total bigint; v_tax bigint; v_ship bigint; v_ship_tax bigint; v_base bigint;
  v_status text; v_ref text; v_ref_code text; v_ref_at timestamptz;
  v_order public.orders; v_attr public.attributions; v_code public.partner_codes; v_ver public.agreement_versions;
  v_method text; v_c text; v_fee int; v_self boolean; v_founders timestamptz; v_store_fee int;
  v_eff bigint; v_r jsonb; v_new_attr boolean := false;
begin
  select * into v_conn from public.store_connections where id = p_connection;
  if not found then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_conn.status = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;

  -- Validate payload (never trust money values blindly).
  if coalesce(p_event ->> 'event_id', '') = '' or o is null or coalesce(o ->> 'id', '') = ''
     or coalesce(o ->> 'currency', '') !~ '^[A-Z]{3}$' then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  begin
    v_total := (o ->> 'total')::bigint; v_tax := coalesce((o ->> 'tax')::bigint, 0);
    v_ship := coalesce((o ->> 'shipping')::bigint, 0); v_ship_tax := coalesce((o ->> 'shipping_tax')::bigint, 0);
    v_occ := (p_event ->> 'occurred_at')::timestamptz;
    v_created := coalesce((o ->> 'created_at')::timestamptz, v_occ);
  exception when others then
    raise exception 'invalid_event' using errcode = '22023';
  end;
  if v_total is null or v_total < 0 or v_tax < 0 or v_ship < 0 or v_ship_tax < 0 or v_occ is null then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  if v_occ > now() + interval '1 day' then raise exception 'invalid_event' using errcode = '22023'; end if;

  -- 1. Idempotent inbox.
  insert into public.order_events(connection_id, event_id, external_order_id, event_type, occurred_at, payload)
  values (p_connection, left(p_event ->> 'event_id', 200), left(o ->> 'id', 64),
          left(coalesce(p_event ->> 'type', 'order.upserted'), 40), v_occ, p_event)
  on conflict (connection_id, event_id) do nothing
  returning id into v_evt;
  if v_evt is null then return json_build_object('status', 'duplicate'); end if;

  v_status := lower(coalesce(o ->> 'status', 'pending'));
  v_base := public.commission_base_minor(v_conn.org_id, o ->> 'currency', v_total, v_tax, v_ship, v_ship_tax);
  v_ref := coalesce(o ->> 'ref', '');
  if v_ref ~ '^[A-Za-z0-9]{4,16}\|[0-9]{9,11}$' then
    v_ref_code := split_part(v_ref, '|', 1);
    v_ref_at := to_timestamp(split_part(v_ref, '|', 2)::double precision);
  end if;

  -- 2. Upsert order; an older (out-of-order) event never overwrites newer state.
  insert into public.orders as ord (connection_id, store_org_id, external_order_id, currency, status, total_minor,
                                    base_minor, coupon_codes, ref_code, ref_at, customer_email_hash,
                                    order_created_at, completed_at, last_event_at)
  values (p_connection, v_conn.org_id, left(o ->> 'id', 64), o ->> 'currency', v_status, v_total, v_base,
          coalesce((select array_agg(left(x, 64)) from jsonb_array_elements_text(coalesce(o -> 'coupons', '[]'::jsonb)) x), '{}'),
          v_ref_code, v_ref_at, nullif(o ->> 'email_hash', ''), v_created,
          case when v_status = 'completed' then v_occ end, v_occ)
  on conflict (connection_id, external_order_id) do update set
    status       = case when excluded.last_event_at >= ord.last_event_at then excluded.status else ord.status end,
    total_minor  = case when excluded.last_event_at >= ord.last_event_at then excluded.total_minor else ord.total_minor end,
    base_minor   = case when excluded.last_event_at >= ord.last_event_at then excluded.base_minor else ord.base_minor end,
    currency     = case when excluded.last_event_at >= ord.last_event_at then excluded.currency else ord.currency end,
    coupon_codes = case when excluded.last_event_at >= ord.last_event_at then excluded.coupon_codes else ord.coupon_codes end,
    ref_code     = coalesce(ord.ref_code, excluded.ref_code),
    ref_at       = coalesce(ord.ref_at, excluded.ref_at),
    customer_email_hash = coalesce(ord.customer_email_hash, excluded.customer_email_hash),
    completed_at = coalesce(ord.completed_at, excluded.completed_at),
    last_event_at = greatest(ord.last_event_at, excluded.last_event_at)
  returning * into v_order;

  -- 3. Refunds: every event carries the full refund list (self-healing if one event is lost).
  for v_r in select * from jsonb_array_elements(
      coalesce(o -> 'refunds', '[]'::jsonb) || case when p_event ? 'refund' then jsonb_build_array(p_event -> 'refund') else '[]'::jsonb end)
  loop
    if coalesce(v_r ->> 'id', '') <> '' and (v_r ->> 'amount') ~ '^-?[0-9]+$' then
      insert into public.refunds(order_id, external_refund_id, amount_minor)
      values (v_order.id, left(v_r ->> 'id', 64), abs((v_r ->> 'amount')::bigint))
      on conflict (order_id, external_refund_id) do nothing;
    end if;
  end loop;
  update public.orders set refunded_minor = least(total_minor,
           (select coalesce(sum(amount_minor), 0) from public.refunds where order_id = v_order.id))
   where id = v_order.id returning * into v_order;

  -- 4. Attribution (once per order). Coupon beats link; first applied LINKUP coupon wins.
  select * into v_attr from public.attributions where order_id = v_order.id;
  if not found and v_order.status in ('processing', 'completed', 'on-hold') then
    foreach v_c in array v_order.coupon_codes loop
      select pc.* into v_code from public.partner_codes pc join public.agreements a on a.id = pc.agreement_id
       where lower(pc.code) = lower(v_c) and pc.active and a.status = 'active' and a.store_org_id = v_conn.org_id;
      if found then v_method := 'coupon'; exit; end if;
    end loop;
    if v_method is null and v_order.ref_code is not null then
      select pc.* into v_code from public.partner_codes pc join public.agreements a on a.id = pc.agreement_id
       where lower(pc.code) = lower(v_order.ref_code) and pc.active and a.status = 'active' and a.store_org_id = v_conn.org_id;
      if found then v_method := 'link'; end if;
    end if;
    if v_method is not null then
      select * into v_ver from public.agreement_versions
       where agreement_id = v_code.agreement_id and effective_from <= v_order.order_created_at + interval '10 minutes'
       order by version desc limit 1;
      if not found then
        v_method := null;
      elsif v_method = 'link' and (v_order.ref_at is null
              or v_order.ref_at > v_order.order_created_at + interval '5 minutes'
              or v_order.order_created_at - v_order.ref_at > make_interval(days => v_ver.attribution_days)) then
        v_method := null;
      end if;
    end if;

    if v_method is not null then
      v_self := v_order.customer_email_hash is not null and exists (
        select 1 from public.memberships m join auth.users u on u.id = m.user_id
         join public.agreements a on a.id = v_code.agreement_id
         where m.org_id = a.creator_org_id
           and encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = v_order.customer_email_hash);
      select founders_until, platform_fee_bps into v_founders, v_store_fee from public.organizations where id = v_conn.org_id;
      v_fee := coalesce(v_store_fee,
                 case when v_founders is not null and v_order.order_created_at < v_founders
                      then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end);
      insert into public.attributions(order_id, agreement_version_id, partner_code_id, store_org_id, creator_org_id,
                                      method, commission_bps, platform_fee_bps, self_referral_suspected, evidence)
      select v_order.id, v_ver.id, v_code.id, a.store_org_id, a.creator_org_id, v_method, v_ver.commission_bps, v_fee,
             v_self, jsonb_build_object('code', v_code.code, 'coupons', to_jsonb(v_order.coupon_codes),
                                        'ref_code', v_order.ref_code, 'ref_at', v_order.ref_at)
        from public.agreements a where a.id = v_code.agreement_id
      returning * into v_attr;
      v_new_attr := true;
      if not exists (select 1 from public.attributions where store_org_id = v_attr.store_org_id and id <> v_attr.id) then
        insert into public.funnel_events(event, org_id) values ('first_attributed_sale', v_attr.store_org_id);
      end if;
    end if;
  end if;

  -- 5. Ledger: bring totals to target for current order state (handles refunds, edits, cancellations).
  if v_attr.id is not null then
    v_eff := public.effective_base_minor(v_order.status, v_order.total_minor, v_order.base_minor, v_order.refunded_minor);
    perform public.ledger_settle(v_attr, 'creator', v_attr.creator_org_id,
                                 round(v_eff::numeric * v_attr.commission_bps / 10000)::bigint, v_order.currency, v_evt);
    perform public.ledger_settle(v_attr, 'platform', null,
                                 round(v_eff::numeric * v_attr.platform_fee_bps / 10000)::bigint, v_order.currency, v_evt);
  end if;

  update public.order_events set processed_at = now() where id = v_evt;
  return json_build_object('status', 'processed', 'order_id', v_order.id,
                           'attributed', v_attr.id is not null, 'new_attribution', v_new_attr);
end $$;

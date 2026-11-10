-- LINKUP pilot preparation:
--  1. VAT on the LINKUP fee in payment requests (rate captured at issue), offset applied after tax, verified delivery
--     and due date (14 days from delivery, never presumed), real requests gated until tax rules are approved.
--  2. Per-store fee terms (locked at activation), future rate changes with notice + explicit acceptance, individual
--     agreements, history; every sale priced by the terms in force at the order date.
--  3. Legal documents + documented acceptances (signup, store connection, re-acceptance on material change).
--  4. Payout due dates for creators (approval + 14 days) and overdue status.
-- Existing commissions, rewards and rates are not changed.

/* ================= Settings ================= */
insert into public.app_settings(key, value) values
  ('vat_bps', '1800'),                    -- Israeli VAT 18% on the LINKUP fee (captured per payment request)
  ('invoicing_tax_approved', 'false'),    -- real payment requests blocked until the accountant approves the tax rules
  ('payment_terms_days', '14'),           -- store pays LINKUP within 14 days of verified delivery
  ('creator_payment_days', '14'),         -- store pays the creator within 14 days of commission approval
  ('rate_change_notice_days', '30')
on conflict (key) do nothing;

/* ================= 2. Fee terms ================= */
create table public.fee_terms (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  kind text not null check (kind in ('founders', 'standard', 'custom')),
  fee_bps int not null check (fee_bps between 0 and 5000),
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active', 'proposed', 'declined', 'withdrawn')),
  source text not null check (source in ('activation_snapshot', 'backfill', 'rate_change', 'individual_agreement')),
  note text check (char_length(note) <= 500),
  notice_sent_at timestamptz,
  responded_at timestamptz,
  responded_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (effective_until is null or effective_until > effective_from)
);
create index fee_terms_store_idx on public.fee_terms(store_org_id, status, effective_from);
-- History is never deleted; only status/response fields may change, and only through functions.
create function public.fee_terms_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if new.store_org_id <> old.store_org_id or new.kind <> old.kind or new.fee_bps <> old.fee_bps
     or new.effective_from <> old.effective_from or new.source <> old.source then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fee_terms_guard before update or delete on public.fee_terms for each row execute function public.fee_terms_guard();

-- Snapshot of the platform terms in force when the store is activated (first connection key). Idempotent.
create function public.ensure_fee_terms(p_store uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.organizations;
begin
  if exists (select 1 from public.fee_terms where store_org_id = p_store) then return; end if;
  select * into o from public.organizations where id = p_store and type = 'store';
  if not found then return; end if;
  if o.platform_fee_bps is not null then
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, source, note)
    values (p_store, 'custom', o.platform_fee_bps, '-infinity', 'individual_agreement', 'migrated from organizations.platform_fee_bps');
  end if;
  if o.founders_until is not null then
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, effective_until, source)
    values (p_store, 'founders', public.setting_int('founders_fee_bps'), '-infinity', o.founders_until, 'activation_snapshot'),
           (p_store, 'standard', public.setting_int('standard_fee_bps'), o.founders_until, null, 'activation_snapshot');
  else
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, source)
    values (p_store, 'standard', public.setting_int('standard_fee_bps'), '-infinity', 'activation_snapshot');
  end if;
end $$;

create function public.org_fee_terms_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.founders_until is null and new.founders_until is not null then perform public.ensure_fee_terms(new.id); end if;
  return new;
end $$;
create trigger organizations_fee_terms after update of founders_until on public.organizations
  for each row execute function public.org_fee_terms_trigger();

create function public.connection_fee_terms_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- With founders pricing open, the organizations trigger snapshots the terms right after this insert.
  if not public.setting_bool('founders_open') then perform public.ensure_fee_terms(new.org_id); end if;
  return new;
end $$;
create trigger store_connections_fee_terms after insert on public.store_connections
  for each row execute function public.connection_fee_terms_trigger();

-- Existing stores: lock exactly the terms they joined under (current values, no change).
do $$ declare r record; begin
  for r in select id from public.organizations where type = 'store'
             and (founders_until is not null or exists (select 1 from public.store_connections c where c.org_id = organizations.id)) loop
    perform public.ensure_fee_terms(r.id);
  end loop;
  -- Label these rows as a backfill (the history guard is lifted only for this one-time relabel).
  alter table public.fee_terms disable trigger fee_terms_guard;
  update public.fee_terms set source = 'backfill' where source = 'activation_snapshot';
  alter table public.fee_terms enable trigger fee_terms_guard;
end $$;

-- Fee in force for a store at a moment: an active individual agreement wins; otherwise the latest active term.
create function public.fee_bps_at(p_store uuid, p_at timestamptz) returns int
language sql stable security definer set search_path = '' as $$
  select fee_bps from public.fee_terms
   where store_org_id = p_store and status = 'active' and effective_from <= p_at
     and (effective_until is null or p_at < effective_until)
   order by (kind = 'custom') desc, effective_from desc
   limit 1;
$$;

-- Platform admin: terms for NEW stores only (existing stores keep their snapshot).
create function public.set_new_store_pricing(p_founders_bps int, p_founders_months int, p_standard_bps int, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_founders_bps not between 0 and 5000 or p_standard_bps not between 0 and 5000 or p_founders_months not between 0 and 24 then
    raise exception 'invalid_setting' using errcode = '22023';
  end if;
  update public.app_settings set value = to_jsonb(p_founders_bps) where key = 'founders_fee_bps';
  update public.app_settings set value = to_jsonb(p_founders_months) where key = 'founders_months';
  update public.app_settings set value = to_jsonb(p_standard_bps) where key = 'standard_fee_bps';
  insert into public.audit_events(actor_user_id, action, details)
  values (auth.uid(), 'pricing.new_stores_changed', jsonb_build_object('founders_bps', p_founders_bps,
          'founders_months', p_founders_months, 'standard_bps', p_standard_bps, 'note', p_note));
end $$;

-- Platform admin: future change of the standard rate for existing stores. Never before the store's founders period
-- ends, at least 30 days' notice. Decreases apply automatically; increases need the store's explicit acceptance —
-- silence is never consent, and a store that declines (or does not answer) keeps its current rate.
create function public.schedule_standard_rate_change(p_new_bps int, p_effective_from timestamptz, p_note text) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_from timestamptz; v_cur int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_new_bps not between 0 and 5000 then raise exception 'invalid_setting' using errcode = '22023'; end if;
  if p_effective_from < now() + make_interval(days => public.setting_int('rate_change_notice_days')) then
    raise exception 'notice_too_short' using errcode = '22023';
  end if;
  for r in select distinct store_org_id from public.fee_terms loop
    v_from := greatest(p_effective_from, coalesce((select max(effective_until) from public.fee_terms
                                                    where store_org_id = r.store_org_id and kind = 'founders' and status = 'active'), p_effective_from));
    v_cur := public.fee_bps_at(r.store_org_id, v_from);
    continue when v_cur = p_new_bps;
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, status, source, note, notice_sent_at, created_by)
    values (r.store_org_id, 'standard', p_new_bps, v_from, case when p_new_bps < v_cur then 'active' else 'proposed' end,
            'rate_change', p_note, now(), auth.uid());
    insert into public.notifications(org_id, kind, payload)
    values (r.store_org_id, 'fee_change_notice', jsonb_build_object('fee_bps', p_new_bps, 'effective_from', v_from,
            'needs_acceptance', p_new_bps > v_cur));
    n := n + 1;
  end loop;
  insert into public.audit_events(actor_user_id, action, details)
  values (auth.uid(), 'pricing.rate_change_scheduled', jsonb_build_object('fee_bps', p_new_bps, 'effective_from', p_effective_from, 'stores', n, 'note', p_note));
  return n;
end $$;

create function public.respond_fee_change(p_term uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.fee_terms;
begin
  select * into t from public.fee_terms where id = p_term for update;
  if not found or not public.is_admin(t.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if t.status <> 'proposed' then raise exception 'already_decided' using errcode = '22023'; end if;
  update public.fee_terms set status = case when p_accept then 'active' else 'declined' end,
         responded_at = now(), responded_by = auth.uid() where id = p_term;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), t.store_org_id, case when p_accept then 'pricing.change_accepted' else 'pricing.change_declined' end,
          p_term::text, jsonb_build_object('fee_bps', t.fee_bps, 'effective_from', t.effective_from));
end $$;

-- Platform admin: individual agreement with a store (documented), from a date; never retroactive.
create function public.set_individual_fee(p_store uuid, p_fee_bps int, p_effective_from timestamptz, p_effective_until timestamptz, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_effective_from < now() - interval '1 minute' then raise exception 'invalid_dates' using errcode = '22023'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  perform public.ensure_fee_terms(p_store);
  insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, effective_until, source, note, created_by)
  values (p_store, 'custom', p_fee_bps, p_effective_from, p_effective_until, 'individual_agreement', btrim(p_note), auth.uid())
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'pricing.individual_agreement', v_id::text, jsonb_build_object('fee_bps', p_fee_bps, 'from', p_effective_from, 'until', p_effective_until));
  return v_id;
end $$;

-- What the store sees: current term, next scheduled term, pending proposals.
create function public.store_fee_terms(p_store uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'current_bps', public.fee_bps_at(p_store, now()),
    'vat_bps', public.setting_int('vat_bps'),
    'terms', coalesce((select json_agg(json_build_object('id', id, 'kind', kind, 'fee_bps', fee_bps,
                 'effective_from', case when effective_from = '-infinity' then null else effective_from end,
                 'effective_until', effective_until, 'status', status, 'source', source, 'notice_sent_at', notice_sent_at)
                 order by effective_from)
               from public.fee_terms where store_org_id = p_store and status in ('active', 'proposed')
                and (effective_until is null or effective_until > now())), '[]'));
end $$;
/* ================= Pricing by fee terms in force at the order date ================= */
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
  v_creator uuid; v_camp uuid; v_camp_bps int; v_rate int;
begin
  select * into v_conn from public.store_connections where id = p_connection;
  if not found then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_conn.status = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;

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
      select creator_org_id into v_creator from public.agreements where id = v_code.agreement_id;
      v_self := v_order.customer_email_hash is not null and exists (
        select 1 from public.memberships m join auth.users u on u.id = m.user_id
         where m.org_id = v_creator
           and encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = v_order.customer_email_hash);
      select founders_until, platform_fee_bps into v_founders, v_store_fee from public.organizations where id = v_conn.org_id;
      -- Fee terms in force at the order date (locked per store). Legacy expression only as a safety net.
      perform public.ensure_fee_terms(v_conn.org_id);
      v_fee := coalesce(public.fee_bps_at(v_conn.org_id, v_order.order_created_at), v_store_fee,
                 case when v_founders is not null and v_order.order_created_at < v_founders
                      then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end);
      -- LINKUP LAUNCH: best live campaign of this store the creator takes part in, covering the order date.
      select op.id, op.commission_bps into v_camp, v_camp_bps
        from public.opportunities op join public.opportunity_applications ap on ap.opportunity_id = op.id
       where op.store_org_id = v_conn.org_id and op.kind = 'campaign' and op.status in ('live', 'ended')
         and ap.creator_org_id = v_creator and ap.status = 'approved'
         and v_order.order_created_at >= op.starts_at and v_order.order_created_at < op.ends_at
       order by op.commission_bps desc limit 1;
      v_rate := greatest(v_ver.commission_bps, coalesce(v_camp_bps, 0));
      if v_camp_bps is null or v_camp_bps <= v_ver.commission_bps then v_camp := null; end if;

      insert into public.attributions(order_id, agreement_version_id, partner_code_id, store_org_id, creator_org_id,
                                      method, commission_bps, platform_fee_bps, self_referral_suspected, evidence,
                                      campaign_id, base_commission_bps)
      select v_order.id, v_ver.id, v_code.id, a.store_org_id, a.creator_org_id, v_method, v_rate, v_fee,
             v_self, jsonb_build_object('code', v_code.code, 'coupons', to_jsonb(v_order.coupon_codes),
                                        'ref_code', v_order.ref_code, 'ref_at', v_order.ref_at),
             v_camp, v_ver.commission_bps
        from public.agreements a where a.id = v_code.agreement_id
      returning * into v_attr;
      v_new_attr := true;
      if not exists (select 1 from public.attributions where store_org_id = v_attr.store_org_id and id <> v_attr.id) then
        insert into public.funnel_events(event, org_id) values ('first_attributed_sale', v_attr.store_org_id);
      end if;
    end if;
  end if;

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

create or replace function public.run_invoice_generation(p_period_start date) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_inv uuid; v_end timestamptz; v_credit bigint; n int := 0; v_vat_bps int; v_vat bigint; v_gross bigint;
begin
  if not public.setting_bool('invoicing_tax_approved') then
    raise exception 'invoicing_not_approved' using errcode = '42501';   -- see preview_invoices for test mode
  end if;
  v_vat_bps := public.setting_int('vat_bps');
  if p_period_start <> date_trunc('month', p_period_start)::date then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_end := (p_period_start + interval '1 month')::timestamptz;
  if v_end > now() then raise exception 'period_not_closed' using errcode = '22023'; end if;
  for r in select l.store_org_id, l.currency, sum(l.amount_minor) as fees
             from public.commission_ledger l
            where l.party_role = 'platform' and l.state = 'approved' and l.approved_at < v_end
              and not exists (select 1 from public.invoice_items ii where ii.ledger_id = l.id)
            group by l.store_org_id, l.currency
           having sum(l.amount_minor) > 0 loop
    continue when exists (select 1 from public.invoices where store_org_id = r.store_org_id and period_start = p_period_start
                                                          and currency = r.currency and status <> 'void');
    perform 1 from public.organizations where id = r.store_org_id for update;   -- serialises with reward transfers
    -- Tax is computed on the full fee; the FOUNDING PARTNERS offset is a separate settlement applied to the amount
    -- due and never reduces the VAT base. [Accountant approval required — see invoicing_tax_approved]
    v_vat := round(r.fees::numeric * v_vat_bps / 10000)::bigint;
    v_gross := r.fees + v_vat;
    v_credit := least(v_gross, greatest(0, public.wallet_balance_minor(r.store_org_id, r.currency)));
    insert into public.invoices(store_org_id, period_start, currency, fees_minor, vat_bps, vat_minor, credit_minor, total_minor, status, paid_at)
    values (r.store_org_id, p_period_start, r.currency, r.fees, v_vat_bps, v_vat, v_credit, v_gross - v_credit,
            case when v_gross - v_credit = 0 then 'paid' else 'issued' end,
            case when v_gross - v_credit = 0 then now() end)
    returning id into v_inv;
    insert into public.invoice_items(invoice_id, ledger_id, amount_minor)
    select v_inv, l.id, l.amount_minor from public.commission_ledger l
     where l.store_org_id = r.store_org_id and l.currency = r.currency and l.party_role = 'platform'
       and l.state = 'approved' and l.approved_at < v_end
       and not exists (select 1 from public.invoice_items ii where ii.ledger_id = l.id);
    if v_credit > 0 then
      insert into public.reward_payouts(org_id, currency, amount_minor, method, invoice_id)
      values (r.store_org_id, r.currency, v_credit, 'invoice_credit', v_inv);
    end if;
    if v_gross - v_credit = 0 then perform public.settle_invoice_rewards(v_inv); end if;
    insert into public.notifications(org_id, kind, payload)
    values (r.store_org_id, 'invoice_issued', jsonb_build_object('invoice_id', v_inv));
    n := n + 1;
  end loop;
  return n;
end $$;

/* ================= 1. Payment requests: VAT, delivery, due date ================= */
alter table public.invoices add column if not exists vat_bps int not null default 0 check (vat_bps between 0 and 5000);
alter table public.invoices add column if not exists vat_minor bigint not null default 0 check (vat_minor >= 0);
alter table public.invoices add column if not exists delivered_at timestamptz;
alter table public.invoices add column if not exists delivery_method text check (delivery_method in ('email', 'whatsapp', 'in_app', 'other'));
alter table public.invoices add column if not exists delivery_reference text check (char_length(delivery_reference) <= 200);
alter table public.invoices drop constraint if exists invoices_check;
alter table public.invoices add constraint invoices_amounts_check
  check (fees_minor > 0 and credit_minor <= fees_minor + vat_minor and total_minor = fees_minor + vat_minor - credit_minor);
-- Due date = verified delivery + 14 days. No delivery recorded → no due date (never presumed from issue).
alter table public.invoices alter column due_at drop not null;
alter table public.invoices alter column due_at drop default;
update public.invoices set due_at = null where delivered_at is null;

create function public.mark_invoice_delivered(p_invoice uuid, p_method text, p_reference text, p_delivered_at timestamptz default null)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_at timestamptz := coalesce(p_delivered_at, now()); v_due timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_method not in ('email', 'whatsapp', 'in_app', 'other') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if v_at > now() + interval '5 minutes' then raise exception 'invalid_dates' using errcode = '22023'; end if;
  v_due := v_at + make_interval(days => public.setting_int('payment_terms_days'));
  update public.invoices set delivered_at = v_at, delivery_method = p_method,
         delivery_reference = nullif(btrim(coalesce(p_reference, '')), ''), due_at = v_due
   where id = p_invoice and status = 'issued' and delivered_at is null and v_at >= issued_at - interval '5 minutes'
  returning store_org_id into v_store;
  if v_store is null then raise exception 'invoice_not_deliverable' using errcode = '22023'; end if;
  insert into public.notifications(org_id, kind, payload) values (v_store, 'invoice_delivered', jsonb_build_object('invoice_id', p_invoice, 'due_at', v_due));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), v_store, 'invoice.delivered', p_invoice::text, jsonb_build_object('method', p_method, 'at', v_at));
  return v_due;
end $$;

-- Test mode: what a monthly run WOULD produce, without creating anything (works while real requests are blocked).
create function public.preview_invoices(p_period_start date) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_end timestamptz; v_vat_bps int := public.setting_int('vat_bps');
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_end := (p_period_start + interval '1 month')::timestamptz;
  return coalesce((select json_agg(x order by x.store) from (
    select o.name as store, l.currency, sum(l.amount_minor) as fees_minor, v_vat_bps as vat_bps,
           round(sum(l.amount_minor)::numeric * v_vat_bps / 10000)::bigint as vat_minor,
           least(sum(l.amount_minor) + round(sum(l.amount_minor)::numeric * v_vat_bps / 10000)::bigint,
                 greatest(0, public.wallet_balance_minor(l.store_org_id, l.currency))) as credit_minor
      from public.commission_ledger l join public.organizations o on o.id = l.store_org_id
     where l.party_role = 'platform' and l.state = 'approved' and l.approved_at < v_end
       and not exists (select 1 from public.invoice_items ii where ii.ledger_id = l.id)
     group by o.name, l.store_org_id, l.currency having sum(l.amount_minor) > 0) x), '[]');
end $$;

/* ================= 4. Creator payment due dates ================= */
create or replace function public.payout_balances(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_type text; v_days int := public.setting_int('creator_payment_days');
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select type into v_type from public.organizations where id = p_org;
  return coalesce((select json_agg(x order by x.approved_unpaid_minor desc) from (
    select y.*, case when y.approved_unpaid_minor > 0 then y.oldest_unpaid_approved_at + make_interval(days => v_days) end as due_at,
           (y.approved_unpaid_minor > 0 and y.oldest_unpaid_approved_at + make_interval(days => v_days) < now()) as overdue
      from (
    select case when v_type = 'store' then l.party_org_id else l.store_org_id end as other_org_id,
           (select name from public.organizations where id = case when v_type = 'store' then l.party_org_id else l.store_org_id end) as other_name,
           l.currency,
           sum(l.amount_minor) filter (where l.state = 'pending') as pending_minor,
           coalesce(sum(l.amount_minor) filter (where l.state = 'approved'
                    and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)), 0) as approved_unpaid_minor,
           coalesce(sum(l.amount_minor) filter (where exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)), 0) as paid_minor,
           min(l.approved_at) filter (where l.state = 'approved' and l.amount_minor > 0
                    and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)) as oldest_unpaid_approved_at
      from public.commission_ledger l
     where l.party_role = 'creator' and ((v_type = 'store' and l.store_org_id = p_org) or (v_type <> 'store' and l.party_org_id = p_org))
     group by 1, 2, 3) y) x), '[]');
end $$;

/* ================= 3. Legal documents & documented acceptance ================= */
create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  doc_key text not null check (doc_key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  locale text not null check (locale in ('he', 'en')),
  version int not null check (version > 0),
  title text not null check (char_length(title) between 2 and 200),
  body text not null check (char_length(body) between 10 and 200000),
  audience text not null check (audience in ('all', 'store', 'creator', 'none')),   -- who must accept ('none' = informational)
  sort_order int not null default 100,
  requires_reacceptance boolean not null default false,  -- material change: users of earlier versions must accept again
  status text not null default 'draft' check (status in ('draft', 'published')),
  effective_from timestamptz,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (doc_key, locale, version)
);
create trigger legal_documents_no_delete before delete on public.legal_documents for each row execute function public.forbid_change();
create function public.legal_documents_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- A published version is immutable (what people accepted must stay exactly as it was).
  if old.status = 'published' then raise exception 'append_only' using errcode = '42501'; end if;
  return new;
end $$;
create trigger legal_documents_guard before update on public.legal_documents for each row execute function public.legal_documents_guard();

create table public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  org_id uuid references public.organizations(id),
  document_id uuid not null references public.legal_documents(id),
  doc_key text not null,
  version int not null,
  acceptance_type text not null check (acceptance_type in ('signup', 'store_connection', 'reacceptance', 'existing_user')),
  accepted_at timestamptz not null default now(),
  unique (user_id, document_id, org_id)
);
create index legal_acceptances_user_idx on public.legal_acceptances(user_id, doc_key);
create trigger legal_acceptances_append_only before update or delete on public.legal_acceptances
  for each row execute function public.forbid_change();

-- Latest published version per document key (either locale counts as the same version number).
create function public.legal_current() returns table (doc_key text, version int, audience text, requires_from int)
language sql stable security definer set search_path = '' as $$
  select d.doc_key, max(d.version), (array_agg(d.audience order by d.version desc))[1],
         coalesce(max(d.version) filter (where d.requires_reacceptance), min(d.version))
    from public.legal_documents d
   where d.status = 'published' and (d.effective_from is null or d.effective_from <= now())
   group by d.doc_key;
$$;

-- Documents the signed-in user still has to accept for a context: 'signup' (audience all), 'store' (store terms).
create function public.legal_pending(p_context text) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_loc text;
begin
  if v_uid is null then return '[]'; end if;
  return coalesce((select json_agg(json_build_object('doc_key', c.doc_key, 'version', c.version,
           'title_he', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'he'),
           'title_en', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'en'),
           'reacceptance', exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.doc_key = c.doc_key))
           order by (select min(sort_order) from public.legal_documents where doc_key = c.doc_key))
      from public.legal_current() c
     where ((c.audience = 'all' and p_context in ('signup', 'any'))
        or (c.audience = 'store' and p_context in ('store', 'any')
            and (p_context = 'store' or exists (select 1 from public.memberships m join public.organizations o on o.id = m.org_id
                                                 where m.user_id = v_uid and o.type = 'store' and m.role in ('owner', 'admin'))))
        or (c.audience = 'creator' and p_context in ('creator', 'any')
            and (p_context = 'creator' or exists (select 1 from public.memberships m join public.organizations o on o.id = m.org_id
                                                   where m.user_id = v_uid and o.type = 'creator' and m.role in ('owner', 'admin')))))
       and not exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.doc_key = c.doc_key and a.version >= c.requires_from)), '[]');
end $$;

create function public.accept_legal(p_doc_keys text[], p_type text, p_org uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); k text; d public.legal_documents; n int := 0;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('signup', 'store_connection', 'reacceptance', 'existing_user') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if p_org is not null and not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach k in array coalesce(p_doc_keys, '{}') loop
    select ld.* into d from public.legal_documents ld join public.legal_current() c on c.doc_key = ld.doc_key and c.version = ld.version
     where ld.doc_key = k order by (ld.locale = 'he') desc limit 1;
    continue when not found;
    insert into public.legal_acceptances(user_id, org_id, document_id, doc_key, version, acceptance_type)
    values (v_uid, p_org, d.id, d.doc_key, d.version, p_type)
    on conflict (user_id, document_id, org_id) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Server-side enforcement (no-op while no document is published).
create function public.require_legal(p_context text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if json_array_length(public.legal_pending(p_context)) > 0 then
    raise exception 'legal_acceptance_required' using errcode = '42501';
  end if;
end $$;

alter function public.create_organization(text, text, text, text, text) rename to create_organization_core;
create function public.create_organization(p_type text, p_name text, p_website_url text default null,
                                           p_ref_code text default null, p_locale text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_legal('signup');
  return public.create_organization_core(p_type, p_name, p_website_url, p_ref_code, p_locale);
end $$;

alter function public.create_store_connection(uuid, text) rename to create_store_connection_core;
create function public.create_store_connection(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_legal('store');
  return public.create_store_connection_core(p_org, p_site_url);
end $$;

-- Platform admin: add a version (draft) and publish it. Published versions can never be edited or removed.
create function public.save_legal_document(p_key text, p_locale text, p_version int, p_title text, p_body text,
                                           p_audience text, p_sort int, p_requires_reacceptance boolean,
                                           p_effective_from timestamptz, p_publish boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.legal_documents as d (doc_key, locale, version, title, body, audience, sort_order, requires_reacceptance,
                                           status, effective_from, published_at, created_by)
  values (p_key, p_locale, p_version, btrim(p_title), p_body, p_audience, coalesce(p_sort, 100), coalesce(p_requires_reacceptance, false),
          case when p_publish then 'published' else 'draft' end, p_effective_from, case when p_publish then now() end, auth.uid())
  on conflict (doc_key, locale, version) do update set title = excluded.title, body = excluded.body, audience = excluded.audience,
     sort_order = excluded.sort_order, requires_reacceptance = excluded.requires_reacceptance, status = excluded.status,
     effective_from = excluded.effective_from, published_at = excluded.published_at
  returning d.id into v_id;
  insert into public.audit_events(actor_user_id, action, target, details)
  values (auth.uid(), case when p_publish then 'legal.published' else 'legal.draft_saved' end, p_key,
          jsonb_build_object('locale', p_locale, 'version', p_version));
  return v_id;
end $$;

create function public.my_legal_acceptances() returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('doc_key', doc_key, 'version', version, 'type', acceptance_type, 'accepted_at', accepted_at)
                  order by accepted_at desc), '[]')
    from public.legal_acceptances where user_id = auth.uid();
$$;

/* ================= RLS & grants ================= */
alter table public.fee_terms enable row level security;
alter table public.legal_documents enable row level security;
alter table public.legal_acceptances enable row level security;
create policy fee_terms_read on public.fee_terms for select to authenticated using (public.is_admin(store_org_id));
create policy legal_documents_read on public.legal_documents for select to anon, authenticated using (status = 'published');
create policy legal_acceptances_read on public.legal_acceptances for select to authenticated using (user_id = auth.uid());
revoke all on public.fee_terms, public.legal_documents, public.legal_acceptances from anon, authenticated;
grant select on public.fee_terms, public.legal_acceptances to authenticated;
grant select on public.legal_documents to anon, authenticated;

/* Admin list of payment requests with VAT and delivery fields. */
create function public.admin_invoices() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'tax_approved', public.setting_bool('invoicing_tax_approved'),
    'vat_bps', public.setting_int('vat_bps'),
    'invoices', coalesce((select json_agg(x order by x.issued_at desc) from (
      select i.id, i.number, o.name as store, i.period_start, i.currency, i.fees_minor, i.vat_bps, i.vat_minor, i.credit_minor,
             i.total_minor, i.status, i.issued_at, i.delivered_at, i.delivery_method, i.delivery_reference, i.due_at,
             (i.status = 'issued' and i.due_at is not null and i.due_at < now()) as overdue, i.paid_at, i.paid_reference
        from public.invoices i join public.organizations o on o.id = i.store_org_id
       order by i.issued_at desc limit 100) x), '[]'));
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_member(uuid), public.is_admin(uuid), public.is_platform_admin(),
  public.member_applied_to(uuid), public.opportunity_store(uuid) to authenticated;
grant execute on function
  public.create_organization(text, text, text, text, text),
  public.update_organization(uuid, text, text, text, text, text),
  public.create_store_connection(uuid, text),
  public.create_proposal(uuid, int, text, text, int, int, text, uuid),
  public.accept_proposal(text, uuid),
  public.reject_proposal(text),
  public.org_dashboard(uuid),
  public.org_status(uuid),
  public.invite_team_member(uuid, text, text),
  public.accept_team_invite(text),
  public.org_members(uuid),
  public.set_member_role(uuid, uuid, text),
  public.remove_member(uuid, uuid),
  public.revoke_team_invite(uuid),
  public.save_standing_opportunity(uuid, text, text, int, int, boolean, text, uuid[]),
  public.create_campaign(uuid, text, text, int, timestamptz, timestamptz, uuid[]),
  public.set_opportunity_status(uuid, text),
  public.join_opportunity(uuid, uuid, text),
  public.decide_application(uuid, boolean),
  public.catalog(text, text, int),
  public.pending_applications(uuid),
  public.mark_notifications_read(uuid),
  public.my_wallet(),
  public.record_creator_payout(uuid, uuid, text, text, text),
  public.respond_creator_payout(uuid, boolean),
  public.payout_balances(uuid),
  public.track_event(uuid, text),
  public.admin_overview(),
  public.admin_set_setting(text, jsonb),
  public.generate_invoices(date),
  public.mark_invoice_paid(uuid, text),
  public.void_invoice(uuid),
  public.record_reward_transfer(uuid, text, text),
  public.referrer_name(text),
  public.mark_invoice_delivered(uuid, text, text, timestamptz),
  public.preview_invoices(date),
  public.set_new_store_pricing(int, int, int, text),
  public.schedule_standard_rate_change(int, timestamptz, text),
  public.respond_fee_change(uuid, boolean),
  public.set_individual_fee(uuid, int, timestamptz, timestamptz, text),
  public.store_fee_terms(uuid),
  public.legal_pending(text),
  public.accept_legal(text[], text, uuid),
  public.save_legal_document(text, text, int, text, text, text, int, boolean, timestamptz, boolean),
  public.my_legal_acceptances(),
  public.admin_invoices()
  to authenticated;
grant execute on function public.get_public_proposal(text), public.resolve_partner_link(text),
                          public.get_team_invite(text), public.public_catalog_preview()
  to anon, authenticated;
grant execute on function public.ingest_order_event(uuid, jsonb), public.plugin_sync(uuid, text),
                          public.plugin_sync_products(uuid, jsonb, timestamptz),
                          public.approve_matured_commissions(), public.platform_fee_report(timestamptz, timestamptz),
                          public.run_invoice_generation(date)
  to service_role;

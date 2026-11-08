-- LINKUP Phase 1 — business functions (single source of truth for money logic).
-- All SECURITY DEFINER with empty search_path; every reference is schema-qualified.

/* ---------------- Utilities ---------------- */
create function public.setting_int(p_key text) returns int
language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::int from public.app_settings where key = p_key;
$$;

create function public.setting_bool(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::boolean from public.app_settings where key = p_key;
$$;

-- gen_random_uuid() is a CSPRNG (122 random bits per uuid).
create function public.random_token(p_len int) returns text
language sql volatile set search_path = '' as $$
  select substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
             || replace(gen_random_uuid()::text, '-', ''), 1, p_len);
$$;

create function public.normalize_url(p_url text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_url, ''));
begin
  if v = '' then return null; end if;
  if v !~* '^https?://' then v := 'https://' || v; end if;
  v := regexp_replace(v, '/+$', '');
  if char_length(v) > 200 or v !~* '^https?://[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?(/[^\s]*)?$' then
    raise exception 'invalid_url' using errcode = '22023';
  end if;
  return v;
end $$;

-- Commission base after refunds/cancellation. Single formula used everywhere.
create function public.effective_base_minor(p_status text, p_total bigint, p_base bigint, p_refunded bigint) returns bigint
language sql immutable set search_path = '' as $$
  select case
    when p_status not in ('processing', 'completed', 'on-hold') or p_total <= 0 then 0::bigint
    else round(p_base::numeric * greatest(0, p_total - p_refunded) / p_total)::bigint
  end;
$$;

create function public.generate_partner_code(p_creator uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare v_base text; v_code text; i int := 0;
begin
  select upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 8)) into v_base
  from public.organizations where id = p_creator;
  if v_base is null or char_length(v_base) < 3 then v_base := 'LINK'; end if;
  loop
    v_code := v_base || upper(public.random_token(4));
    exit when not exists (select 1 from public.partner_codes where lower(code) = lower(v_code));
    i := i + 1;
    if i > 20 then raise exception 'code_generation_failed'; end if;
  end loop;
  return v_code;
end $$;

/* ---------------- Accounts ---------------- */
create function public.create_organization(p_type text, p_name text, p_website_url text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_slug text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('store', 'creator', 'agency') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'invalid_name' using errcode = '22023'; end if;
  if (select count(*) from public.memberships where user_id = v_uid) >= 10 then
    raise exception 'too_many_orgs' using errcode = '54000';
  end if;
  v_slug := btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), '-');
  if v_slug = '' then v_slug := p_type; end if;
  v_slug := left(v_slug, 40) || '-' || public.random_token(6);

  insert into public.organizations(type, name, slug, website_url)
  values (p_type, btrim(p_name), v_slug, public.normalize_url(p_website_url))
  returning id into v_id;
  insert into public.memberships(user_id, org_id, role) values (v_uid, v_id, 'owner');
  insert into public.audit_events(actor_user_id, org_id, action, target) values (v_uid, v_id, 'org.created', p_type);
  return v_id;
end $$;

/* ---------------- Store connection ---------------- */
-- Returns a one-time connection key "lk_<connection hex>_<secret>". Calling again rotates the secret.
create function public.create_store_connection(p_org uuid, p_site_url text)
returns json
language plpgsql security definer set search_path = '' as $$
declare v_url text := public.normalize_url(p_site_url); v_id uuid; v_secret text := public.random_token(64);
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then
    raise exception 'not_a_store' using errcode = '22023';
  end if;
  if v_url is null then raise exception 'invalid_url' using errcode = '22023'; end if;

  insert into public.store_connections as sc (org_id, site_url) values (p_org, v_url)
  on conflict (org_id, site_url) do update
    set status = case when sc.status = 'disconnected' then 'pending' else sc.status end
  returning sc.id into v_id;

  insert into public.store_connection_secrets as s (connection_id, secret) values (v_id, v_secret)
  on conflict (connection_id) do update set secret = excluded.secret, rotated_at = now();

  -- Founders pricing clock starts at activation (first connection).
  update public.organizations
     set website_url = coalesce(website_url, v_url),
         founders_until = coalesce(founders_until,
           case when public.setting_bool('founders_open')
                then now() + make_interval(months => public.setting_int('founders_months')) end)
   where id = p_org;

  insert into public.audit_events(actor_user_id, org_id, action, target)
  values (auth.uid(), p_org, 'store_connection.key_issued', v_id::text);

  return json_build_object('connection_id', v_id,
                           'connection_key', 'lk_' || replace(v_id::text, '-', '') || '_' || v_secret,
                           'site_url', v_url);
end $$;

/* ---------------- Proposals ---------------- */
create function public.create_proposal(
  p_from_org uuid,
  p_commission_bps int default null,
  p_invitee_name text default null,
  p_invitee_contact text default null,
  p_coupon_discount_pct int default null,
  p_attribution_days int default null,
  p_target_site_url text default null,
  p_source_proposal uuid default null
) returns json
language plpgsql security definer set search_path = '' as $$
declare v_org public.organizations; v_dir text; v_token text := public.random_token(24); v_id uuid;
        v_src public.proposals; v_bps int;
begin
  if not public.is_admin(p_from_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_org from public.organizations where id = p_from_org;
  v_dir := case v_org.type when 'store' then 'store_to_creator' when 'creator' then 'creator_to_store' end;
  if v_dir is null then raise exception 'unsupported_org_type' using errcode = '22023'; end if;

  if (select count(*) from public.proposals
      where from_org_id = p_from_org and created_at > now() - interval '1 day')
     >= public.setting_int('max_proposals_per_day') then
    raise exception 'rate_limited' using errcode = '54000';
  end if;

  if p_source_proposal is not null then
    select * into v_src from public.proposals where id = p_source_proposal and from_org_id = p_from_org;
    if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;

  v_bps := coalesce(p_commission_bps, v_src.commission_bps, v_org.default_commission_bps);

  insert into public.proposals(token, from_org_id, direction, invitee_name, invitee_contact, target_site_url,
                               commission_bps, coupon_discount_pct, attribution_days, source_proposal_id, created_by)
  values (v_token, p_from_org, v_dir, nullif(btrim(p_invitee_name), ''), nullif(btrim(p_invitee_contact), ''),
          public.normalize_url(p_target_site_url), v_bps,
          coalesce(p_coupon_discount_pct, v_src.coupon_discount_pct, 10),
          coalesce(p_attribution_days, v_src.attribution_days, public.setting_int('default_attribution_days')),
          p_source_proposal, auth.uid())
  returning id into v_id;

  if v_org.type = 'store' then
    update public.organizations set default_commission_bps = v_bps where id = p_from_org;
  end if;
  insert into public.funnel_events(event, proposal_id, org_id) values ('invite_sent', v_id, p_from_org);
  return json_build_object('proposal_id', v_id, 'token', v_token, 'direction', v_dir);
end $$;

-- Public (anon) view of an offer — shown before registration. Never exposes contact details.
create function public.get_public_proposal(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare p public.proposals; o public.organizations; v_status text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{24}$' then return null; end if;
  select * into p from public.proposals where token = p_token;
  if not found then return null; end if;
  select * into o from public.organizations where id = p.from_org_id;
  v_status := case when p.status in ('sent', 'opened') and p.expires_at < now() then 'expired' else p.status end;
  if p.status = 'sent' and v_status = 'sent' then
    update public.proposals set status = 'opened', opened_at = now() where id = p.id and status = 'sent';
    insert into public.funnel_events(event, proposal_id, org_id) values ('invite_opened', p.id, p.from_org_id);
    v_status := 'opened';
  end if;
  return json_build_object(
    'direction', p.direction, 'from_name', o.name, 'from_type', o.type, 'from_website', o.website_url,
    'invitee_name', p.invitee_name, 'target_site_url', p.target_site_url,
    'commission_bps', p.commission_bps, 'coupon_discount_pct', p.coupon_discount_pct,
    'attribution_days', p.attribution_days, 'status', v_status);
end $$;

create function public.accept_proposal(p_token text, p_org uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare p public.proposals; v_org public.organizations; v_store uuid; v_creator uuid;
        v_ag uuid; v_ver int; v_code text; v_new boolean := false;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.proposals where token = p_token for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p.status not in ('sent', 'opened') then raise exception 'proposal_closed' using errcode = '22023'; end if;
  if p.expires_at < now() then raise exception 'proposal_expired' using errcode = '22023'; end if;
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_org from public.organizations where id = p_org;
  if p.direction = 'store_to_creator' then
    if v_org.type <> 'creator' then raise exception 'wrong_org_type' using errcode = '22023'; end if;
    v_store := p.from_org_id; v_creator := p_org;
  else
    if v_org.type <> 'store' then raise exception 'wrong_org_type' using errcode = '22023'; end if;
    v_store := p_org; v_creator := p.from_org_id;
  end if;

  select id into v_ag from public.agreements
   where store_org_id = v_store and creator_org_id = v_creator and status = 'active' for update;
  if v_ag is null then
    insert into public.agreements(store_org_id, creator_org_id, proposal_id)
    values (v_store, v_creator, p.id) returning id into v_ag;
    v_ver := 1; v_new := true;
  else
    -- Existing partners: new terms apply prospectively as a new version.
    select max(version) + 1 into v_ver from public.agreement_versions where agreement_id = v_ag;
  end if;

  insert into public.agreement_versions(agreement_id, version, commission_bps, coupon_discount_pct, attribution_days,
                                        refund_hold_days, proposal_id, accepted_by_store_at, accepted_by_creator_at)
  values (v_ag, v_ver, p.commission_bps, p.coupon_discount_pct, p.attribution_days,
          public.setting_int('refund_hold_days'), p.id,
          case when p.direction = 'store_to_creator' then p.created_at else now() end,
          case when p.direction = 'store_to_creator' then now() else p.created_at end);

  if v_new then
    v_code := public.generate_partner_code(v_creator);
    insert into public.partner_codes(agreement_id, code) values (v_ag, v_code);
  else
    select code into v_code from public.partner_codes
     where agreement_id = v_ag and active order by created_at desc limit 1;
  end if;

  update public.proposals set status = 'accepted', accepted_org_id = p_org, decided_at = now() where id = p.id;
  insert into public.funnel_events(event, proposal_id, org_id) values ('proposal_accepted', p.id, p.from_org_id);

  -- Viral attribution: the accepting org joined LINKUP because of this proposal.
  if v_org.created_at >= p.created_at then
    insert into public.referrals(referrer_org_id, referred_org_id, source, proposal_id, reward_bps, reward_until)
    values (p.from_org_id, p_org, 'proposal', p.id, public.setting_int('referral_reward_bps'),
            now() + make_interval(months => public.setting_int('referral_months')))
    on conflict (referred_org_id) do nothing;
  end if;

  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'proposal.accepted', p.id::text, json_build_object('agreement_id', v_ag, 'version', v_ver)::jsonb);

  return json_build_object('agreement_id', v_ag, 'version', v_ver, 'code', v_code,
                           'store_org_id', v_store, 'creator_org_id', v_creator);
end $$;

create function public.reject_proposal(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_from uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.proposals set status = 'rejected', decided_at = now()
   where token = p_token and status in ('sent', 'opened') returning id, from_org_id into v_id, v_from;
  if v_id is not null then
    insert into public.funnel_events(event, proposal_id, org_id) values ('proposal_rejected', v_id, v_from);
  end if;
end $$;

-- Public redirect helper for /r/<code>. Read-only.
create function public.resolve_partner_link(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('code', c.code,
                           'url', coalesce((select sc.site_url from public.store_connections sc
                                            where sc.org_id = a.store_org_id and sc.status <> 'disconnected'
                                            order by sc.created_at desc limit 1), o.website_url))
  from public.partner_codes c
  join public.agreements a on a.id = c.agreement_id
  join public.organizations o on o.id = a.store_org_id
  where p_code ~ '^[A-Za-z0-9]{4,16}$' and lower(c.code) = lower(p_code) and c.active and a.status = 'active';
$$;

/* ---------------- Plugin sync (service role only) ---------------- */
create function public.plugin_sync(p_connection uuid, p_plugin_version text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_was text;
begin
  select org_id, status into v_org, v_was from public.store_connections where id = p_connection for update;
  if v_org is null then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_was = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;
  update public.store_connections
     set status = 'connected', last_sync_at = now(), plugin_version = left(p_plugin_version, 20)
   where id = p_connection;
  if v_was = 'pending' then
    insert into public.funnel_events(event, org_id) values ('store_connected', v_org);
  end if;
  return json_build_object(
    'server_time', now(),
    'coupons', coalesce((
      select json_agg(json_build_object('code', c.code, 'discount_pct', v.coupon_discount_pct,
                                        'active', c.active and a.status = 'active') order by c.created_at)
      from public.partner_codes c
      join public.agreements a on a.id = c.agreement_id
      join lateral (select coupon_discount_pct from public.agreement_versions
                    where agreement_id = a.id order by version desc limit 1) v on true
      where a.store_org_id = v_org), '[]'::json));
end $$;

/* ---------------- Ledger settlement helper ---------------- */
-- Brings a party's ledger total for an attribution to p_target by appending one compensating entry.
-- Idempotent per (event, role): re-processing the same event writes nothing new.
create function public.ledger_settle(p_attr public.attributions, p_role text, p_party uuid, p_target bigint,
                                     p_currency text, p_event uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_cur bigint; v_any boolean; v_diff bigint;
begin
  select coalesce(sum(amount_minor), 0), count(*) > 0 into v_cur, v_any
    from public.commission_ledger where attribution_id = p_attr.id and party_role = p_role;
  v_diff := greatest(p_target, 0) - v_cur;
  if v_diff = 0 then return 0; end if;
  insert into public.commission_ledger(attribution_id, store_org_id, party_role, party_org_id, entry_type,
                                       amount_minor, currency, idempotency_key, source_event_id)
  values (p_attr.id, p_attr.store_org_id, p_role, p_party,
          case when not v_any then 'accrual' when v_diff < 0 then 'reversal' else 'adjustment' end,
          v_diff, p_currency, 'evt:' || p_event::text || ':' || p_role, p_event)
  on conflict (idempotency_key) do nothing;
  return v_diff;
end $$;

/* ---------------- Order ingestion (service role only) ---------------- */
create function public.ingest_order_event(p_connection uuid, p_event jsonb) returns json
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
  v_base := greatest(0, v_total - v_tax - v_ship - v_ship_tax);
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

/* ---------------- Approval (service role / cron) ---------------- */
create function public.approve_matured_commissions() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.commission_ledger l set state = 'approved', approved_at = now()
    from public.attributions a, public.orders o, public.agreement_versions v
   where l.state = 'pending' and a.id = l.attribution_id and o.id = a.order_id and v.id = a.agreement_version_id
     and o.status = 'completed' and o.completed_at is not null
     and o.completed_at + make_interval(days => v.refund_hold_days) <= now();
  get diagnostics n = row_count;
  return n;
end $$;

/* ---------------- Dashboards ---------------- */
create function public.org_dashboard(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_org public.organizations; v_month timestamptz := date_trunc('month', now()); v_cur text;
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_org from public.organizations where id = p_org;

  if v_org.type = 'store' then
    select coalesce((select currency from public.orders where store_org_id = p_org order by created_at desc limit 1), 'ILS') into v_cur;
    return json_build_object(
      'type', 'store', 'name', v_org.name, 'currency', v_cur,
      'default_commission_bps', v_org.default_commission_bps,
      'fee_bps', coalesce(v_org.platform_fee_bps, case when v_org.founders_until > now()
                   then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end),
      'founders_until', v_org.founders_until,
      'month_sales_minor', (select coalesce(sum(public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor)), 0)
                              from public.attributions a join public.orders o on o.id = a.order_id
                             where a.store_org_id = p_org and o.order_created_at >= v_month and o.currency = v_cur),
      'pending_commissions_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                    where store_org_id = p_org and party_role in ('creator', 'agency') and state = 'pending' and currency = v_cur),
      'approved_commissions_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                    where store_org_id = p_org and party_role in ('creator', 'agency') and state = 'approved' and currency = v_cur),
      'month_platform_fee_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                   where store_org_id = p_org and party_role = 'platform' and created_at >= v_month and currency = v_cur),
      'active_partners', (select count(*) from public.agreements where store_org_id = p_org and status = 'active'),
      'connection', (select json_build_object('status', status, 'site_url', site_url, 'last_sync_at', last_sync_at)
                       from public.store_connections where org_id = p_org order by created_at desc limit 1),
      'partners', coalesce((select json_agg(x order by x.created_at desc) from (
          select a.created_at, c.name, pc.code,
                 (select commission_bps from public.agreement_versions where agreement_id = a.id order by version desc limit 1) as commission_bps
            from public.agreements a join public.organizations c on c.id = a.creator_org_id
            left join public.partner_codes pc on pc.agreement_id = a.id and pc.active
           where a.store_org_id = p_org and a.status = 'active') x), '[]'),
      'recent_sales', coalesce((select json_agg(x order by x.order_created_at desc) from (
          select o.external_order_id, o.order_created_at, o.status, c.name as partner, a.method, a.self_referral_suspected,
                 public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor) as base_minor,
                 (select coalesce(sum(amount_minor), 0) from public.commission_ledger l
                   where l.attribution_id = a.id and l.party_role in ('creator', 'agency')) as commission_minor
            from public.attributions a join public.orders o on o.id = a.order_id
            join public.organizations c on c.id = a.creator_org_id
           where a.store_org_id = p_org order by o.order_created_at desc limit 10) x), '[]'),
      'proposals', coalesce((select json_agg(x order by x.created_at desc) from (
          select token, invitee_name, status, commission_bps, created_at from public.proposals
           where from_org_id = p_org order by created_at desc limit 10) x), '[]'));
  elsif v_org.type = 'creator' then
    return json_build_object(
      'type', 'creator', 'name', v_org.name, 'currency', 'ILS',
      'month_earnings_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                               where party_org_id = p_org and created_at >= v_month),
      'pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_org_id = p_org and state = 'pending'),
      'approved_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_org_id = p_org and state = 'approved'),
      'active_stores', (select count(*) from public.agreements where creator_org_id = p_org and status = 'active'),
      'partnerships', coalesce((select json_agg(x order by x.created_at desc) from (
          select a.created_at, s.name as store_name, s.website_url, pc.code, v.commission_bps, v.coupon_discount_pct,
                 exists (select 1 from public.store_connections sc where sc.org_id = s.id and sc.status = 'connected') as store_connected
            from public.agreements a join public.organizations s on s.id = a.store_org_id
            join lateral (select commission_bps, coupon_discount_pct from public.agreement_versions
                          where agreement_id = a.id order by version desc limit 1) v on true
            left join public.partner_codes pc on pc.agreement_id = a.id and pc.active
           where a.creator_org_id = p_org and a.status = 'active') x), '[]'),
      'recent_sales', coalesce((select json_agg(x order by x.order_created_at desc) from (
          select o.order_created_at, s.name as store_name, a.method,
                 (select coalesce(sum(amount_minor), 0) from public.commission_ledger l
                   where l.attribution_id = a.id and l.party_org_id = p_org) as commission_minor
            from public.attributions a join public.orders o on o.id = a.order_id
            join public.organizations s on s.id = a.store_org_id
           where a.creator_org_id = p_org order by o.order_created_at desc limit 10) x), '[]'),
      'proposals', coalesce((select json_agg(x order by x.created_at desc) from (
          select token, invitee_name, status, commission_bps, created_at from public.proposals
           where from_org_id = p_org order by created_at desc limit 10) x), '[]'));
  else
    return json_build_object('type', v_org.type, 'name', v_org.name);
  end if;
end $$;

/* ---------------- Manual billing report (service role) ---------------- */
create function public.platform_fee_report(p_from timestamptz, p_to timestamptz) returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.store_name), '[]') from (
    select o.name as store_name, o.id as store_org_id, l.currency, sum(l.amount_minor) as fee_minor,
           (select r.referrer_org_id from public.referrals r where r.referred_org_id = o.id and r.reward_until > p_from) as referrer_org_id,
           (select r.reward_bps from public.referrals r where r.referred_org_id = o.id and r.reward_until > p_from) as referral_reward_bps
      from public.commission_ledger l join public.organizations o on o.id = l.store_org_id
     where l.party_role = 'platform' and l.created_at >= p_from and l.created_at < p_to
     group by o.id, o.name, l.currency) x;
$$;

/* ---------------- Execute grants ---------------- */
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_member(uuid), public.is_admin(uuid) to authenticated;
grant execute on function public.create_organization(text, text, text),
                          public.create_store_connection(uuid, text),
                          public.create_proposal(uuid, int, text, text, int, int, text, uuid),
                          public.accept_proposal(text, uuid),
                          public.reject_proposal(text),
                          public.org_dashboard(uuid)
  to authenticated;
grant execute on function public.get_public_proposal(text), public.resolve_partner_link(text) to anon, authenticated;
grant execute on function public.ingest_order_event(uuid, jsonb), public.plugin_sync(uuid, text),
                          public.approve_matured_commissions(), public.platform_fee_report(timestamptz, timestamptz)
  to service_role;

-- Universal Connect, stage 1–3: one connection layer for every platform.
--
-- * store_connections.platform / method accept the new kinds. Existing rows (WooCommerce plugin / API) are unchanged.
--     platform: woocommerce | shopify | wix | custom | manual
--     method:   plugin | api (WooCommerce REST) | app (Shopify/Wix, later) | signed_api (custom sites) | manual
-- * Custom sites ("custom" + "signed_api"): the same signed endpoint and the same order ingestion the WooCommerce
--   plugin already uses (HMAC per connection, unique event ids, refunds/cancellations, refund window).
--   A signature proves WHO sent the report, not that the sale really happened – shown that way in the app.
-- * Manual coupon mode ("manual"): the store reports sales per order id (with its partner coupon), cancellations and
--   refunds inside LINKUP. Goes through the same ingestion, labelled "reported by the store".
-- * Sale claims: a creator can report a sale that is missing or wrong; the store answers. History is kept.
-- * Nothing here creates a commission from a tracking event alone; commissions still come only from order events.
-- No change to fees, agreements, entitlements, existing connections or data. No DROP of data or policies
-- (two CHECK constraints are replaced by wider ones).

alter table public.store_connections drop constraint if exists store_connections_platform_check;
alter table public.store_connections add constraint store_connections_platform_check
  check (platform in ('woocommerce', 'shopify', 'wix', 'custom', 'manual'));
alter table public.store_connections drop constraint if exists store_connections_method_check;
alter table public.store_connections add constraint store_connections_method_check
  check (method in ('plugin', 'api', 'app', 'signed_api', 'manual'));

/* ---------- How a store's sales reach LINKUP (shown to creators; not sensitive) ---------- */
-- automatic = WooCommerce plugin / REST or a platform app; store_api = the store's own system via signed API;
-- manual = reported by hand in LINKUP; none = no working connection.
create or replace function public.tracking_mode(p_store uuid) returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((
    select case when c.method = 'manual' then 'manual' when c.method = 'signed_api' then 'store_api' else 'automatic' end
      from public.store_connections c where c.org_id = p_store and c.status = 'connected'
     order by case when c.method in ('plugin', 'api', 'app') then 0 when c.method = 'signed_api' then 1 else 2 end, c.created_at desc limit 1), 'none');
$$;
revoke all on function public.tracking_mode(uuid) from public, anon;
grant execute on function public.tracking_mode(uuid) to authenticated;

create or replace function public.store_tracking_modes(p_stores uuid[]) returns json
language sql stable security definer set search_path to '' as $$
  select coalesce(json_object_agg(s, public.tracking_mode(s)), '{}')
    from unnest(coalesce(p_stores[1:200], '{}')) s where auth.uid() is not null;
$$;
revoke all on function public.store_tracking_modes(uuid[]) from public, anon;
grant execute on function public.store_tracking_modes(uuid[]) to authenticated;

/* ---------- Create a custom-site (API) or manual connection ---------- */
create or replace function public.create_platform_connection(p_org uuid, p_site_url text, p_kind text) returns json
language plpgsql security definer set search_path to '' as $$
declare v_url text := public.normalize_url(p_site_url); v_id uuid; v_secret text := public.random_token(64);
        v_platform text; v_method text; v_cur public.store_connections;
begin
  perform public.require_legal('store');
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if v_url is null then raise exception 'invalid_url' using errcode = '22023'; end if;
  if p_kind = 'custom' then v_platform := 'custom'; v_method := 'signed_api';
  elsif p_kind = 'manual' then v_platform := 'manual'; v_method := 'manual';
  else raise exception 'invalid_input' using errcode = '22023'; end if;

  select * into v_cur from public.store_connections where org_id = p_org and site_url = v_url for update;
  -- Never take over a working automatic connection (e.g. a connected WooCommerce store).
  if v_cur.id is not null and v_cur.status = 'connected' and v_cur.method in ('plugin', 'api', 'app') then
    raise exception 'already_connected' using errcode = '22023';
  end if;

  insert into public.store_connections as sc (org_id, site_url, platform, method, status)
  values (p_org, v_url, v_platform, v_method, case when p_kind = 'manual' then 'connected' else 'pending' end)
  on conflict (org_id, site_url) do update
    set platform = excluded.platform, method = excluded.method,
        status = case when p_kind = 'manual' then 'connected'
                      when sc.status = 'connected' and sc.method = 'signed_api' then 'connected' else 'pending' end,
        last_error = null, last_error_at = null
  returning sc.id into v_id;

  if p_kind = 'custom' then
    insert into public.store_connection_secrets as s (connection_id, secret) values (v_id, v_secret)
    on conflict (connection_id) do update set secret = excluded.secret, rotated_at = now();
  else
    delete from public.store_connection_secrets where connection_id = v_id;   -- a manual connection takes no signed calls
  end if;

  -- Same activation rule as the plugin key (founders pricing clock starts at the first connection).
  update public.organizations
     set website_url = coalesce(website_url, v_url),
         founders_until = coalesce(founders_until,
           case when public.setting_bool('founders_open')
                then now() + make_interval(months => public.setting_int('founders_months')) end)
   where id = p_org;
  if p_kind = 'manual' and v_cur.id is null then
    insert into public.funnel_events(event, org_id) values ('store_connected', p_org);
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'store_connection.' || p_kind || '_created', v_id::text, jsonb_build_object('site', v_url));

  return json_build_object('connection_id', v_id, 'site_url', v_url, 'kind', p_kind,
    'connection_key', case when p_kind = 'custom' then 'lk_' || replace(v_id::text, '-', '') || '_' || v_secret end);
end $$;
revoke all on function public.create_platform_connection(uuid, text, text) from public, anon;
grant execute on function public.create_platform_connection(uuid, text, text) to authenticated;

-- A plugin key issued for the same address turns that connection back into a WooCommerce plugin connection.
create or replace function public.create_store_connection(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
declare r json;
begin
  perform public.require_legal('store');
  r := public.create_store_connection_core(p_org, p_site_url);
  update public.store_connections set platform = 'woocommerce', method = 'plugin', status = 'pending'
   where id = (r ->> 'connection_id')::uuid and platform in ('custom', 'manual');
  return r;
end $$;

/* ---------- Manual coupon mode: the store reports sales per order ---------- */
create or replace function public.manual_connection(p_org uuid) returns uuid
language sql stable security definer set search_path to '' as $$
  select id from public.store_connections where org_id = p_org and method = 'manual' and status = 'connected'
   order by created_at desc limit 1;
$$;
revoke all on function public.manual_connection(uuid) from public, anon, authenticated;

-- Shared checks + the call into the normal order ingestion. p_order is the full normalized order.
create or replace function public.manual_ingest(p_org uuid, p_order jsonb, p_action text) returns json
language plpgsql security definer set search_path to '' as $$
declare v_conn uuid := public.manual_connection(p_org); r json;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_conn is null then raise exception 'not_available' using errcode = '22023'; end if;
  if (select count(*) from public.order_events where connection_id = v_conn and received_at > now() - interval '1 day') >= 500 then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  r := public.ingest_order_event(v_conn, jsonb_build_object(
         'event_id', 'manual:' || gen_random_uuid()::text, 'type', 'order.' || p_action,
         'occurred_at', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'reported_by', auth.uid(), 'source', 'manual', 'order', p_order));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'manual_sale.' || p_action, p_order ->> 'id', jsonb_build_object('result', r));
  return r;
end $$;
revoke all on function public.manual_ingest(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.manual_report_order(p_org uuid, p_order_id text, p_order_date date, p_total_minor bigint,
                                                      p_shipping_minor bigint, p_coupon text, p_currency text default 'ILS')
returns json language plpgsql security definer set search_path to '' as $$
declare v_id text := btrim(coalesce(p_order_id, '')); v_code text := upper(btrim(coalesce(p_coupon, '')));
begin
  if v_id !~ '^[A-Za-z0-9._#/-]{1,64}$' then raise exception 'invalid_input' using errcode = '22023'; end if;
  if p_order_date is null or p_order_date > current_date or p_order_date < current_date - 400 then
    raise exception 'invalid_dates' using errcode = '22023'; end if;
  if p_total_minor is null or p_total_minor <= 0 or p_total_minor > 100000000 or coalesce(p_shipping_minor, 0) < 0
     or coalesce(p_shipping_minor, 0) > p_total_minor then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if coalesce(p_currency, '') !~ '^[A-Z]{3}$' then raise exception 'invalid_input' using errcode = '22023'; end if;
  -- Only this store's partner coupons: manual mode attributes by coupon, never by a tracking event.
  if not exists (select 1 from public.partner_codes pc join public.agreements a on a.id = pc.agreement_id
                  where lower(pc.code) = lower(v_code) and a.store_org_id = p_org) then
    raise exception 'bad_code' using errcode = '22023';
  end if;
  if exists (select 1 from public.orders o where o.connection_id = public.manual_connection(p_org) and o.external_order_id = v_id) then
    raise exception 'order_exists' using errcode = '22023';
  end if;
  return public.manual_ingest(p_org, jsonb_build_object(
    'id', v_id, 'status', 'completed', 'currency', p_currency, 'total', p_total_minor, 'tax', 0,
    'shipping', coalesce(p_shipping_minor, 0), 'shipping_tax', 0, 'coupons', jsonb_build_array(v_code),
    'ref', '', 'email_hash', '',
    -- An order reported for today is dated now; earlier days at midday (the agreement in force that day applies).
    'created_at', case when p_order_date = current_date then to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                       else p_order_date::text || 'T12:00:00Z' end,
    'refunds', '[]'::jsonb), 'reported');
end $$;

-- Cancel or refund a reported order. Re-sends the last reported order with the change (amounts stay as reported).
create or replace function public.manual_update_order(p_org uuid, p_order_id text, p_action text, p_amount_minor bigint default null)
returns json language plpgsql security definer set search_path to '' as $$
declare v_conn uuid := public.manual_connection(p_org); v_o jsonb; v_ord public.orders;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_action not in ('cancelled', 'refunded') then raise exception 'invalid_input' using errcode = '22023'; end if;
  select * into v_ord from public.orders where connection_id = v_conn and external_order_id = btrim(coalesce(p_order_id, ''));
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select payload -> 'order' into v_o from public.order_events
   where connection_id = v_conn and external_order_id = v_ord.external_order_id order by occurred_at desc, received_at desc limit 1;
  if p_action = 'cancelled' then
    v_o := jsonb_set(v_o, '{status}', '"cancelled"');
  else
    if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > v_ord.total_minor - v_ord.refunded_minor then
      raise exception 'invalid_amount' using errcode = '22023'; end if;
    v_o := jsonb_set(v_o, '{refunds}', coalesce(v_o -> 'refunds', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'id', 'r' || (jsonb_array_length(coalesce(v_o -> 'refunds', '[]'::jsonb)) + 1)::text, 'amount', p_amount_minor)));
  end if;
  return public.manual_ingest(p_org, v_o, p_action);
end $$;

-- The store's reported orders (newest first), with the commission each one created.
create or replace function public.manual_orders(p_org uuid) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.order_created_at desc) from (
    select o.external_order_id as id, o.order_created_at, o.status, o.total_minor, o.refunded_minor, o.currency,
           o.coupon_codes[1] as coupon, cr.name as creator,
           (select coalesce(sum(l.amount_minor), 0) from public.commission_ledger l
             where l.attribution_id = a.id and l.party_role = 'creator') as commission_minor
      from public.orders o
      left join public.attributions a on a.order_id = o.id
      left join public.organizations cr on cr.id = a.creator_org_id
     where o.connection_id = public.manual_connection(p_org)
     order by o.order_created_at desc limit 200) x), '[]');
end $$;
revoke all on function public.manual_report_order(uuid, text, date, bigint, bigint, text, text),
  public.manual_update_order(uuid, text, text, bigint), public.manual_orders(uuid) from public, anon;
grant execute on function public.manual_report_order(uuid, text, date, bigint, bigint, text, text),
  public.manual_update_order(uuid, text, text, bigint), public.manual_orders(uuid) to authenticated;

/* ---------- Sale claims: missing or wrong sales (any connection type) ---------- */
create table if not exists public.sale_claims (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id),
  store_org_id uuid not null references public.organizations(id),
  creator_org_id uuid not null references public.organizations(id),
  order_ref text not null check (char_length(order_ref) between 1 and 64),
  order_date date,
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  note text check (char_length(note) <= 500),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'withdrawn')),
  store_response text check (char_length(store_response) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz
);
create index if not exists sale_claims_store_idx on public.sale_claims(store_org_id, created_at desc);
create index if not exists sale_claims_creator_idx on public.sale_claims(creator_org_id, created_at desc);
alter table public.sale_claims enable row level security;
revoke all on public.sale_claims from anon, authenticated;

create or replace function public.open_sale_claim(p_agreement uuid, p_order_ref text, p_order_date date, p_amount_minor bigint, p_note text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare a public.agreements; v_id uuid;
begin
  select * into a from public.agreements where id = p_agreement;
  if not found or not public.is_admin(a.creator_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_order_ref, ''))) not between 1 and 64 then raise exception 'invalid_input' using errcode = '22023'; end if;
  if (select count(*) from public.sale_claims where creator_org_id = a.creator_org_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.sale_claims(agreement_id, store_org_id, creator_org_id, order_ref, order_date, amount_minor, note, created_by)
  values (a.id, a.store_org_id, a.creator_org_id, btrim(p_order_ref), p_order_date, p_amount_minor, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  insert into public.notifications(org_id, kind, payload)
  values (a.store_org_id, 'sale_claim_opened', jsonb_build_object('claim_id', v_id, 'order_ref', btrim(p_order_ref),
          'creator', (select name from public.organizations where id = a.creator_org_id)));
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), a.creator_org_id, 'sale_claim.opened', v_id::text);
  return v_id;
end $$;

create or replace function public.answer_sale_claim(p_claim uuid, p_status text, p_response text) returns void
language plpgsql security definer set search_path to '' as $$
declare c public.sale_claims;
begin
  select * into c from public.sale_claims where id = p_claim for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status = 'withdrawn' then
    if not public.is_admin(c.creator_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  elsif p_status in ('accepted', 'rejected') then
    if not public.is_admin(c.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
    if p_status = 'rejected' and char_length(btrim(coalesce(p_response, ''))) < 2 then raise exception 'reason_required' using errcode = '22023'; end if;
  else raise exception 'invalid_status' using errcode = '22023'; end if;
  if c.status <> 'open' then raise exception 'already_decided' using errcode = '22023'; end if;
  update public.sale_claims set status = p_status, store_response = nullif(btrim(coalesce(p_response, '')), ''),
         answered_by = auth.uid(), answered_at = now() where id = p_claim;
  if p_status <> 'withdrawn' then
    insert into public.notifications(org_id, kind, payload)
    values (c.creator_org_id, 'sale_claim_answered', jsonb_build_object('claim_id', c.id, 'order_ref', c.order_ref, 'status', p_status));
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, target)
  values (auth.uid(), case when p_status = 'withdrawn' then c.creator_org_id else c.store_org_id end, 'sale_claim.' || p_status, c.id::text);
end $$;

create or replace function public.sale_claims_for(p_org uuid) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', c.id, 'order_ref', c.order_ref, 'order_date', c.order_date,
           'amount_minor', c.amount_minor, 'note', c.note, 'status', c.status, 'store_response', c.store_response,
           'created_at', c.created_at, 'answered_at', c.answered_at,
           'store', s.name, 'creator', cr.name, 'mine_as', case when c.store_org_id = p_org then 'store' else 'creator' end)
           order by c.created_at desc)
      from public.sale_claims c join public.organizations s on s.id = c.store_org_id join public.organizations cr on cr.id = c.creator_org_id
     where c.store_org_id = p_org or c.creator_org_id = p_org), '[]');
end $$;
revoke all on function public.open_sale_claim(uuid, text, date, bigint, text), public.answer_sale_claim(uuid, text, text),
  public.sale_claims_for(uuid) from public, anon;
grant execute on function public.open_sale_claim(uuid, text, date, bigint, text), public.answer_sale_claim(uuid, text, text),
  public.sale_claims_for(uuid) to authenticated;

/* ---------- Creator view: my partner stores, how their sales are tracked ---------- */
create or replace function public.my_partner_stores(p_creator uuid) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_member(p_creator) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('agreement_id', a.id, 'store_org_id', a.store_org_id, 'store_name', s.name,
           'tracking', public.tracking_mode(a.store_org_id)) order by s.name)
      from public.agreements a join public.organizations s on s.id = a.store_org_id
     where a.creator_org_id = p_creator and a.status = 'active'), '[]');
end $$;
revoke all on function public.my_partner_stores(uuid) from public, anon;
grant execute on function public.my_partner_stores(uuid) to authenticated;

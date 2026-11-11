-- Universal Connect: one automatic connection layer for every platform (no manual sales reporting).
--
-- * store_connections.platform / method accept the new kinds. Existing rows (WooCommerce plugin / REST) are unchanged.
--     platform: woocommerce | shopify | wix | custom
--     method:   plugin | api (WooCommerce REST) | app (Shopify / Wix, when built) | signed_api (custom sites)
-- * Custom sites (custom / signed_api): the same signed endpoint and the same order ingestion the WooCommerce plugin
--   already uses (HMAC per connection, unique order ids, duplicate events ignored, refunds/cancellations, refund window).
--   A signature proves WHO sent the report, not that the sale happened – shown that way in the app.
-- * Switching connection method never loses data (same address = same connection row, same orders) and a sale reported
--   by two connections of the same store never earns two commissions (guard on attributions).
-- * Founders pricing clock: for connections created here it starts when the store is actually connected (first signed
--   call), not when a key is created. Existing behaviour of the WooCommerce key is NOT changed here.
-- * Sale claims: an exception channel for a missing or wrong sale (not a reporting path).
-- * Commissions still come only from order events; nothing here creates one from a visit or click.
-- No change to fees, agreements, entitlements, existing connections or data. No DROP of data or policies
-- (two CHECK constraints are replaced by wider ones).

alter table public.store_connections drop constraint if exists store_connections_platform_check;
alter table public.store_connections add constraint store_connections_platform_check
  check (platform in ('woocommerce', 'shopify', 'wix', 'custom'));
alter table public.store_connections drop constraint if exists store_connections_method_check;
alter table public.store_connections add constraint store_connections_method_check
  check (method in ('plugin', 'api', 'app', 'signed_api'));

/* ---------- How a store's sales reach LINKUP (shown to creators; not sensitive) ---------- */
-- automatic = WooCommerce plugin / REST or a platform app; store_api = the store's own system via signed API;
-- none = no working automatic connection (no sales tracking is shown).
create or replace function public.tracking_mode(p_store uuid) returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((
    select case when c.method = 'signed_api' then 'store_api' else 'automatic' end
      from public.store_connections c where c.org_id = p_store and c.status = 'connected'
     order by case when c.method in ('plugin', 'api', 'app') then 0 else 1 end, c.created_at desc limit 1), 'none');
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

/* ---------- Custom site: key for the developer (signed API) ---------- */
create or replace function public.create_api_connection(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
declare v_url text := public.normalize_url(p_site_url); v_id uuid; v_secret text := public.random_token(64); v_cur public.store_connections;
begin
  perform public.require_legal('store');
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if v_url is null then raise exception 'invalid_url' using errcode = '22023'; end if;
  if (select count(*) from public.audit_events where org_id = p_org and action = 'store_connection.api_key_created'
       and created_at > now() - interval '1 day') >= 20 then raise exception 'rate_limited' using errcode = '54000'; end if;

  select * into v_cur from public.store_connections where org_id = p_org and site_url = v_url for update;
  -- Never take over a working plugin / REST / app connection (e.g. a connected WooCommerce store).
  if v_cur.id is not null and v_cur.status = 'connected' and v_cur.method in ('plugin', 'api', 'app') then
    raise exception 'already_connected' using errcode = '22023';
  end if;

  -- Same address = same connection row, so orders, attributions and commissions stay attached when switching methods.
  insert into public.store_connections as sc (org_id, site_url, platform, method, status)
  values (p_org, v_url, 'custom', 'signed_api', 'pending')
  on conflict (org_id, site_url) do update
    set platform = 'custom', method = 'signed_api',
        status = case when sc.status = 'connected' and sc.method = 'signed_api' then 'connected' else 'pending' end,
        last_error = null, last_error_at = null
  returning sc.id into v_id;
  -- A new key always replaces the previous one (rotation = immediate revocation of the old key).
  insert into public.store_connection_secrets as s (connection_id, secret) values (v_id, v_secret)
  on conflict (connection_id) do update set secret = excluded.secret, rotated_at = now();

  update public.organizations set website_url = coalesce(website_url, v_url) where id = p_org;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'store_connection.api_key_created', v_id::text, jsonb_build_object('site', v_url));
  return json_build_object('connection_id', v_id, 'site_url', v_url,
    'connection_key', 'lk_' || replace(v_id::text, '-', '') || '_' || v_secret);
end $$;
revoke all on function public.create_api_connection(uuid, text) from public, anon;
grant execute on function public.create_api_connection(uuid, text) to authenticated;

-- A plugin key issued for the same address turns that connection back into a WooCommerce plugin connection
-- (same row: no order or commission data is lost; it is "connected" again only after the plugin reports).
create or replace function public.create_store_connection(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
declare r json;
begin
  perform public.require_legal('store');
  r := public.create_store_connection_core(p_org, p_site_url);
  update public.store_connections set platform = 'woocommerce', method = 'plugin', status = 'pending'
   where id = (r ->> 'connection_id')::uuid and platform = 'custom';
  return r;
end $$;

/* ---------- Founders clock for new connection kinds: starts at the first real connection ---------- */
-- Only fills founders_until when it is still empty, so stores that already have it (all WooCommerce stores today)
-- are not affected.
create or replace function public.connection_activation_trigger() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'connected' and (tg_op = 'INSERT' or old.status is distinct from 'connected') then
    update public.organizations
       set founders_until = case when public.setting_bool('founders_open')
                                 then now() + make_interval(months => public.setting_int('founders_months')) end
     where id = new.org_id and founders_until is null and public.setting_bool('founders_open');
  end if;
  return new;
end $$;
revoke all on function public.connection_activation_trigger() from public, anon, authenticated;

create or replace trigger store_connections_activation after insert or update of status on public.store_connections
  for each row execute function public.connection_activation_trigger();

/* ---------- No double commission when two connections of one store report the same sale ---------- */
-- Same store, same order id, same total, created within 2 days, already attributed through another connection
-- → the second attribution is skipped (the order is still recorded; a creator can open a claim if this was wrong).
create or replace function public.attribution_dedupe_trigger() returns trigger
language plpgsql security definer set search_path to '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = new.order_id;
  if exists (select 1 from public.orders o2 join public.attributions a2 on a2.order_id = o2.id
              where o2.store_org_id = o.store_org_id and o2.connection_id <> o.connection_id
                and o2.external_order_id = o.external_order_id and o2.total_minor = o.total_minor and o2.currency = o.currency
                and abs(extract(epoch from o2.order_created_at - o.order_created_at)) < 172800) then
    insert into public.audit_events(org_id, action, target, details)
    values (o.store_org_id, 'attribution.duplicate_skipped', o.id::text,
            jsonb_build_object('external_order_id', o.external_order_id, 'connection_id', o.connection_id));
    return null;
  end if;
  return new;
end $$;
revoke all on function public.attribution_dedupe_trigger() from public, anon, authenticated;

create or replace trigger attributions_dedupe before insert on public.attributions
  for each row execute function public.attribution_dedupe_trigger();
-- The engine's "first attributed sale" funnel marker must not be written for a skipped attribution.
create or replace function public.funnel_null_org_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.event = 'first_attributed_sale' and new.org_id is null then return null; end if;
  return new;
end $$;
revoke all on function public.funnel_null_org_guard() from public, anon, authenticated;

create or replace trigger funnel_events_null_org before insert on public.funnel_events
  for each row execute function public.funnel_null_org_guard();

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

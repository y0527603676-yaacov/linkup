-- Personal links on Shopify / Wix apps (no coupon typing needed) + periodic sync support.
--
-- * app_coupons: which partner coupon codes really exist (and are active) in the connected shop, as confirmed by the
--   platform's API during sync. Written only by the edge function (service role).
-- * resolve_partner_link: same result as before ('code', 'url') plus:
--     'platform'      – platform of the store's current connection,
--     'discount_link' – OFF by default. True only when the STORE chose "apply my creator coupons automatically through
--                       personal links" (store_link_options.auto_apply_coupon), the store is connected through the Shopify
--                       app, the creator's coupon gives a customer discount and the code is confirmed active in the shop.
--                       The /r/CODE redirect then uses Shopify's official shareable discount link. Otherwise the personal
--                       link is a plain link with no discount (attribution through LINKUP's app pixel / order data).
--                       Platform-wide kill switch: app_settings.shopify_discount_link (1 = allowed, 0 = never).
-- * store_link_options + set_link_options: the store's own choice (store admins only, audited). No UI yet.
-- * app_sync_failed: records why a scheduled sync could not reach the shop (shown to admin), without changing status.
-- No change to fees, agreements, entitlements, orders, ledger or existing connections. No DROP.

insert into public.app_settings(key, value) values ('shopify_discount_link', '1'::jsonb) on conflict (key) do nothing;

create table if not exists public.app_coupons (
  connection_id uuid not null references public.store_connections(id),
  code text not null check (code ~ '^[A-Za-z0-9]{4,16}$'),
  external_id text check (char_length(external_id) <= 200),
  active boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (connection_id, code)
);
alter table public.app_coupons enable row level security;
revoke all on public.app_coupons from anon, authenticated;

create table if not exists public.store_link_options (
  org_id uuid primary key references public.organizations(id),
  auto_apply_coupon boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.store_link_options enable row level security;
revoke all on public.store_link_options from anon, authenticated;

create or replace function public.set_link_options(p_org uuid, p_auto_apply_coupon boolean) returns json
language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  insert into public.store_link_options as o (org_id, auto_apply_coupon, updated_by) values (p_org, coalesce(p_auto_apply_coupon, false), auth.uid())
  on conflict (org_id) do update set auto_apply_coupon = excluded.auto_apply_coupon, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'link_options.updated', p_org::text, jsonb_build_object('auto_apply_coupon', coalesce(p_auto_apply_coupon, false)));
  return json_build_object('auto_apply_coupon', coalesce(p_auto_apply_coupon, false));
end $$;
create or replace function public.link_options(p_org uuid) returns json
language sql stable security definer set search_path to '' as $$
  select case when public.is_member(p_org) then json_build_object('auto_apply_coupon',
    coalesce((select auto_apply_coupon from public.store_link_options where org_id = p_org), false)) end;
$$;
revoke all on function public.set_link_options(uuid, boolean), public.link_options(uuid) from public, anon;
grant execute on function public.set_link_options(uuid, boolean), public.link_options(uuid) to authenticated;

create or replace function public.app_coupon_mark(p_connection uuid, p_code text, p_external_id text, p_active boolean) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if p_code !~ '^[A-Za-z0-9]{4,16}$' then raise exception 'invalid_input' using errcode = '22023'; end if;
  if not exists (select 1 from public.store_app_credentials where connection_id = p_connection) then
    raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.app_coupons as ac (connection_id, code, external_id, active, synced_at)
  values (p_connection, upper(p_code), left(p_external_id, 200), coalesce(p_active, false), now())
  on conflict (connection_id, code) do update
    set external_id = coalesce(excluded.external_id, ac.external_id), active = excluded.active, synced_at = now();
end $$;

create or replace function public.app_sync_failed(p_connection uuid, p_reason text) returns void
language sql security definer set search_path to '' as $$
  update public.store_connections set last_error = left('app_sync: ' || coalesce(p_reason, 'unknown'), 200), last_error_at = now()
   where id = p_connection and method = 'app';
$$;

revoke all on function public.app_coupon_mark(uuid, text, text, boolean), public.app_sync_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.app_coupon_mark(uuid, text, text, boolean), public.app_sync_failed(uuid, text) to service_role;

-- Same signature and grants as before; two keys added.
create or replace function public.resolve_partner_link(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('code', c.code,
                           'url', coalesce(sc.site_url, o.website_url),
                           'platform', sc.platform,
                           'discount_link', coalesce(sc.platform = 'shopify' and sc.method = 'app' and sc.status = 'connected'
                              and coalesce(public.setting_int('shopify_discount_link'), 0) = 1
                              and exists (select 1 from public.store_link_options lo where lo.org_id = a.store_org_id and lo.auto_apply_coupon)
                              and v.coupon_discount_pct > 0
                              and exists (select 1 from public.app_coupons ac
                                           where ac.connection_id = sc.id and ac.code = upper(c.code) and ac.active), false))
  from public.partner_codes c
  join public.agreements a on a.id = c.agreement_id
  join public.organizations o on o.id = a.store_org_id
  left join lateral (select x.id, x.site_url, x.platform, x.method, x.status from public.store_connections x
                      where x.org_id = a.store_org_id and x.status <> 'disconnected'
                      order by x.created_at desc limit 1) sc on true
  left join lateral (select av.coupon_discount_pct from public.agreement_versions av
                      where av.agreement_id = a.id order by av.version desc limit 1) v on true
  where p_code ~ '^[A-Za-z0-9]{4,16}$' and lower(c.code) = lower(p_code) and c.active and a.status = 'active';
$$;

-- Platform apps (Shopify, Wix): install with the owner's approval, then orders / cancellations / refunds arrive
-- automatically through the platform's webhooks into the existing order ingestion. No manual reporting.
--
-- * app_install_states: one-time state tying an install to the LINKUP store that started it (30 minutes, single use).
-- * store_app_credentials: the platform access token (and refresh token) in Vault, per connection; one shop/site
--   can belong to one LINKUP store only.
-- * The connection becomes "connected" only after the edge function has made a real, successful API call to the shop
--   (it then calls plugin_sync, which also returns the partner coupons to create in the shop).
-- * All functions except start_app_install are service-role only (called by the edge function).
-- No change to fees, agreements, entitlements, existing connections or data. No DROP.

create table if not exists public.app_install_states (
  state text primary key,
  org_id uuid not null references public.organizations(id),
  platform text not null check (platform in ('shopify', 'wix')),
  shop text check (char_length(shop) <= 255),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists app_install_states_org_idx on public.app_install_states(org_id, created_at);
alter table public.app_install_states enable row level security;
revoke all on public.app_install_states from anon, authenticated;

create table if not exists public.store_app_credentials (
  connection_id uuid primary key references public.store_connections(id),
  platform text not null check (platform in ('shopify', 'wix')),
  shop text not null check (char_length(shop) <= 255),        -- shop domain (Shopify) or app instance id (Wix)
  token_secret uuid not null,
  refresh_secret uuid,
  scopes text check (char_length(scopes) <= 1000),
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  unique (platform, shop)
);
alter table public.store_app_credentials enable row level security;
revoke all on public.store_app_credentials from anon, authenticated;

/* ---------- Owner starts the install (from LINKUP, signed in) ---------- */
create or replace function public.start_app_install(p_org uuid, p_platform text, p_shop text default null) returns text
language plpgsql security definer set search_path to '' as $$
declare v_shop text := lower(btrim(coalesce(p_shop, ''))); v_state text := public.random_token(40);
begin
  perform public.require_legal('store');
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if p_platform not in ('shopify', 'wix') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if p_platform = 'shopify' and v_shop !~ '^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$' then raise exception 'invalid_shop' using errcode = '22023'; end if;
  if (select count(*) from public.app_install_states where org_id = p_org and created_at > now() - interval '1 day') >= 20 then
    raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.app_install_states(state, org_id, platform, shop, created_by) values (v_state, p_org, p_platform, nullif(v_shop, ''), auth.uid());
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'app_install.started', p_platform);
  return v_state;
end $$;
revoke all on function public.start_app_install(uuid, text, text) from public, anon;
grant execute on function public.start_app_install(uuid, text, text) to authenticated;

/* ---------- Edge function: finish the install (state checked, token stored in Vault) ---------- */
create or replace function public.complete_app_install(p_state text, p_platform text, p_shop text, p_token text, p_refresh text,
                                                       p_scopes text, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
declare s public.app_install_states; v_shop text := lower(btrim(coalesce(p_shop, ''))); v_url text; v_id uuid;
        v_cur public.store_connections; v_cred public.store_app_credentials;
begin
  select * into s from public.app_install_states where state = p_state for update;
  if not found or s.used_at is not null or s.created_at < now() - interval '30 minutes' or s.platform <> p_platform then
    raise exception 'invalid_state' using errcode = '22023'; end if;
  if s.shop is not null and s.shop <> v_shop then raise exception 'invalid_state' using errcode = '22023'; end if;
  if v_shop = '' or coalesce(p_token, '') = '' then raise exception 'invalid_input' using errcode = '22023'; end if;
  update public.app_install_states set used_at = now() where state = p_state;

  -- One shop belongs to one LINKUP store.
  select * into v_cred from public.store_app_credentials where platform = p_platform and shop = v_shop;
  if v_cred.connection_id is not null and (select org_id from public.store_connections where id = v_cred.connection_id) <> s.org_id
     and v_cred.uninstalled_at is null then
    raise exception 'shop_linked_elsewhere' using errcode = '22023'; end if;

  v_url := coalesce(public.normalize_url(p_site_url), 'https://' || v_shop);
  if p_platform = 'wix' and public.normalize_url(p_site_url) is null then v_url := 'https://wix-instance-' || left(regexp_replace(v_shop, '[^a-z0-9-]', '', 'g'), 60) || '.invalid'; end if;
  select * into v_cur from public.store_connections where org_id = s.org_id and site_url = v_url for update;
  if v_cur.id is not null and v_cur.status = 'connected' and v_cur.method in ('plugin', 'api') then
    raise exception 'already_connected' using errcode = '22023'; end if;

  insert into public.store_connections as sc (org_id, site_url, platform, method, status)
  values (s.org_id, v_url, p_platform, 'app', 'pending')
  on conflict (org_id, site_url) do update
    set platform = excluded.platform, method = 'app',
        status = case when sc.status = 'connected' and sc.method = 'app' then 'connected' else 'pending' end,
        last_error = null, last_error_at = null
  returning sc.id into v_id;

  if v_cred.connection_id is not null and v_cred.connection_id = v_id then
    perform vault.update_secret(v_cred.token_secret, p_token);
    if p_refresh is not null then
      if v_cred.refresh_secret is null then
        update public.store_app_credentials set refresh_secret = vault.create_secret(p_refresh, null, 'linkup app refresh ' || v_id) where connection_id = v_id;
      else perform vault.update_secret(v_cred.refresh_secret, p_refresh); end if;
    end if;
    update public.store_app_credentials set scopes = p_scopes, installed_at = now(), uninstalled_at = null where connection_id = v_id;
  else
    if v_cred.connection_id is not null then   -- same shop re-installed by the same store on another address: move it
      update public.store_app_credentials set shop = shop || '#moved-' || extract(epoch from now())::bigint where connection_id = v_cred.connection_id;
    end if;
    insert into public.store_app_credentials(connection_id, platform, shop, token_secret, refresh_secret, scopes)
    values (v_id, p_platform, v_shop, vault.create_secret(p_token, null, 'linkup app token ' || v_id),
            case when p_refresh is not null then vault.create_secret(p_refresh, null, 'linkup app refresh ' || v_id) end, p_scopes)
    on conflict (connection_id) do update set platform = excluded.platform, shop = excluded.shop, token_secret = excluded.token_secret,
      refresh_secret = excluded.refresh_secret, scopes = excluded.scopes, installed_at = now(), uninstalled_at = null;
  end if;

  update public.organizations set website_url = coalesce(website_url, v_url) where id = s.org_id;
  insert into public.audit_events(org_id, action, target, details)
  values (s.org_id, 'app_install.completed', v_id::text, jsonb_build_object('platform', p_platform, 'shop', v_shop));
  return json_build_object('connection_id', v_id, 'org_id', s.org_id, 'site_url', v_url);
end $$;

create or replace function public.app_credentials(p_connection uuid) returns json
language sql stable security definer set search_path to '' as $$
  select json_build_object('connection_id', sc.id, 'org_id', sc.org_id, 'site_url', sc.site_url, 'status', sc.status,
    'platform', c.platform, 'shop', c.shop, 'scopes', c.scopes,
    'token', (select decrypted_secret from vault.decrypted_secrets where id = c.token_secret),
    'refresh', (select decrypted_secret from vault.decrypted_secrets where id = c.refresh_secret))
  from public.store_connections sc join public.store_app_credentials c on c.connection_id = sc.id
  where sc.id = p_connection and c.uninstalled_at is null;
$$;

create or replace function public.app_connection_by_shop(p_platform text, p_shop text) returns json
language sql stable security definer set search_path to '' as $$
  select json_build_object('connection_id', sc.id, 'org_id', sc.org_id, 'status', sc.status)
    from public.store_app_credentials c join public.store_connections sc on sc.id = c.connection_id
   where c.platform = p_platform and c.shop = lower(btrim(p_shop)) and c.uninstalled_at is null;
$$;

create or replace function public.app_save_token(p_connection uuid, p_token text) returns void
language plpgsql security definer set search_path to '' as $$
declare c public.store_app_credentials;
begin
  select * into c from public.store_app_credentials where connection_id = p_connection;
  if not found or coalesce(p_token, '') = '' then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform vault.update_secret(c.token_secret, p_token);
end $$;

-- Uninstalled in the platform (or shop data erasure request): stop tracking at once. History is kept.
create or replace function public.app_uninstalled(p_platform text, p_shop text) returns json
language plpgsql security definer set search_path to '' as $$
declare c public.store_app_credentials; v_org uuid;
begin
  select * into c from public.store_app_credentials where platform = p_platform and shop = lower(btrim(p_shop)) and uninstalled_at is null;
  if not found then return json_build_object('status', 'unknown'); end if;
  update public.store_app_credentials set uninstalled_at = now() where connection_id = c.connection_id;
  update public.store_connections set status = 'disconnected' where id = c.connection_id returning org_id into v_org;
  perform vault.update_secret(c.token_secret, 'revoked');
  if c.refresh_secret is not null then perform vault.update_secret(c.refresh_secret, 'revoked'); end if;
  insert into public.audit_events(org_id, action, target, details)
  values (v_org, 'app_install.uninstalled', c.connection_id::text, jsonb_build_object('platform', p_platform));
  return json_build_object('status', 'disconnected', 'connection_id', c.connection_id);
end $$;

create or replace function public.app_connections(p_platform text) returns setof uuid
language sql stable security definer set search_path to '' as $$
  select sc.id from public.store_connections sc join public.store_app_credentials c on c.connection_id = sc.id
   where c.platform = p_platform and c.uninstalled_at is null and sc.status <> 'disconnected';
$$;

revoke all on function public.complete_app_install(text, text, text, text, text, text, text), public.app_credentials(uuid),
  public.app_connection_by_shop(text, text), public.app_save_token(uuid, text), public.app_uninstalled(text, text),
  public.app_connections(text) from public, anon, authenticated;
grant execute on function public.complete_app_install(text, text, text, text, text, text, text), public.app_credentials(uuid),
  public.app_connection_by_shop(text, text), public.app_save_token(uuid, text), public.app_uninstalled(text, text),
  public.app_connections(text) to service_role;

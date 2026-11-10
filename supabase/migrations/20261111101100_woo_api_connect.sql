-- WooCommerce connection without a plugin (official WooCommerce "auth endpoint").
-- Flow: the store owner enters the store address → approves "LINKUP" inside WooCommerce → WooCommerce sends
-- API keys server-to-server to the woo-api Edge Function → keys are kept in Supabase Vault (encrypted),
-- never in the browser, logs or tables readable by users.
-- The Edge Function then registers signed webhooks (orders, products), keeps partner coupons in the store and
-- reconciles orders/products every 10 minutes. Order events reuse the plugin's ingest functions and the same
-- deterministic event ids, so a store that has both the plugin and the API never counts an order twice.
-- The plugin flow and existing connections are unchanged (create_store_connection_core is not used here,
-- because it rotates the plugin secret).

alter table public.store_connections add column if not exists method text not null default 'plugin';
alter table public.store_connections drop constraint if exists store_connections_method_check;
alter table public.store_connections add constraint store_connections_method_check check (method in ('plugin', 'api'));
alter table public.store_connections add column if not exists last_error text;
alter table public.store_connections add column if not exists last_error_at timestamptz;

insert into public.app_settings(key, value) values
  ('woo_api_connect_open', 'false'::jsonb),   -- until verified on a real store: platform admin and test accounts only
  ('functions_base_url', '"https://ycuvcpslvkgndytubycn.supabase.co/functions/v1"'::jsonb)
on conflict (key) do nothing;

create table if not exists public.woo_auth_requests (
  state text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  site_url text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  completed_at timestamptz,
  connection_id uuid references public.store_connections(id) on delete set null
);
alter table public.woo_auth_requests enable row level security;
revoke all on public.woo_auth_requests from anon, authenticated;
create index if not exists woo_auth_requests_org_idx on public.woo_auth_requests(org_id, created_at);

create table if not exists public.store_api_credentials (
  connection_id uuid primary key references public.store_connections(id) on delete cascade,
  key_secret uuid not null,          -- vault.secrets ids
  secret_secret uuid not null,
  webhook_secret uuid not null,
  key_permissions text,
  woo_key_id bigint,
  webhook_ids jsonb not null default '[]',
  currency text,
  synced_orders_at timestamptz,
  products_page int not null default 1,
  products_pass_started_at timestamptz,
  products_pass_done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.store_api_credentials enable row level security;
revoke all on public.store_api_credentials from anon, authenticated;

create or replace function public.woo_api_available(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.setting_bool('woo_api_connect_open') or public.is_platform_admin()
      or coalesce((select is_test from public.organizations where id = p_org), false);
$$;
revoke all on function public.woo_api_available(uuid) from public, anon;
grant execute on function public.woo_api_available(uuid) to authenticated;

-- Store admin: begin. Returns the one-time state used as WooCommerce's user_id.
create or replace function public.start_woo_api_connect(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
declare v_url text := public.normalize_url(p_site_url); v_state text := public.random_token(48);
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if not public.woo_api_available(p_org) then raise exception 'not_available' using errcode = '42501'; end if;
  perform public.require_legal('store');
  if v_url is null then raise exception 'invalid_url' using errcode = '22023'; end if;
  if v_url !~ '^https://' then raise exception 'https_required' using errcode = '22023'; end if;
  if (select count(*) from public.woo_auth_requests where org_id = p_org and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.woo_auth_requests(state, org_id, site_url, created_by) values (v_state, p_org, v_url, auth.uid());
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'store_connection.api_requested', v_url);
  return json_build_object('state', v_state, 'site_url', v_url,
                           'callback_url', public.setting_text('functions_base_url') || '/woo-api/auth-callback');
end $$;
revoke all on function public.start_woo_api_connect(uuid, text) from public, anon;
grant execute on function public.start_woo_api_connect(uuid, text) to authenticated;

-- Store admin: where does the request stand (for the return page).
create or replace function public.woo_api_request_status(p_state text) returns json
language plpgsql stable security definer set search_path to '' as $$
declare r public.woo_auth_requests; c public.store_connections;
begin
  select * into r from public.woo_auth_requests where state = p_state;
  if not found or not public.is_admin(r.org_id) then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into c from public.store_connections where id = r.connection_id;
  return json_build_object('org_id', r.org_id, 'site_url', r.site_url, 'completed', r.completed_at is not null,
    'expired', r.completed_at is null and r.expires_at < now(),
    'status', c.status, 'last_error', c.last_error, 'last_sync_at', c.last_sync_at,
    'products', (select count(*) from public.products p where p.store_org_id = r.org_id));
end $$;
revoke all on function public.woo_api_request_status(text) from public, anon;
grant execute on function public.woo_api_request_status(text) to authenticated;

-- Edge Function (service role): WooCommerce delivered the keys.
create or replace function public.woo_api_complete(p_state text, p_key text, p_secret text, p_permissions text, p_key_id bigint)
returns json language plpgsql security definer set search_path to '' as $$
declare r public.woo_auth_requests; v_id uuid; v_ws text := public.random_token(48); c public.store_api_credentials;
begin
  select * into r from public.woo_auth_requests where state = p_state for update;
  if not found or r.completed_at is not null or r.expires_at < now() then raise exception 'invalid_state' using errcode = '22023'; end if;
  if coalesce(p_permissions, '') <> 'read_write' then raise exception 'insufficient_permissions' using errcode = '22023'; end if;
  if coalesce(p_key, '') !~ '^ck_[0-9a-f]{20,64}$' or coalesce(p_secret, '') !~ '^cs_[0-9a-f]{20,64}$' then
    raise exception 'invalid_keys' using errcode = '22023';
  end if;

  insert into public.store_connections as sc (org_id, site_url, method) values (r.org_id, r.site_url, 'api')
  on conflict (org_id, site_url) do update
    set method = 'api', last_error = null, last_error_at = null,
        status = case when sc.status = 'disconnected' then 'pending' else sc.status end
  returning sc.id into v_id;

  select * into c from public.store_api_credentials where connection_id = v_id;
  if found then
    perform vault.update_secret(c.key_secret, p_key);
    perform vault.update_secret(c.secret_secret, p_secret);
    update public.store_api_credentials set key_permissions = p_permissions, woo_key_id = p_key_id, updated_at = now()
     where connection_id = v_id;
    select decrypted_secret into v_ws from vault.decrypted_secrets where id = c.webhook_secret;
  else
    insert into public.store_api_credentials(connection_id, key_secret, secret_secret, webhook_secret, key_permissions, woo_key_id)
    values (v_id, vault.create_secret(p_key, null, 'linkup woo key ' || v_id), vault.create_secret(p_secret, null, 'linkup woo secret ' || v_id),
            vault.create_secret(v_ws, null, 'linkup woo webhook ' || v_id), p_permissions, p_key_id);
  end if;

  -- Founders pricing clock starts at activation (first connection), exactly as for the plugin.
  update public.organizations
     set website_url = coalesce(website_url, r.site_url),
         founders_until = coalesce(founders_until,
           case when public.setting_bool('founders_open')
                then now() + make_interval(months => public.setting_int('founders_months')) end)
   where id = r.org_id;

  update public.woo_auth_requests set completed_at = now(), connection_id = v_id where state = p_state;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (r.created_by, r.org_id, 'store_connection.api_authorized', v_id::text);
  return json_build_object('connection_id', v_id, 'site_url', r.site_url);
end $$;

-- Edge Function (service role): credentials and sync state of one connection.
create or replace function public.woo_api_credentials(p_connection uuid) returns json
language sql stable security definer set search_path to '' as $$
  select json_build_object('connection_id', sc.id, 'org_id', sc.org_id, 'site_url', sc.site_url, 'status', sc.status,
    'key', (select decrypted_secret from vault.decrypted_secrets where id = c.key_secret),
    'secret', (select decrypted_secret from vault.decrypted_secrets where id = c.secret_secret),
    'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where id = c.webhook_secret),
    'webhook_ids', c.webhook_ids, 'currency', c.currency, 'synced_orders_at', c.synced_orders_at,
    'products_page', c.products_page, 'products_pass_started_at', c.products_pass_started_at,
    'products_pass_done_at', c.products_pass_done_at)
  from public.store_connections sc join public.store_api_credentials c on c.connection_id = sc.id
  where sc.id = p_connection;
$$;

create or replace function public.woo_api_save_state(p_connection uuid, p_state jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  update public.store_api_credentials set
    webhook_ids = coalesce(p_state -> 'webhook_ids', webhook_ids),
    currency = coalesce(p_state ->> 'currency', currency),
    synced_orders_at = coalesce((p_state ->> 'synced_orders_at')::timestamptz, synced_orders_at),
    products_page = coalesce((p_state ->> 'products_page')::int, products_page),
    products_pass_started_at = case when p_state ? 'products_pass_started_at' then (p_state ->> 'products_pass_started_at')::timestamptz else products_pass_started_at end,
    products_pass_done_at = coalesce((p_state ->> 'products_pass_done_at')::timestamptz, products_pass_done_at),
    updated_at = now()
  where connection_id = p_connection;
end $$;

-- Edge Function: record or clear a connection problem shown to the store (short, non-secret text).
create or replace function public.woo_api_report(p_connection uuid, p_error text) returns void
language sql security definer set search_path to '' as $$
  update public.store_connections set last_error = left(p_error, 80), last_error_at = case when p_error is null then null else now() end
   where id = p_connection;
$$;

-- Edge Function: connections to reconcile (disconnected ones are cleaned up once: webhooks removed, keys forgotten).
create or replace function public.woo_api_connections() returns setof uuid
language sql stable security definer set search_path to '' as $$
  select sc.id from public.store_connections sc join public.store_api_credentials c on c.connection_id = sc.id where sc.method = 'api';
$$;

create or replace function public.woo_api_forget(p_connection uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare c public.store_api_credentials;
begin
  select * into c from public.store_api_credentials where connection_id = p_connection;
  if not found then return; end if;
  delete from vault.secrets where id in (c.key_secret, c.secret_secret, c.webhook_secret);
  delete from public.store_api_credentials where connection_id = p_connection;
end $$;

-- Scheduler token (shared only between pg_cron and the Edge Function through Vault).
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'woo_api_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'woo_api_cron_token', 'woo-api scheduler');
  end if;
end $$;

create or replace function public.woo_api_check_cron(p_token text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(p_token, '') <> '' and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'woo_api_cron_token');
$$;

-- Store admin: "sync now" (at most once a minute per store).
create or replace function public.request_woo_api_sync(p_org uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare v_conn uuid;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select id into v_conn from public.store_connections where org_id = p_org and method = 'api' and status <> 'disconnected' limit 1;
  if v_conn is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.audit_events where org_id = p_org and action = 'store_connection.sync_requested' and created_at > now() - interval '1 minute') then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'store_connection.sync_requested', v_conn::text);
  perform net.http_post(
    url := public.setting_text('functions_base_url') || '/woo-api/sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-linkup-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'woo_api_cron_token')),
    body := jsonb_build_object('connection_id', v_conn));
end $$;
revoke all on function public.request_woo_api_sync(uuid) from public, anon;
grant execute on function public.request_woo_api_sync(uuid) to authenticated;

-- Service-role only.
revoke all on function public.woo_api_complete(text, text, text, text, bigint), public.woo_api_credentials(uuid),
  public.woo_api_save_state(uuid, jsonb), public.woo_api_report(uuid, text), public.woo_api_connections(),
  public.woo_api_forget(uuid), public.woo_api_check_cron(text) from public, anon, authenticated;
grant execute on function public.woo_api_complete(text, text, text, text, bigint), public.woo_api_credentials(uuid),
  public.woo_api_save_state(uuid, jsonb), public.woo_api_report(uuid, text), public.woo_api_connections(),
  public.woo_api_forget(uuid), public.woo_api_check_cron(text) to service_role;

-- Reconcile every 10 minutes (orders that a webhook missed, coupons, products).
do $$ begin
  if exists (select 1 from cron.job where jobname = 'woo-api-sync') then perform cron.unschedule('woo-api-sync'); end if;
  perform cron.schedule('woo-api-sync', '*/10 * * * *', $job$
    select net.http_post(
      url := public.setting_text('functions_base_url') || '/woo-api/sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'x-linkup-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'woo_api_cron_token')),
      body := '{}'::jsonb)
    where exists (select 1 from public.store_api_credentials);
  $job$);
end $$;

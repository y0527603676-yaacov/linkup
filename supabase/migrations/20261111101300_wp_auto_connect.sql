-- "Connect with one approval" for WordPress/WooCommerce stores, store-owner consent records, and self-service disconnect.
-- Flow: the store owner reads a short consent screen in LINKUP (what will be installed, what access is used, what the
-- store must tell its visitors) and confirms explicitly → WordPress's own approval page (Application Passwords) →
-- LINKUP's server uses that temporary access once: activates the LINKUP Connector plugin (installing it from the
-- WordPress.org directory when available), saves the store's connection key, then deletes the temporary access.
-- Nothing of that access is stored. The consent itself is kept as a permanent record.

insert into public.app_settings(key, value) values
  ('wp_auto_connect_open', 'false'::jsonb),            -- admin and test accounts only until verified on a real store
  ('install_consent_version', '"2026-11-11"'::jsonb)
on conflict (key) do nothing;

create table if not exists public.store_install_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  site_url text not null,
  consent_version text not null,
  items text[] not null,              -- each item the owner confirmed
  consent_text text not null,         -- the exact text shown (locale as displayed)
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.store_install_consents enable row level security;
revoke all on public.store_install_consents from anon, authenticated;
grant select on public.store_install_consents to authenticated;
-- Created only if missing, so the migration is safe to re-run and removes nothing.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'store_install_consents'
                 and policyname = 'store_install_consents_read') then
    create policy store_install_consents_read on public.store_install_consents for select to authenticated
      using (public.is_admin(org_id) or public.is_platform_admin());
  end if;
end $$;
create index if not exists store_install_consents_org_idx on public.store_install_consents(org_id, created_at);

create table if not exists public.wp_connect_requests (
  state text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  site_url text not null,
  created_by uuid references auth.users(id) on delete set null,
  consent_id uuid not null references public.store_install_consents(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '20 minutes',
  completed_at timestamptz,
  outcome text,
  details jsonb
);
alter table public.wp_connect_requests enable row level security;
revoke all on public.wp_connect_requests from anon, authenticated;

create or replace function public.wp_connect_available(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.setting_bool('wp_auto_connect_open') or public.is_platform_admin()
      or coalesce((select is_test from public.organizations where id = p_org), false);
$$;
revoke all on function public.wp_connect_available(uuid) from public, anon;
grant execute on function public.wp_connect_available(uuid) to authenticated;

-- Store admin: explicit consent (every required item) → one-time state for WordPress's approval page.
create or replace function public.start_wp_connect(p_org uuid, p_site_url text, p_items text[], p_consent_text text, p_user_agent text default null)
returns json language plpgsql security definer set search_path to '' as $$
declare v_url text; v_state text := public.random_token(48); v_consent uuid;
        v_test boolean := coalesce((select is_test from public.organizations where id = p_org), false);
        v_required text[] := array['install_component', 'store_access', 'visitor_notice'];
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if not public.wp_connect_available(p_org) then raise exception 'not_available' using errcode = '42501'; end if;
  perform public.require_legal('store');
  if not (coalesce(p_items, '{}') @> v_required) then raise exception 'consent_required' using errcode = '22023'; end if;
  if char_length(coalesce(p_consent_text, '')) < 40 then raise exception 'consent_required' using errcode = '22023'; end if;
  -- HTTPS only. A loopback address (isolated local test site) is accepted solely for test accounts.
  if v_test and btrim(coalesce(p_site_url, '')) ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/*$' then
    v_url := regexp_replace(btrim(p_site_url), '/+$', '');
  else
    v_url := public.normalize_url(p_site_url);
    if v_url is null then raise exception 'invalid_url' using errcode = '22023'; end if;
    if v_url !~ '^https://' then raise exception 'https_required' using errcode = '22023'; end if;
  end if;
  if (select count(*) from public.wp_connect_requests where org_id = p_org and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.store_install_consents(org_id, user_id, site_url, consent_version, items, consent_text, user_agent)
  values (p_org, auth.uid(), v_url, public.setting_text('install_consent_version'), p_items, left(p_consent_text, 4000), left(p_user_agent, 300))
  returning id into v_consent;
  insert into public.wp_connect_requests(state, org_id, site_url, created_by, consent_id) values (v_state, p_org, v_url, auth.uid(), v_consent);
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'store_connection.install_consented', v_url, jsonb_build_object('consent_id', v_consent, 'items', p_items));
  return json_build_object('state', v_state, 'site_url', v_url);
end $$;
revoke all on function public.start_wp_connect(uuid, text, text[], text, text) from public, anon;
grant execute on function public.start_wp_connect(uuid, text, text[], text, text) to authenticated;

-- Store admin (return from WordPress): is this request valid for me right now?
create or replace function public.wp_connect_check(p_state text) returns json
language plpgsql stable security definer set search_path to '' as $$
declare r public.wp_connect_requests;
begin
  select * into r from public.wp_connect_requests where state = p_state;
  if not found or not public.is_admin(r.org_id) or r.created_by is distinct from auth.uid() then raise exception 'not_found' using errcode = 'P0002'; end if;
  return json_build_object('org_id', r.org_id, 'site_url', r.site_url, 'completed', r.completed_at is not null,
                           'expired', r.expires_at < now(), 'outcome', r.outcome);
end $$;
revoke all on function public.wp_connect_check(text) from public, anon;
grant execute on function public.wp_connect_check(text) to authenticated;

create or replace function public.wp_connect_finish(p_state text, p_outcome text, p_details jsonb) returns void
language plpgsql security definer set search_path to '' as $$
declare r public.wp_connect_requests;
begin
  select * into r from public.wp_connect_requests where state = p_state for update;
  if not found or not public.is_admin(r.org_id) or r.created_by is distinct from auth.uid() then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.completed_at is not null then raise exception 'invalid_state' using errcode = '22023'; end if;
  update public.wp_connect_requests set completed_at = now(), outcome = left(p_outcome, 40), details = p_details where state = p_state;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), r.org_id, 'store_connection.auto_setup', left(p_outcome, 40), p_details);
end $$;
revoke all on function public.wp_connect_finish(text, text, jsonb) from public, anon;
grant execute on function public.wp_connect_finish(text, text, jsonb) to authenticated;

-- Store admin: disconnect. Future events are refused (the plugin stops by itself; API keys are forgotten on the next run).
-- Orders, commissions, consents and audit history are kept.
create or replace function public.disconnect_store(p_org uuid) returns int
language plpgsql security definer set search_path to '' as $$
declare v_n int;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.store_connections set status = 'disconnected' where org_id = p_org and status <> 'disconnected';
  get diagnostics v_n = row_count;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'store_connection.disconnected', p_org::text, jsonb_build_object('connections', v_n));
  return v_n;
end $$;
revoke all on function public.disconnect_store(uuid) from public, anon;
grant execute on function public.disconnect_store(uuid) to authenticated;

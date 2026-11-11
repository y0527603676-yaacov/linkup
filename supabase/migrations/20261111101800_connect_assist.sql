-- Store connection: measurement + help path (no paid service, no complex support system).
--
-- * connect_events: one line per step of the connect flow (detected platform, guide opened, help requested, failure
--   reason, connected). Only the address host is stored, no personal data. Lets LINKUP measure:
--   self-completed / needed the guide / needed assistance, unsupported platforms, top failure reasons.
-- * connect_help_requests: "help me connect" – phone call, screen share, or remote control with consent.
--   The owner leaves a phone number and a preferred time; the platform admin sees the list and closes it.
--   Passwords and payment details are never requested or stored.
-- * "connected" is logged automatically when a store connection becomes connected for the first time.
-- No change to fees, agreements, entitlements, existing connections or data. No DROP.

create table if not exists public.connect_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id),
  site_host text check (char_length(site_host) <= 255),
  event text not null check (event in ('detected', 'guide_opened', 'help_requested', 'failed', 'connected')),
  platform text check (char_length(platform) <= 32),
  reason text check (char_length(reason) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists connect_events_org_idx on public.connect_events(org_id, created_at);
create index if not exists connect_events_time_idx on public.connect_events(created_at);
alter table public.connect_events enable row level security;
revoke all on public.connect_events from anon, authenticated;

create table if not exists public.connect_help_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  site_host text check (char_length(site_host) <= 255),
  platform text check (char_length(platform) <= 32),
  channel text not null check (channel in ('phone', 'screen_share', 'remote')),
  phone text not null check (phone ~ '^\+?[0-9 ()-]{7,20}$'),
  preferred_time text check (char_length(preferred_time) <= 80),
  note text check (char_length(note) <= 500),
  consent_remote boolean not null default false,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint remote_needs_consent check (channel <> 'remote' or consent_remote)
);
create index if not exists connect_help_open_idx on public.connect_help_requests(status, created_at);
alter table public.connect_help_requests enable row level security;
revoke all on public.connect_help_requests from anon, authenticated;

create or replace function public.site_host(p_url text) returns text
language sql immutable set search_path to '' as $$
  select nullif(left(lower(regexp_replace(regexp_replace(coalesce(p_url, ''), '^[a-z]+://', '', 'i'), '[/?#:].*$', '')), 255), '');
$$;

/* ---------- Logging (store admins only; repeated views of the same result are logged once per 10 minutes) ---------- */
create or replace function public.log_connect_event(p_org uuid, p_event text, p_site text default null,
                                                    p_platform text default null, p_reason text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare v_host text := public.site_host(p_site);
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_event not in ('detected', 'guide_opened', 'failed') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if exists (select 1 from public.connect_events where org_id = p_org and event = p_event and site_host is not distinct from v_host
               and platform is not distinct from left(p_platform, 32) and reason is not distinct from left(p_reason, 64)
               and created_at > now() - interval '10 minutes') then return; end if;
  if (select count(*) from public.connect_events where org_id = p_org and created_at > now() - interval '1 day') >= 300 then return; end if;
  insert into public.connect_events(org_id, site_host, event, platform, reason)
  values (p_org, v_host, p_event, left(p_platform, 32), left(p_reason, 64));
end $$;
revoke all on function public.log_connect_event(uuid, text, text, text, text) from public, anon;
grant execute on function public.log_connect_event(uuid, text, text, text, text) to authenticated;

-- First time a connection becomes connected → "connected" (whatever the method).
create or replace function public.connect_connected_trigger() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'connected' and (tg_op = 'INSERT' or old.status is distinct from 'connected')
     and not exists (select 1 from public.connect_events where org_id = new.org_id and event = 'connected' and site_host = public.site_host(new.site_url)) then
    insert into public.connect_events(org_id, site_host, event, platform, reason)
    values (new.org_id, public.site_host(new.site_url), 'connected', new.platform, new.method);
  end if;
  return new;
end $$;
revoke all on function public.connect_connected_trigger() from public, anon, authenticated;
create or replace trigger store_connections_connect_event after insert or update of status on public.store_connections
  for each row execute function public.connect_connected_trigger();

/* ---------- Help request ---------- */
create or replace function public.request_connect_help(p_org uuid, p_channel text, p_phone text, p_preferred_time text,
                                                       p_note text, p_site text, p_platform text, p_consent_remote boolean)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_host text := public.site_host(p_site);
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_channel not in ('phone', 'screen_share', 'remote') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if p_channel = 'remote' and not coalesce(p_consent_remote, false) then raise exception 'consent_required' using errcode = '22023'; end if;
  if coalesce(p_phone, '') !~ '^\+?[0-9 ()-]{7,20}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  if exists (select 1 from public.connect_help_requests where org_id = p_org and status = 'open') then
    raise exception 'help_already_requested' using errcode = '22023'; end if;
  if (select count(*) from public.connect_help_requests where org_id = p_org and created_at > now() - interval '1 day') >= 3 then
    raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.connect_help_requests(org_id, site_host, platform, channel, phone, preferred_time, note, consent_remote, created_by)
  values (p_org, v_host, left(p_platform, 32), p_channel, btrim(p_phone), nullif(btrim(coalesce(p_preferred_time, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_consent_remote, false), auth.uid())
  returning id into v_id;
  insert into public.connect_events(org_id, site_host, event, platform, reason) values (p_org, v_host, 'help_requested', left(p_platform, 32), p_channel);
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'connect_help.requested', v_id::text);
  return v_id;
end $$;

create or replace function public.my_connect_help(p_org uuid) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select json_build_object('id', id, 'channel', channel, 'preferred_time', preferred_time, 'created_at', created_at)
            from public.connect_help_requests where org_id = p_org and status = 'open' order by created_at desc limit 1);
end $$;

-- The owner can cancel; the platform admin closes it as done. The phone number is removed when the request is closed.
create or replace function public.close_connect_help(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path to '' as $$
declare r public.connect_help_requests;
begin
  select * into r from public.connect_help_requests where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status = 'cancelled' then
    if not public.is_admin(r.org_id) and not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  elsif p_status = 'done' then
    if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  else raise exception 'invalid_status' using errcode = '22023'; end if;
  if r.status <> 'open' then raise exception 'already_decided' using errcode = '22023'; end if;
  update public.connect_help_requests set status = p_status, closed_at = now(), phone = '0000000', note = null where id = p_id;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), r.org_id, 'connect_help.' || p_status, p_id::text);
end $$;

/* ---------- Platform admin: open requests + funnel numbers ---------- */
create or replace function public.admin_connect_help() returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', h.id, 'org', o.name, 'site_host', h.site_host, 'platform', h.platform,
           'channel', h.channel, 'phone', h.phone, 'preferred_time', h.preferred_time, 'note', h.note, 'created_at', h.created_at)
           order by h.created_at)
      from public.connect_help_requests h join public.organizations o on o.id = h.org_id
     where h.status = 'open' and not o.is_test), '[]');
end $$;

-- Per store (real stores, started in the period): highest help level used before its first connection.
create or replace function public.connect_funnel_stats(p_days int default 30) returns json
language plpgsql stable security definer set search_path to '' as $$
declare v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    with ev as (
      select e.* from public.connect_events e join public.organizations o on o.id = e.org_id
       where not o.is_test and e.created_at >= v_from),
    per as (
      select org_id,
             min(created_at) filter (where event = 'connected') as connected_at,
             bool_or(event = 'detected') as started
        from ev group by org_id),
    lvl as (
      select p.org_id, p.connected_at,
             case when exists (select 1 from ev where ev.org_id = p.org_id and ev.event = 'help_requested'
                                 and (p.connected_at is null or ev.created_at <= p.connected_at)) then 'assisted'
                  when exists (select 1 from ev where ev.org_id = p.org_id and ev.event = 'guide_opened'
                                 and (p.connected_at is null or ev.created_at <= p.connected_at)) then 'guided'
                  else 'self' end as level
        from per p)
    select json_build_object(
      'days', greatest(1, least(coalesce(p_days, 30), 365)),
      'stores_started', (select count(*) from lvl),
      'connected', (select count(*) from lvl where connected_at is not null),
      'connected_self', (select count(*) from lvl where connected_at is not null and level = 'self'),
      'connected_guided', (select count(*) from lvl where connected_at is not null and level = 'guided'),
      'connected_assisted', (select count(*) from lvl where connected_at is not null and level = 'assisted'),
      'not_connected', (select count(*) from lvl where connected_at is null),
      'platforms', coalesce((select json_object_agg(platform, n) from (
          select coalesce(platform, 'unknown') platform, count(distinct org_id) n from ev where event = 'detected' group by 1) x), '{}'),
      'unsupported', coalesce((select json_object_agg(platform, n) from (
          select platform, count(distinct org_id) n from ev where event = 'detected' and platform in ('shopify', 'wix', 'magento', 'unknown', 'wordpress')
           group by 1) x), '{}'),
      'failure_reasons', coalesce((select json_agg(json_build_object('reason', reason, 'stores', n) order by n desc) from (
          select reason, count(distinct org_id) n from ev where event = 'failed' and reason is not null group by 1 order by 2 desc limit 10) x), '[]'),
      'open_help_requests', (select count(*) from public.connect_help_requests h join public.organizations o on o.id = h.org_id
                              where h.status = 'open' and not o.is_test))
  );
end $$;
revoke all on function public.request_connect_help(uuid, text, text, text, text, text, text, boolean), public.my_connect_help(uuid),
  public.close_connect_help(uuid, text), public.admin_connect_help(), public.connect_funnel_stats(int) from public, anon;
grant execute on function public.request_connect_help(uuid, text, text, text, text, text, text, boolean), public.my_connect_help(uuid),
  public.close_connect_help(uuid, text), public.admin_connect_help(), public.connect_funnel_stats(int) to authenticated;

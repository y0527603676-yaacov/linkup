-- Pilot readiness: automatic app sync, privacy (Shopify redaction + retention), failure alerts, pilot invitations.
-- No change to fees, fee terms, founders periods, agreements, entitlements, ledger, invoices or existing connections.
-- No DROP of data. Everything runs only from scheduled jobs or service-role calls.

/* ---------- 1. Scheduled sync of app connections (Shopify / Wix): coupons and agreements without reconnecting ----------
 * Same pattern as woo-api: a random token generated inside the database (Vault), never shown to anyone, shared only
 * between pg_cron and the Edge Function. */
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'apps_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'apps_cron_token', 'apps scheduler');
  end if;
end $$;

create or replace function public.apps_check_cron(p_token text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(p_token, '') <> '' and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'apps_cron_token');
$$;

/** A full successful sync of an app connection clears the problem it had recorded (so alerts resolve by themselves). */
create or replace function public.app_sync_ok(p_connection uuid) returns void
language sql security definer set search_path to '' as $$
  update public.store_connections set last_error = null, last_error_at = null
   where id = p_connection and method = 'app' and last_error is not null;
$$;

revoke all on function public.apps_check_cron(text), public.app_sync_ok(uuid) from public, anon, authenticated;
grant execute on function public.apps_check_cron(text), public.app_sync_ok(uuid) to service_role;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'apps-sync') then perform cron.unschedule('apps-sync'); end if;
  perform cron.schedule('apps-sync', '*/15 * * * *', $job$
    select net.http_post(
      url := public.setting_text('functions_base_url') || '/apps/cron/sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'x-linkup-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'apps_cron_token')),
      body := '{}'::jsonb)
    where exists (select 1 from public.store_app_credentials where uninstalled_at is null);
  $job$);
end $$;

/* ---------- 2. Privacy: Shopify's mandatory redaction requests + retention ----------
 * The only customer-related data LINKUP keeps from orders is a SHA-256 hash of the buyer's e-mail (self-referral check).
 * Redaction removes it from the order and from the stored order event; amounts, statuses and commissions stay
 * (financial records the law requires to keep). The order-event log stays append-only for everything else. */
CREATE OR REPLACE FUNCTION public.guard_order_events()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'append_only: delete on order_events' using errcode = '42501';
  end if;
  if new.connection_id <> old.connection_id or new.event_id <> old.event_id
     or (new.payload is distinct from old.payload and new.payload is distinct from (old.payload #- '{order,email_hash}'))
     or new.occurred_at <> old.occurred_at
     or new.event_type <> old.event_type or new.external_order_id <> old.external_order_id then
    raise exception 'append_only: order_events payload is immutable' using errcode = '42501';
  end if;
  return new;
end $function$;

create or replace function public.privacy_redact_customer(p_platform text, p_shop text, p_email_hash text, p_order_ids text[]) returns json
language plpgsql security definer set search_path to '' as $$
declare v_conns uuid[]; v_org uuid; n_orders int := 0; n_events int := 0;
  v_hash text := nullif(lower(btrim(coalesce(p_email_hash, ''))), ''); v_ids text[] := coalesce(p_order_ids, '{}');
begin
  select array_agg(connection_id), min(sc.org_id::text)::uuid into v_conns, v_org
    from public.store_app_credentials c join public.store_connections sc on sc.id = c.connection_id
   where c.platform = p_platform and c.shop = lower(btrim(p_shop));
  if v_conns is null then return json_build_object('status', 'unknown_shop'); end if;
  update public.orders set customer_email_hash = null
   where connection_id = any(v_conns) and customer_email_hash is not null
     and ((v_hash is not null and customer_email_hash = v_hash) or external_order_id = any(v_ids));
  get diagnostics n_orders = row_count;
  update public.order_events set payload = payload #- '{order,email_hash}'
   where connection_id = any(v_conns) and payload -> 'order' ? 'email_hash'
     and ((v_hash is not null and payload -> 'order' ->> 'email_hash' = v_hash) or external_order_id = any(v_ids));
  get diagnostics n_events = row_count;
  insert into public.audit_events(org_id, action, target, details)
  values (v_org, 'privacy.customer_redacted', p_platform, jsonb_build_object('orders', n_orders, 'events', n_events, 'order_ids', cardinality(v_ids)));
  return json_build_object('status', 'redacted', 'orders', n_orders, 'events', n_events);
end $$;

create or replace function public.privacy_redact_shop(p_platform text, p_shop text) returns json
language plpgsql security definer set search_path to '' as $$
declare c record; n_orders int := 0; n_events int := 0; k int; v_org uuid;
begin
  for c in select x.*, sc.org_id from public.store_app_credentials x join public.store_connections sc on sc.id = x.connection_id
            where x.platform = p_platform and x.shop = lower(btrim(p_shop)) loop
    v_org := c.org_id;
    update public.orders set customer_email_hash = null where connection_id = c.connection_id and customer_email_hash is not null;
    get diagnostics k = row_count; n_orders := n_orders + k;
    update public.order_events set payload = payload #- '{order,email_hash}' where connection_id = c.connection_id and payload -> 'order' ? 'email_hash';
    get diagnostics k = row_count; n_events := n_events + k;
    -- The shop's access is already revoked at uninstall; make sure no usable credential remains.
    perform vault.update_secret(c.token_secret, 'revoked');
    if c.refresh_secret is not null then perform vault.update_secret(c.refresh_secret, 'revoked'); end if;
    update public.store_app_credentials set uninstalled_at = coalesce(uninstalled_at, now()) where connection_id = c.connection_id;
    update public.store_connections set status = 'disconnected' where id = c.connection_id and status <> 'disconnected';
  end loop;
  if v_org is null then return json_build_object('status', 'unknown_shop'); end if;
  insert into public.audit_events(org_id, action, target, details)
  values (v_org, 'privacy.shop_redacted', p_platform, jsonb_build_object('orders', n_orders, 'events', n_events));
  return json_build_object('status', 'redacted', 'orders', n_orders, 'events', n_events);
end $$;

/** A customer's data request through the platform: LINKUP holds no readable customer data (only the e-mail hash);
 *  the request is recorded so the operator can answer the store within the legal deadline. */
create or replace function public.privacy_record_request(p_platform text, p_shop text, p_kind text, p_ref text) returns void
language sql security definer set search_path to '' as $$
  insert into public.audit_events(org_id, action, target, details)
  select (select sc.org_id from public.store_app_credentials c join public.store_connections sc on sc.id = c.connection_id
           where c.platform = p_platform and c.shop = lower(btrim(p_shop)) limit 1),
         'privacy.request_received', p_platform, jsonb_build_object('kind', left(p_kind, 40), 'ref', left(p_ref, 80));
$$;

/** Retention: the e-mail hash is only needed while an order can still be attributed or reversed (attribution window
 *  up to 90 days + refund hold). After 120 days it is removed from orders and order events. Financial records stay. */
create or replace function public.privacy_retention_run() returns json
language plpgsql security definer set search_path to '' as $$
declare n_orders int; n_events int;
begin
  update public.orders set customer_email_hash = null
   where customer_email_hash is not null and order_created_at < now() - interval '120 days';
  get diagnostics n_orders = row_count;
  update public.order_events set payload = payload #- '{order,email_hash}'
   where payload -> 'order' ? 'email_hash' and received_at < now() - interval '120 days';
  get diagnostics n_events = row_count;
  if n_orders + n_events > 0 then
    insert into public.audit_events(action, target, details)
    values ('privacy.retention_run', 'email_hash', jsonb_build_object('orders', n_orders, 'events', n_events));
  end if;
  return json_build_object('orders', n_orders, 'events', n_events);
end $$;

revoke all on function public.privacy_redact_customer(text, text, text, text[]), public.privacy_redact_shop(text, text),
  public.privacy_record_request(text, text, text, text), public.privacy_retention_run() from public, anon, authenticated;
grant execute on function public.privacy_redact_customer(text, text, text, text[]), public.privacy_redact_shop(text, text),
  public.privacy_record_request(text, text, text, text), public.privacy_retention_run() to service_role;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'privacy-retention') then perform cron.unschedule('privacy-retention'); end if;
  perform cron.schedule('privacy-retention', '43 3 * * *', 'select public.privacy_retention_run()');
end $$;

/* ---------- 3. Failure alerts for the operator (only problems that need a person) ----------
 * One open alert per (kind, target); a new alert notifies the platform admins once (in-app notification); the same
 * problem is not notified again within 24 hours even if it flaps; alerts resolve automatically when the cause is gone.
 * Test activities never raise alerts. */
create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('store_disconnected', 'token_refresh_failed', 'coupon_sync_failed', 'sync_failed',
                                      'order_backlog', 'store_silent')),
  target text not null check (char_length(target) <= 100),
  org_id uuid references public.organizations(id),
  detail text check (char_length(detail) <= 300),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  occurrences int not null default 1,
  notified_at timestamptz,
  resolved_at timestamptz
);
create unique index if not exists ops_alerts_open on public.ops_alerts(kind, target) where resolved_at is null;
alter table public.ops_alerts enable row level security;
revoke all on public.ops_alerts from anon, authenticated;

create or replace function public.ops_health_check() returns json
language plpgsql security definer set search_path to '' as $$
declare r record; v_new int := 0; v_resolved int := 0; v_id uuid; v_admin_org uuid; a record;
begin
  create temp table if not exists _ops_now (kind text, target text, org_id uuid, detail text) on commit drop;
  truncate _ops_now;
  -- Real stores only (test activities are excluded everywhere).
  insert into _ops_now
  select case when c.last_error ~* 'token' then 'token_refresh_failed'
              when c.last_error ~* 'coupon' then 'coupon_sync_failed' else 'sync_failed' end,
         c.id::text, c.org_id, left(c.last_error, 200)
    from public.store_connections c join public.organizations o on o.id = c.org_id
   where not o.is_test and c.status <> 'disconnected' and c.last_error is not null
     and c.last_error_at > now() - interval '7 days';
  -- A store that left while it still has active partnerships.
  insert into _ops_now
  select 'store_disconnected', c.id::text, c.org_id, c.platform || ' ' || coalesce(public.site_host(c.site_url), '')
    from public.store_connections c join public.organizations o on o.id = c.org_id
   where not o.is_test and c.status = 'disconnected'
     and not exists (select 1 from public.store_connections x where x.org_id = c.org_id and x.status = 'connected')
     and exists (select 1 from public.agreements g where g.store_org_id = c.org_id and g.status = 'active');
  -- A connected store that has not synced for a day (plugin removed, site down, blocked calls).
  insert into _ops_now
  select 'store_silent', c.id::text, c.org_id, c.platform || ' ' || coalesce(public.site_host(c.site_url), '')
    from public.store_connections c join public.organizations o on o.id = c.org_id
   where not o.is_test and c.status = 'connected' and (c.last_sync_at is null or c.last_sync_at < now() - interval '24 hours');
  -- Order events received but not processed (should never happen: processing is in the same transaction).
  insert into _ops_now
  select 'order_backlog', 'all', null, count(*) || ' events'
    from public.order_events e join public.store_connections c on c.id = e.connection_id join public.organizations o on o.id = c.org_id
   where not o.is_test and e.processed_at is null and e.received_at < now() - interval '10 minutes'
  having count(*) > 0;

  for r in select * from _ops_now loop
    update public.ops_alerts set last_seen = now(), occurrences = occurrences + 1, detail = r.detail
     where kind = r.kind and target = r.target and resolved_at is null returning id into v_id;
    if v_id is null then
      insert into public.ops_alerts(kind, target, org_id, detail) values (r.kind, r.target, r.org_id, r.detail) returning id into v_id;
      -- Notify once; not again for the same problem within 24 hours.
      if not exists (select 1 from public.ops_alerts p where p.kind = r.kind and p.target = r.target and p.id <> v_id
                       and p.notified_at > now() - interval '24 hours') then
        for a in select distinct on (pa.user_id) m.org_id from public.platform_admins pa join public.memberships m on m.user_id = pa.user_id
                  where m.role in ('owner', 'admin') order by pa.user_id, m.created_at loop
          insert into public.notifications(org_id, kind, payload)
          values (a.org_id, 'ops_alert', jsonb_build_object('alert_id', v_id, 'alert', r.kind, 'org', (select name from public.organizations where id = r.org_id), 'detail', r.detail));
        end loop;
        update public.ops_alerts set notified_at = now() where id = v_id;
      end if;
      v_new := v_new + 1;
    end if;
    v_id := null;
  end loop;
  update public.ops_alerts al set resolved_at = now()
   where al.resolved_at is null and not exists (select 1 from _ops_now n where n.kind = al.kind and n.target = al.target);
  get diagnostics v_resolved = row_count;
  return json_build_object('open', (select count(*) from public.ops_alerts where resolved_at is null), 'new', v_new, 'resolved', v_resolved);
end $$;

create or replace function public.admin_ops_alerts() returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', a.id, 'kind', a.kind, 'org', o.name, 'org_id', a.org_id, 'detail', a.detail,
            'first_seen', a.first_seen, 'last_seen', a.last_seen, 'occurrences', a.occurrences) order by a.first_seen desc)
          from public.ops_alerts a left join public.organizations o on o.id = a.org_id where a.resolved_at is null), '[]');
end $$;

revoke all on function public.ops_health_check(), public.admin_ops_alerts() from public, anon, authenticated;
grant execute on function public.ops_health_check() to service_role;
grant execute on function public.admin_ops_alerts() to authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'ops-health') then perform cron.unschedule('ops-health'); end if;
  perform cron.schedule('ops-health', '*/15 * * * *', 'select public.ops_health_check()');
end $$;

/* ---------- 4. Pilot invitations: the admin approves an address as a real pilot participant (not a test) ----------
 * Same allow-list as test sign-ups; is_test = false means the activities created by that person are real. */
create or replace function public.admin_add_signup(p_email text, p_note text, p_is_test boolean) returns void
language plpgsql security definer set search_path to '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v) > 200 then raise exception 'email' using errcode = '22023'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = v) and not exists (select 1 from public.signup_allowlist where email = v) then
    raise exception 'email_in_use' using errcode = '22023';
  end if;
  insert into public.signup_allowlist(email, note, added_by, is_test) values (v, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), coalesce(p_is_test, true))
  on conflict (email) do update set note = excluded.note, is_test = excluded.is_test
   where not exists (select 1 from auth.users u where lower(u.email) = v);   -- a registered person's side is not switched
  insert into public.audit_events(actor_user_id, action, target, details)
  values (auth.uid(), case when coalesce(p_is_test, true) then 'test_signup.added' else 'pilot_signup.added' end, v,
          jsonb_build_object('is_test', coalesce(p_is_test, true)));
end $$;
revoke all on function public.admin_add_signup(text, text, boolean) from public, anon;
grant execute on function public.admin_add_signup(text, text, boolean) to authenticated;

create or replace function public.admin_test_signups() returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('email', a.email, 'note', a.note, 'created_at', a.created_at, 'is_test', a.is_test,
            'registered', exists (select 1 from auth.users u where lower(u.email) = a.email)) order by a.created_at desc)
          from public.signup_allowlist a), '[]');
end $$;

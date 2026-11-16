-- Web Push for sale notifications (store and partner).
-- Each attributed sale already creates an in-app notification for both sides (notify_on_attribution).
-- This adds phone/desktop push delivery: browsers subscribe per user, and a new 'sale'/'first_sale' notification
-- wakes the `push` Edge Function (pg_net, asynchronous: order ingestion never waits). A 5-minute retry picks up anything missed.
-- Free standard Web Push (no paid provider). The VAPID private key lives only in Vault, read by the sender alone.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_own_read on public.push_subscriptions for select using (user_id = auth.uid());
-- Writes go through the functions below only.

alter table public.notifications add column if not exists pushed_at timestamptz;
alter table public.notifications add column if not exists push_claimed_at timestamptz;
-- Existing notifications are history: never push them retroactively.
update public.notifications set pushed_at = created_at where pushed_at is null;

create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2048
     or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 256 or coalesce(p_auth, '') = '' or length(p_auth) > 128 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, fail_count = 0;
end $$;

create function public.push_unsubscribe(p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

create function public.push_status()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('devices', (select count(*) from public.push_subscriptions where user_id = auth.uid()));
$$;

-- Scheduler token (same pattern as woo-api): stored in Vault, compared server-side.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'push_cron_token', 'push sender');
  end if;
end $$;

-- VAPID private key: stored in Vault (set out-of-band, never in the repo), read only by the push sender.
create function public.push_vapid_private()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_private';
$$;

create function public.push_check_cron(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_token, '') <> '' and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_token');
$$;

-- Claims pending sale notifications (each sale wakes the sender twice: store + partner, so claims must not overlap)
-- and returns them with their devices and the amounts to show. A claim expires after 2 minutes for retry. Service role only.
create function public.push_pending(p_limit int default 50)
returns json language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  with c as (
    select n.id from public.notifications n
     where n.pushed_at is null and n.kind in ('sale', 'first_sale') and n.created_at > now() - interval '6 hours'
       and (n.push_claimed_at is null or n.push_claimed_at < now() - interval '2 minutes')
     order by n.created_at
     limit greatest(1, least(p_limit, 200))
     for update skip locked),
  u as (update public.notifications n set push_claimed_at = now() from c where n.id = c.id returning n.id)
  select array_agg(id) into v_ids from u;
  return (select coalesce(json_agg(x), '[]'::json) from (
    select n.id, n.kind, n.org_id, o.type as org_type, coalesce(o.locale, 'he') as locale, n.payload,
           ord.currency, ord.base_minor as order_minor,
           (select l.amount_minor from public.commission_ledger l
              join public.attributions a on a.id = l.attribution_id
             where a.order_id = (n.payload ->> 'order_id')::uuid and l.party_role = 'creator' and l.entry_type = 'accrual'
             limit 1) as commission_minor,
           (select coalesce(json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json)
              from public.push_subscriptions s join public.memberships m on m.user_id = s.user_id
             where m.org_id = n.org_id) as devices
      from public.notifications n
      join public.organizations o on o.id = n.org_id
      left join public.orders ord on ord.id = (n.payload ->> 'order_id')::uuid
     where n.id = any(coalesce(v_ids, '{}'))
     order by n.created_at) x);
end $$;

create function public.push_done(p_notification_ids uuid[], p_ok text[], p_gone text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications set pushed_at = now() where id = any(p_notification_ids) and pushed_at is null;
  update public.push_subscriptions set last_ok_at = now(), fail_count = 0 where endpoint = any(coalesce(p_ok, '{}'));
  -- Endpoints the browser service reports as gone (404/410) are removed; other failures count and expire after 10.
  delete from public.push_subscriptions where endpoint = any(coalesce(p_gone, '{}'));
  delete from public.push_subscriptions where fail_count >= 10;
end $$;

create function public.push_failed(p_endpoints text[])
returns void language sql security definer set search_path = '' as $$
  update public.push_subscriptions set fail_count = fail_count + 1 where endpoint = any(coalesce(p_endpoints, '{}'));
$$;

revoke all on function public.push_vapid_private(), public.push_check_cron(text), public.push_pending(int), public.push_done(uuid[], text[], text[]),
                       public.push_failed(text[]) from public, anon, authenticated;
revoke all on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_status() from public, anon;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_status() to authenticated;
grant execute on function public.push_vapid_private(), public.push_check_cron(text), public.push_pending(int),
                          public.push_done(uuid[], text[], text[]), public.push_failed(text[]) to service_role;
grant select on public.push_subscriptions to authenticated;

-- Wake the sender right away (asynchronous HTTP; the insert never waits for it).
create function public.notifications_wake_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.memberships m join public.push_subscriptions s on s.user_id = m.user_id where m.org_id = new.org_id) then
    perform net.http_post(
      url := public.setting_text('functions_base_url') || '/push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'x-linkup-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_token')),
      body := '{}'::jsonb);
  end if;
  return null;
exception when others then
  return null; -- push is best-effort; never block a sale notification
end $$;

create trigger notifications_wake_push after insert on public.notifications
  for each row when (new.kind in ('sale', 'first_sale')) execute function public.notifications_wake_push();

select cron.schedule('push-retry', '*/5 * * * *', $$
  select net.http_post(
    url := public.setting_text('functions_base_url') || '/push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-linkup-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_token')),
    body := '{}'::jsonb)
  where exists (select 1 from public.notifications n
                 where n.pushed_at is null and n.kind in ('sale', 'first_sale') and n.created_at > now() - interval '6 hours'
                   and (n.push_claimed_at is null or n.push_claimed_at < now() - interval '2 minutes')
                   and exists (select 1 from public.memberships m join public.push_subscriptions s on s.user_id = m.user_id
                                where m.org_id = n.org_id));
$$);

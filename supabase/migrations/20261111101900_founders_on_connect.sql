-- Founders pricing clock starts at the first verified connection (approved 11.11.2026).
--
-- Before: issuing a WooCommerce connection key started the founders period and locked the store's fee terms, even if
-- the plugin was never installed. Now:
-- * Issuing a key no longer touches founders_until. The period starts when a connection first becomes "connected"
--   (the trigger from 20261111101700 fills founders_until once, only when empty).
-- * One-time correction for stores that NEVER connected (no connected / synced connection, no orders): their unused
--   founders period is reset so they get the full period at their first real connection.
--   - Nothing is deleted. The old fee terms are marked 'withdrawn' (history kept), and the previous values are recorded
--     in entitlement_corrections + audit_events.
--   - Stores that ever connected (e.g. Heleni), stores with orders, and stores with individual or changed terms are
--     not touched.
-- * ensure_fee_terms creates a new snapshot when a store has no active/proposed terms (withdrawn history is kept).
-- No change to fee rates, agreements, ledger or orders.

create table if not exists public.entitlement_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  kind text not null check (kind in ('founders_reset_never_connected')),
  previous_founders_until timestamptz,
  previous_fee_terms jsonb not null default '[]',
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.entitlement_corrections enable row level security;
revoke all on public.entitlement_corrections from anon, authenticated;

-- 1. Key issuance: same as before, without starting the founders clock.
CREATE OR REPLACE FUNCTION public.create_store_connection_core(p_org uuid, p_site_url text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- The founders period starts at the first verified connection (store_connections_activation trigger), not here.
  update public.organizations set website_url = coalesce(website_url, v_url) where id = p_org;

  insert into public.audit_events(actor_user_id, org_id, action, target)
  values (auth.uid(), p_org, 'store_connection.key_issued', v_id::text);

  return json_build_object('connection_id', v_id,
                           'connection_key', 'lk_' || replace(v_id::text, '-', '') || '_' || v_secret,
                           'site_url', v_url);
end $function$;

-- 2. Snapshot when the store has no terms in force (withdrawn history does not count).
CREATE OR REPLACE FUNCTION public.ensure_fee_terms(p_store uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.organizations;
begin
  if exists (select 1 from public.fee_terms where store_org_id = p_store and status in ('active', 'proposed')) then return; end if;
  select * into o from public.organizations where id = p_store and type = 'store';
  if not found then return; end if;
  if o.platform_fee_bps is not null then
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, source, note)
    values (p_store, 'custom', o.platform_fee_bps, '-infinity', 'individual_agreement', 'migrated from organizations.platform_fee_bps');
  end if;
  if o.founders_until is not null then
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, effective_until, source)
    values (p_store, 'founders', public.setting_int('founders_fee_bps'), '-infinity', o.founders_until, 'activation_snapshot'),
           (p_store, 'standard', public.setting_int('standard_fee_bps'), o.founders_until, null, 'activation_snapshot');
  else
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, source)
    values (p_store, 'standard', public.setting_int('standard_fee_bps'), '-infinity', 'activation_snapshot');
  end if;
end $function$;

-- 3. One-time correction for stores that never connected.
do $$
declare r record; v_terms jsonb;
begin
  for r in
    select o.id, o.founders_until from public.organizations o
     where o.type = 'store' and o.founders_until is not null and o.platform_fee_bps is null
       and not exists (select 1 from public.store_connections c where c.org_id = o.id
                        and (c.status = 'connected' or c.last_sync_at is not null or c.plugin_version is not null))
       and not exists (select 1 from public.orders x where x.store_org_id = o.id)
       and not exists (select 1 from public.fee_terms f where f.store_org_id = o.id
                        and (f.kind = 'custom' or f.source in ('rate_change', 'individual_agreement')))
  loop
    select coalesce(jsonb_agg(to_jsonb(f) order by f.effective_from), '[]') into v_terms
      from public.fee_terms f where f.store_org_id = r.id;
    insert into public.entitlement_corrections(org_id, kind, previous_founders_until, previous_fee_terms, reason)
    values (r.id, 'founders_reset_never_connected', r.founders_until, v_terms,
            'Founders period had started at key issuance; the store never connected. Reset so it starts at the first verified connection (approved 2026-11-11).');
    update public.fee_terms set status = 'withdrawn',
           note = left(coalesce(note || ' · ', '') || 'withdrawn 2026-11-11: founders clock reset (never connected), see entitlement_corrections', 500)
     where store_org_id = r.id and status in ('active', 'proposed');
    update public.organizations set founders_until = null where id = r.id;
    insert into public.audit_events(org_id, action, target, details)
    values (r.id, 'entitlement.founders_reset', r.id::text, jsonb_build_object('previous_founders_until', r.founders_until));
  end loop;
end $$;

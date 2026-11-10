-- Platform admin overview for the pilot: real data by default (test activities excluded), funnel with conversion,
-- growth engines, bottlenecks that need action, and a pilot-readiness checklist. Read-only; no existing function changes.

create or replace function public.admin_pilot_overview(p_include_test boolean default false) returns json
language plpgsql stable security definer set search_path to '' as $$
declare v json;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with o as (select * from public.organizations where p_include_test or not is_test),
  st as (select * from o where type = 'store'), cr as (select * from o where type = 'creator')
  select json_build_object(
    'include_test', p_include_test,
    'test_orgs', (select count(*) from public.organizations where is_test),
    'kpi', json_build_object(
      'stores', (select count(*) from st),
      'creators', (select count(*) from cr),
      'connected_stores', (select count(distinct c.org_id) from public.store_connections c join st on st.id = c.org_id where c.status = 'connected'),
      'live_offers', (select count(*) from public.opportunities op join st on st.id = op.store_org_id where op.status = 'live' and (op.ends_at is null or op.ends_at > now())),
      'active_partnerships', (select count(*) from public.agreements a join st on st.id = a.store_org_id where a.status = 'active'),
      'attributed_sales', (select count(*) from public.attributions a join st on st.id = a.store_org_id),
      'attributed_sales_30d', (select count(*) from public.attributions a join st on st.id = a.store_org_id where a.created_at > now() - interval '30 days'),
      'linkup_fees_accrued_minor', (select coalesce(sum(l.amount_minor), 0) from public.commission_ledger l join st on st.id = l.store_org_id where l.party_role = 'platform'),
      'linkup_collected_minor', (select coalesce(sum(i.total_minor), 0) from public.invoices i join st on st.id = i.store_org_id where i.status = 'paid')),
    -- Store journey: how many stores reached each step (distinct stores), so each step's conversion is visible.
    'store_funnel', json_build_array(
      json_build_object('step', 'signed_up', 'n', (select count(*) from st)),
      json_build_object('step', 'connected', 'n', (select count(distinct c.org_id) from public.store_connections c join st on st.id = c.org_id where c.status = 'connected')),
      json_build_object('step', 'offer_live', 'n', (select count(distinct op.store_org_id) from public.opportunities op join st on st.id = op.store_org_id where op.status = 'live')),
      json_build_object('step', 'has_partner', 'n', (select count(distinct a.store_org_id) from public.agreements a join st on st.id = a.store_org_id where a.status = 'active')),
      json_build_object('step', 'first_sale', 'n', (select count(distinct a.store_org_id) from public.attributions a join st on st.id = a.store_org_id))),
    'creator_funnel', json_build_array(
      json_build_object('step', 'signed_up', 'n', (select count(*) from cr)),
      json_build_object('step', 'has_partner', 'n', (select count(distinct a.creator_org_id) from public.agreements a join cr on cr.id = a.creator_org_id where a.status = 'active')),
      json_build_object('step', 'shared', 'n', (select count(distinct f.org_id) from public.funnel_events f join cr on cr.id = f.org_id where f.event = 'creative_shared')),
      json_build_object('step', 'first_sale', 'n', (select count(distinct a.creator_org_id) from public.attributions a join cr on cr.id = a.creator_org_id))),
    -- Growth engines: invites, referral links, catalog joins.
    'engines', json_build_object(
      'invites_sent', (select count(*) from public.proposals p join o on o.id = p.from_org_id),
      'invites_opened', (select count(*) from public.proposals p join o on o.id = p.from_org_id where p.opened_at is not null),
      'invites_accepted', (select count(*) from public.proposals p join o on o.id = p.from_org_id where p.status = 'accepted'),
      'store_invites_by_creators', (select count(*) from public.proposals p join cr on cr.id = p.from_org_id),
      'referral_links_shared', (select count(*) from public.funnel_events f join o on o.id = f.org_id where f.event = 'referral_link_shared'),
      'referral_signups', (select count(*) from public.referrals r join o on o.id = r.referred_org_id),
      'catalog_joins', (select count(*) from public.funnel_events f join o on o.id = f.org_id where f.event = 'opportunity_joined')),
    -- What needs action now.
    'bottlenecks', json_build_object(
      'connected_no_offer', coalesce((select json_agg(json_build_object('id', st.id, 'name', st.name)) from st
          where exists (select 1 from public.store_connections c where c.org_id = st.id and c.status = 'connected')
            and not exists (select 1 from public.opportunities op where op.store_org_id = st.id and op.status = 'live')), '[]'),
      'not_connected_2d', coalesce((select json_agg(json_build_object('id', st.id, 'name', st.name, 'since', st.created_at)) from st
          where st.created_at < now() - interval '2 days'
            and not exists (select 1 from public.store_connections c where c.org_id = st.id and c.status = 'connected')), '[]'),
      'connection_problems', coalesce((select json_agg(json_build_object('id', st.id, 'name', st.name, 'error', c.last_error, 'last_sync_at', c.last_sync_at))
          from public.store_connections c join st on st.id = c.org_id
          where c.status = 'connected' and (c.last_error is not null or c.last_sync_at is null or c.last_sync_at < now() - interval '24 hours')), '[]'),
      'creators_no_partner_3d', (select count(*) from cr where cr.created_at < now() - interval '3 days'
          and not exists (select 1 from public.agreements a where a.creator_org_id = cr.id and a.status = 'active')),
      'pending_applications', (select count(*) from public.opportunity_applications ap join public.opportunities op on op.id = ap.opportunity_id
          join st on st.id = op.store_org_id where ap.status = 'pending')),
    'readiness', json_build_object(
      'legal_published', (select count(*) from public.legal_documents where status = 'published'),
      'legal_drafts', (select count(*) from public.legal_documents where status = 'draft'),
      'invoicing_tax_approved', public.setting_bool('invoicing_tax_approved'),
      'reward_settlement_approved', public.setting_bool('reward_settlement_approved'),
      'auto_collection_enabled', public.setting_bool('auto_collection_enabled'),
      'billing_provider', public.setting_text('billing_provider'),
      'woo_api_connect_open', public.setting_bool('woo_api_connect_open'),
      'real_connected_stores', (select count(distinct c.org_id) from public.store_connections c join public.organizations x on x.id = c.org_id
          where c.status = 'connected' and not x.is_test and x.type = 'store'),
      'test_signups', (select count(*) from public.signup_allowlist)),
    'recent', coalesce((select json_agg(x order by x.created_at desc) from (
        select o.id, o.name, o.type, o.is_test, o.created_at,
               exists (select 1 from public.store_connections c where c.org_id = o.id and c.status = 'connected') as connected,
               (select count(*) from public.agreements a where (a.store_org_id = o.id or a.creator_org_id = o.id) and a.status = 'active') as partners,
               (select count(*) from public.attributions a where a.store_org_id = o.id or a.creator_org_id = o.id) as sales
          from o order by o.created_at desc limit 30) x), '[]')
  ) into v;
  return v;
end $$;
revoke all on function public.admin_pilot_overview(boolean) from public, anon;
grant execute on function public.admin_pilot_overview(boolean) to authenticated;

-- The platform admin may open "quick connect without a plugin" to all stores once it was verified on a real store.
create or replace function public.admin_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path to '' as $function$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key not in ('founding_partners_open', 'reward_transfer_min_minor', 'max_proposals_per_day', 'woo_api_connect_open') then
    raise exception 'setting_locked' using errcode = '42501';   -- pricing & reward terms change only by migration (explicit decision)
  end if;
  if (p_key in ('founding_partners_open', 'woo_api_connect_open') and jsonb_typeof(p_value) <> 'boolean')
     or (p_key not in ('founding_partners_open', 'woo_api_connect_open') and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0
         or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric))) then
    raise exception 'invalid_setting' using errcode = '22023';
  end if;
  update public.app_settings set value = p_value where key = p_key;
  insert into public.audit_events(actor_user_id, action, target, details)
  values (auth.uid(), 'setting.changed', p_key, jsonb_build_object('value', p_value));
end $function$;

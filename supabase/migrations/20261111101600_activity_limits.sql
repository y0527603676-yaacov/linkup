-- Activity limits: replace the flat "10 memberships per user" cap with a policy that allows growth and still stops abuse.
--
-- Before: every membership counted (team roles, test activities, empty activities left from failed attempts), forever.
-- Now (per user, counted separately for real and test activities):
--   * Only activities the user OWNS count. Joining someone else's team never uses the user's quota.
--   * An activity that was never set up (no connected store, no partnership, no offer, no proposal, no application)
--     stops counting after a grace period (default 7 days). Nothing is deleted.
--   * Ceiling on counted activities: setting max_activities_per_user (default 50).
--   * Anti-abuse rate limit: at most max_new_activities_per_day (default 10) new activities in 24 hours.
--   * Double submit / parallel requests: creation is serialized per user; the same type + name created in the
--     last 10 minutes and still empty is returned instead of creating a duplicate.
-- No change to permissions, agreements, fees, entitlements or existing data. No DROP.

insert into public.app_settings(key, value) values
  ('max_activities_per_user', '50'::jsonb),
  ('max_new_activities_per_day', '10'::jsonb),
  ('unset_activity_grace_days', '7'::jsonb)
on conflict (key) do nothing;

-- Has this activity been set up (anything real attached to it)?
create or replace function public.activity_established(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.store_connections c where c.org_id = p_org and c.status = 'connected')
      or exists (select 1 from public.agreements a where a.store_org_id = p_org or a.creator_org_id = p_org)
      or exists (select 1 from public.opportunities o where o.store_org_id = p_org)
      or exists (select 1 from public.opportunity_applications x where x.creator_org_id = p_org)
      or exists (select 1 from public.proposals p where p.from_org_id = p_org);
$$;
revoke all on function public.activity_established(uuid) from public, anon, authenticated;

-- Quota for the signed-in user (only their own numbers).
create or replace function public.my_activity_quota() returns json
language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := auth.uid(); v_test boolean := public.current_user_is_test();
        v_grace int := coalesce(public.setting_int('unset_activity_grace_days'), 7);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return (
    with mine as (
      select o.id, o.type, o.name, o.created_at, public.activity_established(o.id) as established
        from public.memberships m join public.organizations o on o.id = m.org_id
       where m.user_id = v_uid and m.role = 'owner' and o.is_test = v_test
    )
    select json_build_object(
      'used', (select count(*) from mine where established or created_at > now() - make_interval(days => v_grace)),
      'max', coalesce(public.setting_int('max_activities_per_user'), 50),
      'today', (select count(*) from public.memberships m join public.organizations o on o.id = m.org_id
                 where m.user_id = v_uid and m.role = 'owner' and o.created_at > now() - interval '24 hours'),
      'per_day', coalesce(public.setting_int('max_new_activities_per_day'), 10),
      'grace_days', v_grace,
      'unset', coalesce((select json_agg(json_build_object('id', id, 'type', type, 'name', name, 'created_at', created_at)
                                         order by created_at desc)
                           from mine where not established), '[]'))
  );
end $$;
revoke all on function public.my_activity_quota() from public, anon;
grant execute on function public.my_activity_quota() to authenticated;

CREATE OR REPLACE FUNCTION public.create_organization_core(p_type text, p_name text, p_website_url text DEFAULT NULL::text, p_ref_code text DEFAULT NULL::text, p_locale text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_id uuid; v_slug text; v_ref uuid; v_first boolean; v_test boolean := public.current_user_is_test();
        v_grace int := coalesce(public.setting_int('unset_activity_grace_days'), 7);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('store', 'creator') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 or char_length(btrim(p_name)) > 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- One creation at a time per user (parallel or repeated submits).
  perform pg_advisory_xact_lock(hashtextextended('linkup.create_org:' || v_uid::text, 0));

  -- Same activity submitted again within 10 minutes and still empty: return it instead of a duplicate.
  select o.id into v_id
    from public.memberships m join public.organizations o on o.id = m.org_id
   where m.user_id = v_uid and m.role = 'owner' and o.type = p_type and o.is_test = v_test
     and lower(btrim(o.name)) = lower(btrim(p_name)) and o.created_at > now() - interval '10 minutes'
     and not public.activity_established(o.id)
   order by o.created_at desc limit 1;
  if v_id is not null then return v_id; end if;

  -- Anti-abuse: new activities per 24 hours.
  if (select count(*) from public.memberships m join public.organizations o on o.id = m.org_id
       where m.user_id = v_uid and m.role = 'owner' and o.created_at > now() - interval '24 hours')
     >= coalesce(public.setting_int('max_new_activities_per_day'), 10) then
    raise exception 'activity_rate_limited' using errcode = '54000';
  end if;
  -- Ceiling: owned activities that are set up, or still within the grace period.
  if (select count(*) from public.memberships m join public.organizations o on o.id = m.org_id
       where m.user_id = v_uid and m.role = 'owner' and o.is_test = v_test
         and (o.created_at > now() - make_interval(days => v_grace) or public.activity_established(o.id)))
     >= coalesce(public.setting_int('max_activities_per_user'), 50) then
    raise exception 'too_many_orgs' using errcode = '54000';
  end if;

  v_first := not exists (select 1 from public.memberships where user_id = v_uid);
  v_slug := btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), '-');
  if v_slug = '' then v_slug := p_type; end if;
  v_slug := left(v_slug, 40) || '-' || public.random_token(6);

  insert into public.organizations(type, name, slug, website_url, locale, is_test)
  values (p_type, btrim(p_name), v_slug, public.normalize_url(p_website_url),
          case when p_locale in ('he', 'en') then p_locale else 'he' end, v_test)
  returning id into v_id;
  insert into public.memberships(user_id, org_id, role) values (v_uid, v_id, 'owner');
  insert into public.audit_events(actor_user_id, org_id, action, target) values (v_uid, v_id, 'org.created', p_type);
  insert into public.funnel_events(event, org_id) values (case when v_first then 'signup' else 'activity_added' end, v_id);

  -- Referral link: only for a brand-new activity, never from the user's own activities (trigger blocks those).
  if p_ref_code is not null and p_ref_code ~ '^[A-Za-z0-9]{6,12}$' then
    begin
      v_ref := public.resolve_referral_code(p_ref_code);
    exception when others then
      v_ref := null;   -- over the lookup limit: sign-up still succeeds, just without a referral
    end;
    if v_ref is not null and v_ref <> v_id and public.same_test_side(v_ref, v_id) then
      insert into public.referrals(referrer_org_id, referred_org_id, source, reward_bps)
      values (v_ref, v_id, 'link', 0) on conflict (referred_org_id) do nothing;
      insert into public.funnel_events(event, org_id) values ('referral_signup', v_ref);
    end if;
  end if;
  return v_id;
end $function$;

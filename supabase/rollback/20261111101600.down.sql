-- Rollback of 20261111101600_activity_limits: restore the previous create_organization_core (flat 10-membership cap).
-- The helper functions and settings are left in place (harmless, unused after rollback). No data is touched.
CREATE OR REPLACE FUNCTION public.create_organization_core(p_type text, p_name text, p_website_url text DEFAULT NULL::text, p_ref_code text DEFAULT NULL::text, p_locale text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_id uuid; v_slug text; v_ref uuid; v_first boolean; v_test boolean := public.current_user_is_test();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('store', 'creator') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 or char_length(btrim(p_name)) > 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if (select count(*) from public.memberships where user_id = v_uid) >= 10 then
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

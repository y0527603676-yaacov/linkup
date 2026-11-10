-- Test sign-ups while public sign-up stays closed.
-- * signup_allowlist: e-mail addresses the platform admin approved. Only these can create a new account
--   (checked by the login action before Supabase is asked to create a user).
-- * Activities created by an approved test address are marked organizations.is_test and kept apart from real
--   ones: catalogs, opportunity joins, proposals and referrals never cross between test and real.
-- * No change to permissions, money settings or existing data (existing organizations stay is_test = false).

alter table public.organizations add column if not exists is_test boolean not null default false;

create table if not exists public.signup_allowlist (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  is_test boolean not null default true,
  note text check (char_length(note) <= 200),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.signup_allowlist enable row level security;
revoke all on public.signup_allowlist from anon, authenticated;

-- May this address create a new account while sign-up is closed? (Only true/false; nothing else is revealed.)
create or replace function public.signup_allowed(p_email text) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.signup_allowlist where email = lower(btrim(coalesce(p_email, ''))));
$$;
revoke all on function public.signup_allowed(text) from public;
grant execute on function public.signup_allowed(text) to anon, authenticated;

create or replace function public.current_user_is_test() returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.signup_allowlist a join auth.users u on lower(u.email) = a.email
                  where u.id = auth.uid() and a.is_test);
$$;
revoke all on function public.current_user_is_test() from public, anon;
grant execute on function public.current_user_is_test() to authenticated;

create or replace function public.same_test_side(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select (select is_test from public.organizations where id = p_a) is not distinct from (select is_test from public.organizations where id = p_b);
$$;
revoke all on function public.same_test_side(uuid, uuid) from public, anon, authenticated;

create or replace function public.admin_test_signups() returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('email', a.email, 'note', a.note, 'created_at', a.created_at,
            'registered', exists (select 1 from auth.users u where lower(u.email) = a.email)) order by a.created_at desc)
          from public.signup_allowlist a), '[]');
end $$;

create or replace function public.admin_add_test_signup(p_email text, p_note text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v) > 200 then raise exception 'email' using errcode = '22023'; end if;
  -- An address that already belongs to a real account is not turned into a test account.
  if exists (select 1 from auth.users u where lower(u.email) = v) and not exists (select 1 from public.signup_allowlist where email = v) then
    raise exception 'email_in_use' using errcode = '22023';
  end if;
  insert into public.signup_allowlist(email, note, added_by) values (v, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (email) do update set note = excluded.note;
  insert into public.audit_events(actor_user_id, action, target) values (auth.uid(), 'test_signup.added', v);
end $$;

create or replace function public.admin_remove_test_signup(p_email text) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.signup_allowlist where email = lower(btrim(coalesce(p_email, '')));
  insert into public.audit_events(actor_user_id, action, target) values (auth.uid(), 'test_signup.removed', lower(btrim(coalesce(p_email, ''))));
end $$;
revoke all on function public.admin_test_signups(), public.admin_add_test_signup(text, text), public.admin_remove_test_signup(text) from public, anon;
grant execute on function public.admin_test_signups(), public.admin_add_test_signup(text, text), public.admin_remove_test_signup(text) to authenticated;

-- Isolation guards in the existing functions (bodies otherwise unchanged).
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

CREATE OR REPLACE FUNCTION public.catalog(p_search text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_limit integer DEFAULT 30)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(json_agg(x order by x.is_campaign desc, x.commission_bps desc, x.created_at desc), '[]') from (
    select o.id, o.kind, o.kind = 'campaign' as is_campaign, o.title, o.description, o.commission_bps,
           o.coupon_discount_pct, o.attribution_days, o.ends_at, o.auto_approve, o.created_at,
           s.id as store_org_id, s.name as store_name, s.website_url as store_url, s.logo_url as store_logo,
           (select count(*) from public.products p where p.store_org_id = s.id and p.status = 'active' and p.in_stock) as product_count,
           coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'image_url', p.image_url,
                                                       'price_minor', p.price_minor, 'currency', p.currency, 'url', p.permalink))
                       from (select * from public.products p
                              where p.store_org_id = s.id and p.status = 'active' and p.in_stock
                                and (cardinality(o.product_ids) = 0 or p.id = any(o.product_ids))
                              order by p.image_url is null, p.synced_at desc limit 4) p), '[]') as products
      from public.opportunities o join public.organizations s on s.id = o.store_org_id
     where auth.uid() is not null and o.status = 'live' and (o.ends_at is null or o.ends_at > now())
       and exists (select 1 from public.store_connections c where c.org_id = s.id and c.status = 'connected')
       and s.is_test = public.current_user_is_test()   -- test accounts see only test stores, real accounts only real ones
       and (p_kind is null or o.kind = p_kind)
       and (p_search is null or btrim(p_search) = '' or s.name ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%'
            or o.title ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%')
     order by o.kind = 'campaign' desc, o.commission_bps desc
     limit least(greatest(coalesce(p_limit, 30), 1), 100)) x;
$function$;

CREATE OR REPLACE FUNCTION public.public_catalog_preview()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(json_agg(x), '[]') from (
    select o.kind, o.commission_bps, o.coupon_discount_pct, o.ends_at, s.name as store_name,
           p.name as product_name, p.image_url, p.price_minor, p.currency
      from public.opportunities o join public.organizations s on s.id = o.store_org_id
      join lateral (select * from public.products p where p.store_org_id = s.id and p.status = 'active' and p.in_stock
                       and p.image_url is not null order by p.synced_at desc limit 1) p on true
     where o.status = 'live' and (o.ends_at is null or o.ends_at > now())
       and exists (select 1 from public.store_connections c where c.org_id = s.id and c.status = 'connected')
       and not s.is_test
     order by o.kind = 'campaign' desc, o.created_at desc limit 6) x;
$function$;

CREATE OR REPLACE FUNCTION public.join_opportunity(p_opportunity uuid, p_creator uuid, p_message text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.opportunities; v_app uuid; v_res json; v_std public.opportunities; v_ag uuid; v_status text;
begin
  if not public.is_admin(p_creator) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_creator) <> 'creator' then raise exception 'not_a_creator' using errcode = '22023'; end if;
  select * into o from public.opportunities where id = p_opportunity;
  if not found or o.status <> 'live' or (o.ends_at is not null and o.ends_at < now()) then
    raise exception 'opportunity_closed' using errcode = '22023';
  end if;
  if public.orgs_share_member(o.store_org_id, p_creator) then raise exception 'self_deal' using errcode = '22023'; end if;
  if not public.same_test_side(o.store_org_id, p_creator) then raise exception 'test_isolation' using errcode = '22023'; end if;
  select id, status into v_app, v_status from public.opportunity_applications
   where opportunity_id = o.id and creator_org_id = p_creator;
  if v_app is not null then
    return json_build_object('application_id', v_app, 'status', v_status);
  end if;

  if o.auto_approve then
    select id into v_ag from public.agreements where store_org_id = o.store_org_id and creator_org_id = p_creator and status = 'active';
    if o.kind = 'standing' then
      -- An existing (possibly negotiated) partnership keeps its terms; joining never overwrites them.
      if v_ag is null then
        v_res := public.upsert_agreement_terms(o.store_org_id, p_creator, o.commission_bps, o.coupon_discount_pct, o.attribution_days);
      else
        v_res := json_build_object('agreement_id', v_ag, 'code',
                   (select code from public.partner_codes where agreement_id = v_ag and active order by created_at desc limit 1));
      end if;
    else
      -- Campaign: join with the store's standing terms (or keep existing terms); the campaign rate applies during the campaign.
      if v_ag is null then
        -- New creators may join through a campaign only when the store accepts new partners automatically.
        select * into v_std from public.opportunities where store_org_id = o.store_org_id and kind = 'standing';
        if v_std.id is null or v_std.status <> 'live' or not v_std.auto_approve then
          raise exception 'join_standing_first' using errcode = '22023';
        end if;
        v_res := public.upsert_agreement_terms(o.store_org_id, p_creator, v_std.commission_bps, v_std.coupon_discount_pct, v_std.attribution_days);
      else
        v_res := json_build_object('agreement_id', v_ag,
                   'code', (select code from public.partner_codes where agreement_id = v_ag and active order by created_at desc limit 1));
      end if;
    end if;
    insert into public.opportunity_applications(opportunity_id, creator_org_id, status, message, agreement_id, decided_at)
    values (o.id, p_creator, 'approved', nullif(btrim(coalesce(p_message, '')), ''), (v_res ->> 'agreement_id')::uuid, now())
    returning id into v_app;
    perform public.enroll_live_campaigns(o.store_org_id, p_creator, (v_res ->> 'agreement_id')::uuid);
    v_status := 'approved';
  else
    insert into public.opportunity_applications(opportunity_id, creator_org_id, status, message)
    values (o.id, p_creator, 'pending', nullif(btrim(coalesce(p_message, '')), '')) returning id into v_app;
    v_status := 'pending';
  end if;
  insert into public.notifications(org_id, kind, payload)
  values (o.store_org_id, case when v_status = 'approved' then 'partner_joined' else 'application_received' end,
          jsonb_build_object('application_id', v_app, 'creator', (select name from public.organizations where id = p_creator),
                             'opportunity', o.title));
  insert into public.funnel_events(event, org_id) values ('opportunity_joined', p_creator);
  return json_build_object('application_id', v_app, 'status', v_status, 'code', v_res ->> 'code');
end $function$;

CREATE OR REPLACE FUNCTION public.accept_proposal(p_token text, p_org uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.proposals; v_org public.organizations; v_store uuid; v_creator uuid;
        v_ag uuid; v_ver int; v_code text; v_new boolean := false;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.proposals where token = p_token for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p.status not in ('sent', 'opened') then raise exception 'proposal_closed' using errcode = '22023'; end if;
  if p.expires_at < now() then raise exception 'proposal_expired' using errcode = '22023'; end if;
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_org from public.organizations where id = p_org;
  if p.direction = 'store_to_creator' then
    if v_org.type <> 'creator' then raise exception 'wrong_org_type' using errcode = '22023'; end if;
    v_store := p.from_org_id; v_creator := p_org;
  else
    if v_org.type <> 'store' then raise exception 'wrong_org_type' using errcode = '22023'; end if;
    v_store := p_org; v_creator := p.from_org_id;
  end if;
  if not public.same_test_side(v_store, v_creator) then raise exception 'test_isolation' using errcode = '22023'; end if;

  select id into v_ag from public.agreements
   where store_org_id = v_store and creator_org_id = v_creator and status = 'active' for update;
  if v_ag is null then
    insert into public.agreements(store_org_id, creator_org_id, proposal_id)
    values (v_store, v_creator, p.id) returning id into v_ag;
    v_ver := 1; v_new := true;
  else
    -- Existing partners: new terms apply prospectively as a new version.
    select max(version) + 1 into v_ver from public.agreement_versions where agreement_id = v_ag;
  end if;

  insert into public.agreement_versions(agreement_id, version, commission_bps, coupon_discount_pct, attribution_days,
                                        refund_hold_days, proposal_id, accepted_by_store_at, accepted_by_creator_at)
  values (v_ag, v_ver, p.commission_bps, p.coupon_discount_pct, p.attribution_days,
          public.setting_int('refund_hold_days'), p.id,
          case when p.direction = 'store_to_creator' then p.created_at else now() end,
          case when p.direction = 'store_to_creator' then now() else p.created_at end);

  if v_new then
    v_code := public.generate_partner_code(v_creator);
    insert into public.partner_codes(agreement_id, code) values (v_ag, v_code);
  else
    select code into v_code from public.partner_codes
     where agreement_id = v_ag and active order by created_at desc limit 1;
  end if;

  update public.proposals set status = 'accepted', accepted_org_id = p_org, decided_at = now() where id = p.id;
  insert into public.funnel_events(event, proposal_id, org_id) values ('proposal_accepted', p.id, p.from_org_id);

  -- Viral attribution: the accepting org joined LINKUP because of this proposal.
  if v_org.created_at >= p.created_at then
    insert into public.referrals(referrer_org_id, referred_org_id, source, proposal_id, reward_bps, reward_until)
    values (p.from_org_id, p_org, 'proposal', p.id, public.setting_int('referral_reward_bps'),
            now() + make_interval(months => public.setting_int('referral_months')))
    on conflict (referred_org_id) do nothing;
  end if;

  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'proposal.accepted', p.id::text, json_build_object('agreement_id', v_ag, 'version', v_ver)::jsonb);

  return json_build_object('agreement_id', v_ag, 'version', v_ver, 'code', v_code,
                           'store_org_id', v_store, 'creator_org_id', v_creator);
end $function$;

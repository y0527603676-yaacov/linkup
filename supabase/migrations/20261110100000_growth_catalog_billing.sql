-- LINKUP full build — catalog, opportunities & LINKUP LAUNCH campaigns, team roles, store billing,
-- creator payout tracking, FOUNDING PARTNERS rewards & wallet, referral links, notifications, platform admin.
-- Additive only: no existing row is rewritten except marking pre-program test referrals as 'legacy'.
-- Money: bigint minor units. Rates: basis points.

/* ================= Settings ================= */
update public.app_settings set value = '4000' where key = 'referral_reward_bps';   -- 40% of collected LINKUP revenue
insert into public.app_settings(key, value) values
  ('referral_reward_days', '90'),          -- reward period, starts at the referred party's first qualifying sale
  ('founding_partners_open', 'true'),      -- program accepts new referrals
  ('reward_transfer_min_minor', '10000'),  -- bank transfer of rewards only above ₪100 (smaller balances offset invoices)
  ('max_team_invites_per_day', '20')
on conflict (key) do nothing;

/* ================= Platform admins ================= */
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

/* ================= Organizations: referral code, locale ================= */
alter table public.organizations add column if not exists referral_code text;
alter table public.organizations add column if not exists locale text not null default 'he' check (locale in ('he', 'en'));
alter table public.organizations add column if not exists logo_url text;
alter table public.organizations add column if not exists description text check (char_length(description) <= 500);
update public.organizations set referral_code = upper(public.random_token(10)) where referral_code is null;
alter table public.organizations alter column referral_code set default upper(public.random_token(10));
alter table public.organizations alter column referral_code set not null;
create unique index if not exists organizations_referral_code_uq on public.organizations(lower(referral_code));

-- True when two activities share a person (same user or same e-mail). Used against self-referral / self-deals.
create function public.orgs_share_member(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_a = p_b or exists (
    select 1 from public.memberships ma join auth.users ua on ua.id = ma.user_id
      join public.memberships mb on mb.org_id = p_b join auth.users ub on ub.id = mb.user_id
     where ma.org_id = p_a and (ma.user_id = mb.user_id or lower(btrim(ua.email)) = lower(btrim(ub.email))));
$$;

/* ================= Referrals: program + guards ================= */
alter table public.referrals add column if not exists program text not null default 'founding_partners'
  check (program in ('founding_partners', 'legacy', 'none'));
alter table public.referrals add column if not exists status text not null default 'active'
  check (status in ('active', 'blocked'));
alter table public.referrals drop constraint if exists referrals_source_check;
alter table public.referrals add constraint referrals_source_check check (source in ('proposal', 'partner_page', 'import', 'link'));
-- Every referral that exists before this migration (old 10% rule, pilot tests) is legacy: never earns FOUNDING PARTNERS rewards.
update public.referrals set program = 'legacy';

create function public.referrals_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.setting_bool('founding_partners_open') then
    new.program := 'founding_partners';
    new.reward_bps := public.setting_int('referral_reward_bps');
  else
    new.program := 'none';
    new.reward_bps := 0;
  end if;
  -- reward_until = last moment the referred party may make its first qualifying sale (12 months).
  new.reward_until := coalesce(new.reward_until, now() + make_interval(months => public.setting_int('referral_months')));
  if public.orgs_share_member(new.referrer_org_id, new.referred_org_id) then
    new.status := 'blocked';
  end if;
  return new;
end $$;
create trigger referrals_program before insert on public.referrals
  for each row execute function public.referrals_before_insert();

/* ================= Accounts: create activity with optional referral code ================= */
drop function public.create_organization(text, text, text);
create function public.create_organization(p_type text, p_name text, p_website_url text default null,
                                           p_ref_code text default null, p_locale text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_slug text; v_ref uuid; v_first boolean;
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

  insert into public.organizations(type, name, slug, website_url, locale)
  values (p_type, btrim(p_name), v_slug, public.normalize_url(p_website_url),
          case when p_locale in ('he', 'en') then p_locale else 'he' end)
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
    if v_ref is not null and v_ref <> v_id then
      insert into public.referrals(referrer_org_id, referred_org_id, source, reward_bps)
      values (v_ref, v_id, 'link', 0) on conflict (referred_org_id) do nothing;
      insert into public.funnel_events(event, org_id) values ('referral_signup', v_ref);
    end if;
  end if;
  return v_id;
end $$;

create function public.update_organization(p_org uuid, p_name text, p_website_url text, p_description text,
                                           p_logo_url text, p_locale text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then raise exception 'invalid_name' using errcode = '22023'; end if;
  if p_logo_url is not null and p_logo_url !~* '^https://' then raise exception 'invalid_url' using errcode = '22023'; end if;
  update public.organizations
     set name = btrim(p_name), website_url = public.normalize_url(p_website_url),
         description = nullif(btrim(coalesce(p_description, '')), ''), logo_url = nullif(btrim(coalesce(p_logo_url, '')), ''),
         locale = case when p_locale in ('he', 'en') then p_locale else locale end
   where id = p_org;
  insert into public.audit_events(actor_user_id, org_id, action) values (auth.uid(), p_org, 'org.updated');
end $$;

/* ================= Team ================= */
create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 200),
  role text not null check (role in ('admin', 'member')),
  token text not null unique,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days'
);
create index team_invites_org_idx on public.team_invites(org_id, created_at);

create function public.invite_team_member(p_org uuid, p_email text, p_role text) returns json
language plpgsql security definer set search_path = '' as $$
declare v_token text := public.random_token(32); v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role not in ('admin', 'member') then raise exception 'invalid_role' using errcode = '22023'; end if;
  -- Only an owner can grant admin.
  if p_role = 'admin' and not exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid() and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email' using errcode = '22023'; end if;
  if (select count(*) from public.team_invites where org_id = p_org and created_at > now() - interval '1 day')
     >= public.setting_int('max_team_invites_per_day') then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  update public.team_invites set revoked_at = now()
   where org_id = p_org and lower(email) = v_email and accepted_at is null and revoked_at is null;
  insert into public.team_invites(org_id, email, role, token, invited_by) values (p_org, v_email, p_role, v_token, auth.uid());
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'team.invited', v_email);
  return json_build_object('token', v_token);
end $$;

create function public.get_team_invite(p_token text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('org_name', o.name, 'org_type', o.type, 'role', i.role, 'email', i.email,
                           'valid', i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    from public.team_invites i join public.organizations o on o.id = i.org_id
   where p_token ~ '^[0-9a-f]{32}$' and i.token = p_token;
$$;

create function public.accept_team_invite(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.team_invites; v_email text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into i from public.team_invites where token = p_token for update;
  if not found or i.accepted_at is not null or i.revoked_at is not null or i.expires_at < now() then
    raise exception 'invite_invalid' using errcode = '22023';
  end if;
  select lower(btrim(email)) into v_email from auth.users where id = auth.uid();
  if v_email is distinct from lower(i.email) then raise exception 'invite_email_mismatch' using errcode = '42501'; end if;
  insert into public.memberships(user_id, org_id, role) values (auth.uid(), i.org_id, i.role)
  on conflict (user_id, org_id) do nothing;
  update public.team_invites set accepted_at = now() where id = i.id;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), i.org_id, 'team.joined', i.role);
  return i.org_id;
end $$;

create function public.org_members(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'members', coalesce((select json_agg(json_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role,
                                                          'is_me', m.user_id = auth.uid()) order by m.created_at)
                           from public.memberships m join auth.users u on u.id = m.user_id where m.org_id = p_org), '[]'),
    'invites', coalesce((select json_agg(json_build_object('id', id, 'email', email, 'role', role, 'token', token,
                                                          'created_at', created_at) order by created_at desc)
                           from public.team_invites where org_id = p_org and accepted_at is null
                            and revoked_at is null and expires_at > now()), '[]'));
end $$;

create function public.set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid() and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'admin', 'member') then raise exception 'invalid_role' using errcode = '22023'; end if;
  if p_user = auth.uid() and p_role <> 'owner'
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') = 1 then
    raise exception 'last_owner' using errcode = '22023';
  end if;
  update public.memberships set role = p_role where org_id = p_org and user_id = p_user;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'team.role_changed', p_user::text, jsonb_build_object('role', p_role));
end $$;

create function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select role into v_role from public.memberships where org_id = p_org and user_id = p_user;
  if v_role is null then return; end if;
  -- Owners manage everyone; admins may remove members; anyone may leave (except the last owner).
  if not (exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid() and role = 'owner')
          or (public.is_admin(p_org) and v_role = 'member') or p_user = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_role = 'owner' and (select count(*) from public.memberships where org_id = p_org and role = 'owner') = 1 then
    raise exception 'last_owner' using errcode = '22023';
  end if;
  delete from public.memberships where org_id = p_org and user_id = p_user;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_org, 'team.removed', p_user::text);
end $$;

create function public.revoke_team_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.team_invites where id = p_invite;
  if v_org is null or not public.is_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.team_invites set revoked_at = now() where id = p_invite and accepted_at is null;
end $$;

/* ================= Products (synced from the store) ================= */
create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.store_connections(id),
  external_id text not null,
  name text not null,
  permalink text,
  image_url text,
  price_minor bigint check (price_minor >= 0),
  currency char(3) not null,
  in_stock boolean not null default true,
  stock_qty int,
  categories text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'removed')),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index products_store_idx on public.products(store_org_id, status, in_stock);

-- Plugin batch upsert (service role). p_full = this batch completes a full catalogue pass:
-- products not seen since p_full_started_at are marked removed.
create function public.plugin_sync_products(p_connection uuid, p_products jsonb, p_full_started_at timestamptz default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare v_conn public.store_connections; p jsonb; n int := 0; v_removed int := 0;
begin
  select * into v_conn from public.store_connections where id = p_connection;
  if not found then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_conn.status = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;
  if jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) > 200 then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  for p in select * from jsonb_array_elements(p_products) loop
    if coalesce(p ->> 'id', '') = '' or coalesce(p ->> 'name', '') = ''
       or coalesce(p ->> 'currency', '') !~ '^[A-Z]{3}$'
       or (p ? 'price' and p ->> 'price' is not null and (p ->> 'price') !~ '^[0-9]{1,12}$') then
      continue; -- skip malformed rows, never fail the batch
    end if;
    insert into public.products as pr (store_org_id, connection_id, external_id, name, permalink, image_url, price_minor,
                                       currency, in_stock, stock_qty, categories, status, synced_at)
    values (v_conn.org_id, p_connection, left(p ->> 'id', 64), left(p ->> 'name', 200),
            case when (p ->> 'url') ~* '^https?://' then left(p ->> 'url', 500) end,
            case when (p ->> 'image') ~* '^https://' then left(p ->> 'image', 500) end,
            (p ->> 'price')::bigint, p ->> 'currency',
            coalesce((p ->> 'in_stock')::boolean, true),
            case when (p ->> 'stock_qty') ~ '^-?[0-9]{1,9}$' then (p ->> 'stock_qty')::int end,
            coalesce((select array_agg(left(x, 60)) from (select jsonb_array_elements_text(
                       case when jsonb_typeof(p -> 'categories') = 'array' then p -> 'categories' else '[]'::jsonb end) x limit 10) c), '{}'),
            case when coalesce(p ->> 'status', 'publish') = 'publish' then 'active' else 'removed' end,
            now())
    on conflict (connection_id, external_id) do update set
      name = excluded.name, permalink = excluded.permalink, image_url = excluded.image_url,
      price_minor = excluded.price_minor, currency = excluded.currency, in_stock = excluded.in_stock,
      stock_qty = excluded.stock_qty, categories = excluded.categories, status = excluded.status, synced_at = now();
    n := n + 1;
  end loop;
  if p_full_started_at is not null then
    update public.products set status = 'removed'
     where connection_id = p_connection and status = 'active' and synced_at < p_full_started_at;
    get diagnostics v_removed = row_count;
  end if;
  if n > 0 and not exists (select 1 from public.funnel_events where event = 'products_synced' and org_id = v_conn.org_id) then
    insert into public.funnel_events(event, org_id) values ('products_synced', v_conn.org_id);
  end if;
  return json_build_object('upserted', n, 'removed', v_removed);
end $$;

/* ================= Opportunities (standing offer + LINKUP LAUNCH campaigns) ================= */
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  kind text not null check (kind in ('standing', 'campaign')),
  title text not null check (char_length(title) between 2 and 100),
  description text check (char_length(description) <= 1000),
  commission_bps int not null check (commission_bps between 100 and 5000),
  coupon_discount_pct int not null default 10 check (coupon_discount_pct between 0 and 50),
  attribution_days int not null default 30 check (attribution_days between 1 and 90),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  status text not null default 'live' check (status in ('live', 'paused', 'ended')),
  auto_approve boolean not null default true,
  product_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (kind = 'standing' or (ends_at is not null and ends_at > starts_at)),
  check (ends_at is null or ends_at <= starts_at + interval '90 days')
);
create unique index opportunities_one_standing_uq on public.opportunities(store_org_id) where kind = 'standing';
create index opportunities_live_idx on public.opportunities(status, kind, ends_at);

create table public.opportunity_applications (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id),
  creator_org_id uuid not null references public.organizations(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  message text check (char_length(message) <= 500),
  agreement_id uuid references public.agreements(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (opportunity_id, creator_org_id)
);
create index opp_app_creator_idx on public.opportunity_applications(creator_org_id);

alter table public.attributions add column if not exists campaign_id uuid references public.opportunities(id);
alter table public.attributions add column if not exists base_commission_bps int;

-- Creates or extends a store↔creator agreement with explicit terms (new version from now on). Internal helper.
create function public.upsert_agreement_terms(p_store uuid, p_creator uuid, p_commission_bps int, p_coupon int,
                                              p_days int) returns json
language plpgsql security definer set search_path = '' as $$
declare v_ag uuid; v_ver int; v_code text; v_cur public.agreement_versions;
begin
  if p_store = p_creator then raise exception 'same_org' using errcode = '22023'; end if;
  select id into v_ag from public.agreements where store_org_id = p_store and creator_org_id = p_creator and status = 'active' for update;
  if v_ag is null then
    insert into public.agreements(store_org_id, creator_org_id) values (p_store, p_creator) returning id into v_ag;
    v_ver := 1;
    v_code := public.generate_partner_code(p_creator);
    insert into public.partner_codes(agreement_id, code) values (v_ag, v_code);
  else
    select * into v_cur from public.agreement_versions where agreement_id = v_ag order by version desc limit 1;
    select code into v_code from public.partner_codes where agreement_id = v_ag and active order by created_at desc limit 1;
    if v_cur.commission_bps = p_commission_bps and v_cur.coupon_discount_pct = p_coupon and v_cur.attribution_days = p_days then
      return json_build_object('agreement_id', v_ag, 'version', v_cur.version, 'code', v_code, 'created', false);
    end if;
    v_ver := v_cur.version + 1;
  end if;
  insert into public.agreement_versions(agreement_id, version, commission_bps, coupon_discount_pct, attribution_days,
                                        refund_hold_days, accepted_by_store_at, accepted_by_creator_at)
  values (v_ag, v_ver, p_commission_bps, p_coupon, p_days, public.setting_int('refund_hold_days'), now(), now());
  return json_build_object('agreement_id', v_ag, 'version', v_ver, 'code', v_code, 'created', v_ver = 1);
end $$;

-- A new partner of a store joins the store's live campaigns automatically (same as existing partners at launch).
create function public.enroll_live_campaigns(p_store uuid, p_creator uuid, p_agreement uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.opportunity_applications(opportunity_id, creator_org_id, status, agreement_id, decided_at)
  select o.id, p_creator, 'approved', p_agreement, now() from public.opportunities o
   where o.store_org_id = p_store and o.kind = 'campaign' and o.status = 'live' and o.ends_at > now()
  on conflict (opportunity_id, creator_org_id) do nothing;
$$;

-- Every new partnership (direct invite, catalogue, approval) joins the store's live campaigns.
create function public.agreements_enroll_campaigns() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.enroll_live_campaigns(new.store_org_id, new.creator_org_id, new.id);
  return new;
end $$;
create trigger agreements_enroll_campaigns after insert on public.agreements
  for each row execute function public.agreements_enroll_campaigns();

create function public.save_standing_opportunity(p_store uuid, p_title text, p_description text, p_commission_bps int,
                                                 p_coupon_pct int, p_auto_approve boolean, p_status text,
                                                 p_product_ids uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_new boolean;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_store) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if p_status not in ('live', 'paused') then raise exception 'invalid_status' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_product_ids, '{}')) x where not exists
             (select 1 from public.products where id = x and store_org_id = p_store)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_new := not exists (select 1 from public.opportunities where store_org_id = p_store and kind = 'standing');
  insert into public.opportunities as o (store_org_id, kind, title, description, commission_bps, coupon_discount_pct,
                                         auto_approve, status, product_ids, created_by)
  values (p_store, 'standing', btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_commission_bps,
          coalesce(p_coupon_pct, 10), coalesce(p_auto_approve, true), p_status, coalesce(p_product_ids, '{}'), auth.uid())
  on conflict (store_org_id) where kind = 'standing' do update set
    title = excluded.title, description = excluded.description, commission_bps = excluded.commission_bps,
    coupon_discount_pct = excluded.coupon_discount_pct, auto_approve = excluded.auto_approve,
    status = excluded.status, product_ids = excluded.product_ids
  returning o.id into v_id;
  update public.organizations set default_commission_bps = p_commission_bps where id = p_store;
  if v_new and p_status = 'live' then insert into public.funnel_events(event, org_id) values ('opportunity_published', p_store); end if;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'opportunity.saved', v_id::text,
          jsonb_build_object('commission_bps', p_commission_bps, 'coupon_pct', p_coupon_pct, 'status', p_status));
  return v_id;
end $$;

-- LINKUP LAUNCH: time-limited campaign. Existing active partners are enrolled automatically and notified.
create function public.create_campaign(p_store uuid, p_title text, p_description text, p_commission_bps int,
                                       p_starts_at timestamptz, p_ends_at timestamptz,
                                       p_product_ids uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_base int; v_cnt int;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_store) <> 'store' then raise exception 'not_a_store' using errcode = '22023'; end if;
  if not exists (select 1 from public.store_connections where org_id = p_store and status = 'connected') then
    raise exception 'store_not_connected' using errcode = '22023';
  end if;
  if p_ends_at is null or p_starts_at is null or p_ends_at <= p_starts_at or p_ends_at < now()
     or p_ends_at > p_starts_at + interval '90 days' or p_starts_at > now() + interval '60 days' then
    raise exception 'invalid_dates' using errcode = '22023';
  end if;
  select count(*) into v_cnt from public.opportunities
   where store_org_id = p_store and kind = 'campaign' and status = 'live' and ends_at > now();
  if v_cnt >= 5 then raise exception 'too_many_campaigns' using errcode = '54000'; end if;
  if exists (select 1 from unnest(coalesce(p_product_ids, '{}')) x where not exists
             (select 1 from public.products where id = x and store_org_id = p_store)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select default_commission_bps into v_base from public.organizations where id = p_store;
  insert into public.opportunities(store_org_id, kind, title, description, commission_bps, coupon_discount_pct,
                                   starts_at, ends_at, status, auto_approve, product_ids, created_by)
  values (p_store, 'campaign', btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_commission_bps,
          coalesce((select coupon_discount_pct from public.opportunities where store_org_id = p_store and kind = 'standing'), 10),
          p_starts_at, p_ends_at, 'live', true, coalesce(p_product_ids, '{}'), auth.uid())
  returning id into v_id;
  insert into public.opportunity_applications(opportunity_id, creator_org_id, status, agreement_id, decided_at)
  select v_id, a.creator_org_id, 'approved', a.id, now() from public.agreements a
   where a.store_org_id = p_store and a.status = 'active';
  insert into public.notifications(org_id, kind, payload)
  select a.creator_org_id, 'campaign_launched',
         jsonb_build_object('campaign_id', v_id, 'store', (select name from public.organizations where id = p_store),
                            'title', btrim(p_title), 'commission_bps', p_commission_bps, 'ends_at', p_ends_at)
    from public.agreements a where a.store_org_id = p_store and a.status = 'active';
  insert into public.funnel_events(event, org_id) values ('campaign_launched', p_store);
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_store, 'campaign.created', v_id::text);
  return v_id;
end $$;

create function public.set_opportunity_status(p_opportunity uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_org_id into v_store from public.opportunities where id = p_opportunity;
  if v_store is null or not public.is_admin(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('live', 'paused', 'ended') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.opportunities set status = p_status,
         ends_at = case when p_status = 'ended' and kind = 'campaign' and ends_at > now() then greatest(now(), starts_at + interval '1 second') else ends_at end
   where id = p_opportunity and status <> 'ended';
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), v_store, 'opportunity.status', p_opportunity::text, jsonb_build_object('status', p_status));
end $$;

-- A creator joins an opportunity from the catalogue. Standing + auto-approve => partnership is active immediately.
create function public.join_opportunity(p_opportunity uuid, p_creator uuid, p_message text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities; v_app uuid; v_res json; v_std public.opportunities; v_ag uuid; v_status text;
begin
  if not public.is_admin(p_creator) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select type from public.organizations where id = p_creator) <> 'creator' then raise exception 'not_a_creator' using errcode = '22023'; end if;
  select * into o from public.opportunities where id = p_opportunity;
  if not found or o.status <> 'live' or (o.ends_at is not null and o.ends_at < now()) then
    raise exception 'opportunity_closed' using errcode = '22023';
  end if;
  if public.orgs_share_member(o.store_org_id, p_creator) then raise exception 'self_deal' using errcode = '22023'; end if;
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
end $$;

create function public.decide_application(p_application uuid, p_approve boolean) returns json
language plpgsql security definer set search_path = '' as $$
declare a public.opportunity_applications; o public.opportunities; v_res json;
begin
  select * into a from public.opportunity_applications where id = p_application for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into o from public.opportunities where id = a.opportunity_id;
  if not public.is_admin(o.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if a.status <> 'pending' then raise exception 'already_decided' using errcode = '22023'; end if;
  if p_approve then
    v_res := public.upsert_agreement_terms(o.store_org_id, a.creator_org_id, o.commission_bps, o.coupon_discount_pct, o.attribution_days);
    update public.opportunity_applications set status = 'approved', decided_at = now(),
           agreement_id = (v_res ->> 'agreement_id')::uuid where id = a.id;
    perform public.enroll_live_campaigns(o.store_org_id, a.creator_org_id, (v_res ->> 'agreement_id')::uuid);
  else
    update public.opportunity_applications set status = 'rejected', decided_at = now() where id = a.id;
  end if;
  insert into public.notifications(org_id, kind, payload)
  values (a.creator_org_id, case when p_approve then 'application_approved' else 'application_rejected' end,
          jsonb_build_object('store', (select name from public.organizations where id = o.store_org_id), 'opportunity', o.title));
  return json_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'code', v_res ->> 'code');
end $$;

create function public.pending_applications(p_store uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_member(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', ap.id, 'creator', c.name, 'opportunity', o.title,
                                                     'message', ap.message, 'created_at', ap.created_at) order by ap.created_at)
                     from public.opportunity_applications ap join public.opportunities o on o.id = ap.opportunity_id
                     join public.organizations c on c.id = ap.creator_org_id
                    where o.store_org_id = p_store and ap.status = 'pending'), '[]');
end $$;

-- Creator catalogue: live opportunities of connected stores, with up to 4 in-stock products each.
create function public.catalog(p_search text default null, p_kind text default null, p_limit int default 30) returns json
language sql stable security definer set search_path = '' as $$
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
       and (p_kind is null or o.kind = p_kind)
       and (p_search is null or btrim(p_search) = '' or s.name ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%'
            or o.title ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%')
     order by o.kind = 'campaign' desc, o.commission_bps desc
     limit least(greatest(coalesce(p_limit, 30), 1), 100)) x;
$$;

/* ================= Notifications ================= */
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  emailed_at timestamptz
);
create index notifications_org_idx on public.notifications(org_id, created_at desc);

create function public.mark_notifications_read(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.notifications set read_at = now() where org_id = p_org and read_at is null;
end $$;

create function public.notify_on_attribution() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store text; v_creator text; v_first_store boolean; v_first_creator boolean;
begin
  select name into v_store from public.organizations where id = new.store_org_id;
  select name into v_creator from public.organizations where id = new.creator_org_id;
  v_first_store := not exists (select 1 from public.attributions where store_org_id = new.store_org_id and id <> new.id);
  v_first_creator := not exists (select 1 from public.attributions where creator_org_id = new.creator_org_id and id <> new.id);
  insert into public.notifications(org_id, kind, payload) values
    (new.store_org_id, case when v_first_store then 'first_sale' else 'sale' end,
     jsonb_build_object('partner', v_creator, 'order_id', new.order_id)),
    (new.creator_org_id, case when v_first_creator then 'first_sale' else 'sale' end,
     jsonb_build_object('store', v_store, 'order_id', new.order_id));
  return new;
end $$;
create trigger attributions_notify after insert on public.attributions
  for each row execute function public.notify_on_attribution();

create function public.notify_on_referral() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' and new.program = 'founding_partners' then
    insert into public.notifications(org_id, kind, payload)
    values (new.referrer_org_id, 'referral_joined',
            jsonb_build_object('name', (select name from public.organizations where id = new.referred_org_id),
                               'type', (select type from public.organizations where id = new.referred_org_id)));
  end if;
  return new;
end $$;
create trigger referrals_notify after insert on public.referrals
  for each row execute function public.notify_on_referral();

/* ================= Order ingestion: LINKUP LAUNCH campaign rate ================= */
-- Same as the implied-VAT version, plus: when the creator participates in a live campaign of this store
-- covering the order date, the higher campaign rate applies to the whole order (decision D8).
create or replace function public.ingest_order_event(p_connection uuid, p_event jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.store_connections;
  o jsonb := p_event -> 'order';
  v_evt uuid; v_occ timestamptz; v_created timestamptz;
  v_total bigint; v_tax bigint; v_ship bigint; v_ship_tax bigint; v_base bigint;
  v_status text; v_ref text; v_ref_code text; v_ref_at timestamptz;
  v_order public.orders; v_attr public.attributions; v_code public.partner_codes; v_ver public.agreement_versions;
  v_method text; v_c text; v_fee int; v_self boolean; v_founders timestamptz; v_store_fee int;
  v_eff bigint; v_r jsonb; v_new_attr boolean := false;
  v_creator uuid; v_camp uuid; v_camp_bps int; v_rate int;
begin
  select * into v_conn from public.store_connections where id = p_connection;
  if not found then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_conn.status = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;

  if coalesce(p_event ->> 'event_id', '') = '' or o is null or coalesce(o ->> 'id', '') = ''
     or coalesce(o ->> 'currency', '') !~ '^[A-Z]{3}$' then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  begin
    v_total := (o ->> 'total')::bigint; v_tax := coalesce((o ->> 'tax')::bigint, 0);
    v_ship := coalesce((o ->> 'shipping')::bigint, 0); v_ship_tax := coalesce((o ->> 'shipping_tax')::bigint, 0);
    v_occ := (p_event ->> 'occurred_at')::timestamptz;
    v_created := coalesce((o ->> 'created_at')::timestamptz, v_occ);
  exception when others then
    raise exception 'invalid_event' using errcode = '22023';
  end;
  if v_total is null or v_total < 0 or v_tax < 0 or v_ship < 0 or v_ship_tax < 0 or v_occ is null then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  if v_occ > now() + interval '1 day' then raise exception 'invalid_event' using errcode = '22023'; end if;

  insert into public.order_events(connection_id, event_id, external_order_id, event_type, occurred_at, payload)
  values (p_connection, left(p_event ->> 'event_id', 200), left(o ->> 'id', 64),
          left(coalesce(p_event ->> 'type', 'order.upserted'), 40), v_occ, p_event)
  on conflict (connection_id, event_id) do nothing
  returning id into v_evt;
  if v_evt is null then return json_build_object('status', 'duplicate'); end if;

  v_status := lower(coalesce(o ->> 'status', 'pending'));
  v_base := public.commission_base_minor(v_conn.org_id, o ->> 'currency', v_total, v_tax, v_ship, v_ship_tax);
  v_ref := coalesce(o ->> 'ref', '');
  if v_ref ~ '^[A-Za-z0-9]{4,16}\|[0-9]{9,11}$' then
    v_ref_code := split_part(v_ref, '|', 1);
    v_ref_at := to_timestamp(split_part(v_ref, '|', 2)::double precision);
  end if;

  insert into public.orders as ord (connection_id, store_org_id, external_order_id, currency, status, total_minor,
                                    base_minor, coupon_codes, ref_code, ref_at, customer_email_hash,
                                    order_created_at, completed_at, last_event_at)
  values (p_connection, v_conn.org_id, left(o ->> 'id', 64), o ->> 'currency', v_status, v_total, v_base,
          coalesce((select array_agg(left(x, 64)) from jsonb_array_elements_text(coalesce(o -> 'coupons', '[]'::jsonb)) x), '{}'),
          v_ref_code, v_ref_at, nullif(o ->> 'email_hash', ''), v_created,
          case when v_status = 'completed' then v_occ end, v_occ)
  on conflict (connection_id, external_order_id) do update set
    status       = case when excluded.last_event_at >= ord.last_event_at then excluded.status else ord.status end,
    total_minor  = case when excluded.last_event_at >= ord.last_event_at then excluded.total_minor else ord.total_minor end,
    base_minor   = case when excluded.last_event_at >= ord.last_event_at then excluded.base_minor else ord.base_minor end,
    currency     = case when excluded.last_event_at >= ord.last_event_at then excluded.currency else ord.currency end,
    coupon_codes = case when excluded.last_event_at >= ord.last_event_at then excluded.coupon_codes else ord.coupon_codes end,
    ref_code     = coalesce(ord.ref_code, excluded.ref_code),
    ref_at       = coalesce(ord.ref_at, excluded.ref_at),
    customer_email_hash = coalesce(ord.customer_email_hash, excluded.customer_email_hash),
    completed_at = coalesce(ord.completed_at, excluded.completed_at),
    last_event_at = greatest(ord.last_event_at, excluded.last_event_at)
  returning * into v_order;

  for v_r in select * from jsonb_array_elements(
      coalesce(o -> 'refunds', '[]'::jsonb) || case when p_event ? 'refund' then jsonb_build_array(p_event -> 'refund') else '[]'::jsonb end)
  loop
    if coalesce(v_r ->> 'id', '') <> '' and (v_r ->> 'amount') ~ '^-?[0-9]+$' then
      insert into public.refunds(order_id, external_refund_id, amount_minor)
      values (v_order.id, left(v_r ->> 'id', 64), abs((v_r ->> 'amount')::bigint))
      on conflict (order_id, external_refund_id) do nothing;
    end if;
  end loop;
  update public.orders set refunded_minor = least(total_minor,
           (select coalesce(sum(amount_minor), 0) from public.refunds where order_id = v_order.id))
   where id = v_order.id returning * into v_order;

  select * into v_attr from public.attributions where order_id = v_order.id;
  if not found and v_order.status in ('processing', 'completed', 'on-hold') then
    foreach v_c in array v_order.coupon_codes loop
      select pc.* into v_code from public.partner_codes pc join public.agreements a on a.id = pc.agreement_id
       where lower(pc.code) = lower(v_c) and pc.active and a.status = 'active' and a.store_org_id = v_conn.org_id;
      if found then v_method := 'coupon'; exit; end if;
    end loop;
    if v_method is null and v_order.ref_code is not null then
      select pc.* into v_code from public.partner_codes pc join public.agreements a on a.id = pc.agreement_id
       where lower(pc.code) = lower(v_order.ref_code) and pc.active and a.status = 'active' and a.store_org_id = v_conn.org_id;
      if found then v_method := 'link'; end if;
    end if;
    if v_method is not null then
      select * into v_ver from public.agreement_versions
       where agreement_id = v_code.agreement_id and effective_from <= v_order.order_created_at + interval '10 minutes'
       order by version desc limit 1;
      if not found then
        v_method := null;
      elsif v_method = 'link' and (v_order.ref_at is null
              or v_order.ref_at > v_order.order_created_at + interval '5 minutes'
              or v_order.order_created_at - v_order.ref_at > make_interval(days => v_ver.attribution_days)) then
        v_method := null;
      end if;
    end if;

    if v_method is not null then
      select creator_org_id into v_creator from public.agreements where id = v_code.agreement_id;
      v_self := v_order.customer_email_hash is not null and exists (
        select 1 from public.memberships m join auth.users u on u.id = m.user_id
         where m.org_id = v_creator
           and encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = v_order.customer_email_hash);
      select founders_until, platform_fee_bps into v_founders, v_store_fee from public.organizations where id = v_conn.org_id;
      v_fee := coalesce(v_store_fee,
                 case when v_founders is not null and v_order.order_created_at < v_founders
                      then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end);
      -- LINKUP LAUNCH: best live campaign of this store the creator takes part in, covering the order date.
      select op.id, op.commission_bps into v_camp, v_camp_bps
        from public.opportunities op join public.opportunity_applications ap on ap.opportunity_id = op.id
       where op.store_org_id = v_conn.org_id and op.kind = 'campaign' and op.status in ('live', 'ended')
         and ap.creator_org_id = v_creator and ap.status = 'approved'
         and v_order.order_created_at >= op.starts_at and v_order.order_created_at < op.ends_at
       order by op.commission_bps desc limit 1;
      v_rate := greatest(v_ver.commission_bps, coalesce(v_camp_bps, 0));
      if v_camp_bps is null or v_camp_bps <= v_ver.commission_bps then v_camp := null; end if;

      insert into public.attributions(order_id, agreement_version_id, partner_code_id, store_org_id, creator_org_id,
                                      method, commission_bps, platform_fee_bps, self_referral_suspected, evidence,
                                      campaign_id, base_commission_bps)
      select v_order.id, v_ver.id, v_code.id, a.store_org_id, a.creator_org_id, v_method, v_rate, v_fee,
             v_self, jsonb_build_object('code', v_code.code, 'coupons', to_jsonb(v_order.coupon_codes),
                                        'ref_code', v_order.ref_code, 'ref_at', v_order.ref_at),
             v_camp, v_ver.commission_bps
        from public.agreements a where a.id = v_code.agreement_id
      returning * into v_attr;
      v_new_attr := true;
      if not exists (select 1 from public.attributions where store_org_id = v_attr.store_org_id and id <> v_attr.id) then
        insert into public.funnel_events(event, org_id) values ('first_attributed_sale', v_attr.store_org_id);
      end if;
    end if;
  end if;

  if v_attr.id is not null then
    v_eff := public.effective_base_minor(v_order.status, v_order.total_minor, v_order.base_minor, v_order.refunded_minor);
    perform public.ledger_settle(v_attr, 'creator', v_attr.creator_org_id,
                                 round(v_eff::numeric * v_attr.commission_bps / 10000)::bigint, v_order.currency, v_evt);
    perform public.ledger_settle(v_attr, 'platform', null,
                                 round(v_eff::numeric * v_attr.platform_fee_bps / 10000)::bigint, v_order.currency, v_evt);
  end if;

  update public.order_events set processed_at = now() where id = v_evt;
  return json_build_object('status', 'processed', 'order_id', v_order.id,
                           'attributed', v_attr.id is not null, 'new_attribution', v_new_attr);
end $$;

/* ================= Approval: refunds after approval must also settle ================= */
-- Previously a reversal for an order refunded/cancelled after approval stayed 'pending' forever (order no longer
-- 'completed'), so it never reached billing. Negative corrections are approved as soon as the line they correct
-- was approved; positive lines still wait for completion + refund hold.
create or replace function public.approve_matured_commissions() returns int
language plpgsql security definer set search_path = '' as $$
declare n int; m int;
begin
  update public.commission_ledger l set state = 'approved', approved_at = now()
    from public.attributions a, public.orders o, public.agreement_versions v
   where l.state = 'pending' and a.id = l.attribution_id and o.id = a.order_id and v.id = a.agreement_version_id
     and o.status = 'completed' and o.completed_at is not null
     and o.completed_at + make_interval(days => v.refund_hold_days) <= now();
  get diagnostics n = row_count;
  update public.commission_ledger l set state = 'approved', approved_at = now()
   where l.state = 'pending' and l.amount_minor < 0
     and exists (select 1 from public.commission_ledger x where x.attribution_id = l.attribution_id
                   and x.party_role = l.party_role and x.state = 'approved' and x.id <> l.id);
  get diagnostics m = row_count;
  perform public.settle_reward_reversals();
  return n + m;
end $$;

/* ================= Store billing (monthly payment requests) ================= */
-- LINKUP does not move order money. Each month the store receives a payment request for the LINKUP fee on
-- approved (post refund-hold) sales. The legal tax document is issued by the payment provider (Grow) on payment.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity,
  store_org_id uuid not null references public.organizations(id),
  period_start date not null,
  currency char(3) not null,
  fees_minor bigint not null,
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  status text not null default 'issued' check (status in ('issued', 'paid', 'void')),
  issued_at timestamptz not null default now(),
  due_at timestamptz not null default now() + interval '14 days',
  paid_at timestamptz,
  paid_reference text check (char_length(paid_reference) <= 120),
  check (fees_minor > 0 and total_minor = fees_minor - credit_minor)
);
create unique index invoices_period_uq on public.invoices(store_org_id, period_start, currency) where status <> 'void';

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  ledger_id uuid not null unique references public.commission_ledger(id),
  amount_minor bigint not null
);
create index invoice_items_invoice_idx on public.invoice_items(invoice_id);

/* ================= FOUNDING PARTNERS rewards & wallet ================= */
create table public.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references public.referrals(id),
  referrer_org_id uuid not null references public.organizations(id),
  invoice_item_id uuid references public.invoice_items(id),
  ledger_id uuid not null references public.commission_ledger(id),
  attribution_id uuid not null references public.attributions(id),
  share_bps int not null check (share_bps between 0 and 5000),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index referral_rewards_referrer_idx on public.referral_rewards(referrer_org_id, created_at);
create trigger referral_rewards_append_only before update or delete on public.referral_rewards
  for each row execute function public.forbid_change();

create table public.reward_payouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  currency char(3) not null,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null check (method in ('invoice_credit', 'transfer')),
  invoice_id uuid references public.invoices(id),
  reference text check (char_length(reference) <= 120),
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((method = 'invoice_credit') = (invoice_id is not null))
);
create index reward_payouts_org_idx on public.reward_payouts(org_id);

create function public.wallet_balance_minor(p_org uuid, p_currency text) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(amount_minor) from public.referral_rewards where referrer_org_id = p_org and currency = p_currency), 0)
       - coalesce((select sum(amount_minor) from public.reward_payouts where org_id = p_org and currency = p_currency), 0);
$$;

-- First qualifying sale of an activity (as store or as creator); self-referral-suspected sales don't count.
create function public.first_sale_at(p_org uuid, p_after timestamptz) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select min(o.order_created_at) from public.attributions a join public.orders o on o.id = a.order_id
   where (a.store_org_id = p_org or a.creator_org_id = p_org) and not a.self_referral_suspected
     and o.order_created_at >= p_after
     and public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor) > 0;
$$;

-- Who earns from a given sale, and what share of the LINKUP fee.
-- Each party (store, creator) may have one referrer. A referrer earns only within 90 days from the referred
-- party's first qualifying sale, which must happen within 12 months of the referral. A referrer who is a party
-- to the deal (directly or through a shared person) earns nothing on it. Total never exceeds 40%:
-- one eligible referrer (or the same referrer on both sides) = 40%; two different eligible referrers = 20% each.
create function public.referral_shares(p_attribution uuid)
returns table (referral_id uuid, referrer_org_id uuid, share_bps int)
language plpgsql stable security definer set search_path = '' as $$
declare a public.attributions; v_sale timestamptz; v_days int := public.setting_int('referral_reward_days');
begin
  select * into a from public.attributions where id = p_attribution;
  if not found or a.self_referral_suspected then return; end if;
  select order_created_at into v_sale from public.orders where id = a.order_id;
  return query
  with cand as (
    select r.id, r.referrer_org_id, r.reward_bps, public.first_sale_at(r.referred_org_id, r.created_at) as fs, r.reward_until
      from public.referrals r
     where r.referred_org_id in (a.store_org_id, a.creator_org_id)
       and r.program = 'founding_partners' and r.status = 'active' and r.reward_bps > 0
  ), elig as (
    select c.* from cand c
     where c.fs is not null and c.fs <= c.reward_until
       and v_sale >= c.fs and v_sale < c.fs + make_interval(days => v_days)
       and not public.orgs_share_member(c.referrer_org_id, a.store_org_id)
       and not public.orgs_share_member(c.referrer_org_id, a.creator_org_id)
  ), per_ref as (
    select distinct on (e.referrer_org_id) e.id, e.referrer_org_id, e.reward_bps from elig e order by e.referrer_org_id, e.fs
  )
  select p.id, p.referrer_org_id, (p.reward_bps / (select count(*) from per_ref))::int from per_ref p;
end $$;

-- Rewards are created only from collected revenue: when an invoice is marked paid. Idempotent (one row per
-- fee line and referrer). Rounding always goes down and the split gives the remainder to the last referrer,
-- so the total never exceeds 40% of the fee line.
create function public.settle_invoice_rewards(p_invoice uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare it record; s record; n int := 0; v_total bigint; v_given bigint; v_amt bigint; v_left int; v_inserted uuid;
begin
  for it in select ii.id, ii.ledger_id, ii.amount_minor, l.attribution_id, i.currency
              from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
              join public.commission_ledger l on l.id = ii.ledger_id
             where ii.invoice_id = p_invoice and i.status = 'paid' loop
    select floor(it.amount_minor::numeric * coalesce(sum(x.share_bps), 0) / 10000)::bigint, count(*)
      into v_total, v_left from public.referral_shares(it.attribution_id) x;
    v_given := 0;
    for s in select * from public.referral_shares(it.attribution_id) order by referrer_org_id loop
      v_left := v_left - 1;
      v_amt := case when v_left = 0 then v_total - v_given
                    else floor(it.amount_minor::numeric * s.share_bps / 10000)::bigint end;
      v_given := v_given + v_amt;
      continue when v_amt = 0;
      v_inserted := null;
      insert into public.referral_rewards(referral_id, referrer_org_id, invoice_item_id, ledger_id, attribution_id, share_bps,
                                          amount_minor, currency, idempotency_key)
      values (s.referral_id, s.referrer_org_id, it.id, it.ledger_id, it.attribution_id, s.share_bps, v_amt, it.currency,
              'led:' || it.ledger_id::text || ':' || s.referrer_org_id::text)
      on conflict (idempotency_key) do nothing
      returning id into v_inserted;
      if v_inserted is not null then
        n := n + 1;
        if not exists (select 1 from public.referral_rewards where referrer_org_id = s.referrer_org_id and id <> v_inserted) then
          insert into public.notifications(org_id, kind, payload) values (s.referrer_org_id, 'first_reward', '{}');
          insert into public.funnel_events(event, org_id) values ('reward_earned', s.referrer_org_id);
        end if;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- A refund after a reward was paid out is reversed as soon as its correcting fee line is approved — it does not
-- wait for a future (possibly never paid) invoice. Mirrors the shares actually used, never below zero per sale.
create function public.settle_reward_reversals() returns int
language plpgsql security definer set search_path = '' as $$
declare l record; r record; n int := 0; v_amt bigint; v_net bigint;
begin
  for l in select cl.* from public.commission_ledger cl
            where cl.party_role = 'platform' and cl.state = 'approved' and cl.amount_minor < 0
              and exists (select 1 from public.referral_rewards rr where rr.attribution_id = cl.attribution_id)
              and not exists (select 1 from public.referral_rewards rr where rr.ledger_id = cl.id) loop
    for r in select rr.referral_id, rr.referrer_org_id, max(rr.share_bps) as share_bps, sum(rr.amount_minor) as net, max(rr.currency) as currency
               from public.referral_rewards rr where rr.attribution_id = l.attribution_id
              group by rr.referral_id, rr.referrer_org_id loop
      v_net := r.net;
      v_amt := greatest(floor(l.amount_minor::numeric * r.share_bps / 10000)::bigint, -v_net);
      continue when v_amt >= 0;
      insert into public.referral_rewards(referral_id, referrer_org_id, invoice_item_id, ledger_id, attribution_id, share_bps,
                                          amount_minor, currency, idempotency_key)
      values (r.referral_id, r.referrer_org_id, null, l.id, l.attribution_id, r.share_bps, v_amt, r.currency,
              'led:' || l.id::text || ':' || r.referrer_org_id::text)
      on conflict (idempotency_key) do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- Monthly run (platform admin or cron). Idempotent per store/period/currency.
create function public.run_invoice_generation(p_period_start date) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_inv uuid; v_end timestamptz; v_credit bigint; n int := 0;
begin
  if p_period_start <> date_trunc('month', p_period_start)::date then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_end := (p_period_start + interval '1 month')::timestamptz;
  if v_end > now() then raise exception 'period_not_closed' using errcode = '22023'; end if;
  for r in select l.store_org_id, l.currency, sum(l.amount_minor) as fees
             from public.commission_ledger l
            where l.party_role = 'platform' and l.state = 'approved' and l.approved_at < v_end
              and not exists (select 1 from public.invoice_items ii where ii.ledger_id = l.id)
            group by l.store_org_id, l.currency
           having sum(l.amount_minor) > 0 loop
    continue when exists (select 1 from public.invoices where store_org_id = r.store_org_id and period_start = p_period_start
                                                          and currency = r.currency and status <> 'void');
    perform 1 from public.organizations where id = r.store_org_id for update;   -- serialises with reward transfers
    v_credit := least(r.fees, greatest(0, public.wallet_balance_minor(r.store_org_id, r.currency)));
    insert into public.invoices(store_org_id, period_start, currency, fees_minor, credit_minor, total_minor, status, paid_at)
    values (r.store_org_id, p_period_start, r.currency, r.fees, v_credit, r.fees - v_credit,
            case when r.fees - v_credit = 0 then 'paid' else 'issued' end,
            case when r.fees - v_credit = 0 then now() end)
    returning id into v_inv;
    insert into public.invoice_items(invoice_id, ledger_id, amount_minor)
    select v_inv, l.id, l.amount_minor from public.commission_ledger l
     where l.store_org_id = r.store_org_id and l.currency = r.currency and l.party_role = 'platform'
       and l.state = 'approved' and l.approved_at < v_end
       and not exists (select 1 from public.invoice_items ii where ii.ledger_id = l.id);
    if v_credit > 0 then
      insert into public.reward_payouts(org_id, currency, amount_minor, method, invoice_id)
      values (r.store_org_id, r.currency, v_credit, 'invoice_credit', v_inv);
    end if;
    if r.fees - v_credit = 0 then perform public.settle_invoice_rewards(v_inv); end if;
    insert into public.notifications(org_id, kind, payload)
    values (r.store_org_id, 'invoice_issued', jsonb_build_object('invoice_id', v_inv));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Platform-admin entry point (the scheduled job calls run_invoice_generation directly).
create function public.generate_invoices(p_period_start date) returns int
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return public.run_invoice_generation(p_period_start);
end $$;

create function public.mark_invoice_paid(p_invoice uuid, p_reference text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_n int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.invoices set status = 'paid', paid_at = now(), paid_reference = nullif(btrim(coalesce(p_reference, '')), '')
   where id = p_invoice and status = 'issued' returning store_org_id into v_store;
  if v_store is null then raise exception 'invoice_not_payable' using errcode = '22023'; end if;
  v_n := public.settle_invoice_rewards(p_invoice);
  insert into public.funnel_events(event, org_id) values ('invoice_paid', v_store);
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), v_store, 'invoice.paid', p_invoice::text);
  return v_n;
end $$;

-- Void an unpaid request (e.g. issued by mistake). Its fee lines return to the pool for the next run.
create function public.void_invoice(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.invoices set status = 'void' where id = p_invoice and status = 'issued' returning store_org_id into v_store;
  if v_store is null then raise exception 'invoice_not_voidable' using errcode = '22023'; end if;
  delete from public.reward_payouts where invoice_id = p_invoice;
  delete from public.invoice_items where invoice_id = p_invoice;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), v_store, 'invoice.voided', p_invoice::text);
end $$;

create function public.record_reward_transfer(p_org uuid, p_currency text, p_reference text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_bal bigint;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = p_org for update;
  v_bal := public.wallet_balance_minor(p_org, p_currency);
  if v_bal < public.setting_int('reward_transfer_min_minor') then raise exception 'below_minimum' using errcode = '22023'; end if;
  insert into public.reward_payouts(org_id, currency, amount_minor, method, reference, created_by)
  values (p_org, p_currency, v_bal, 'transfer', nullif(btrim(coalesce(p_reference, '')), ''), auth.uid());
  insert into public.notifications(org_id, kind, payload) values (p_org, 'reward_paid', '{}');
  insert into public.audit_events(actor_user_id, org_id, action, details)
  values (auth.uid(), p_org, 'reward.transferred', jsonb_build_object('amount_minor', v_bal, 'currency', p_currency));
  return v_bal;
end $$;

-- The user's FOUNDING PARTNERS view across all their activities. Never exposes sales volume or customers.
create function public.my_wallet() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'program_open', public.setting_bool('founding_partners_open'),
    'reward_bps', public.setting_int('referral_reward_bps'),
    'reward_days', public.setting_int('referral_reward_days'),
    'transfer_min_minor', public.setting_int('reward_transfer_min_minor'),
    'activities', coalesce((select json_agg(json_build_object(
        'org_id', o.id, 'name', o.name, 'type', o.type, 'referral_code', o.referral_code,
        'balance_minor', public.wallet_balance_minor(o.id, 'ILS'),
        'earned_minor', coalesce((select sum(amount_minor) from public.referral_rewards where referrer_org_id = o.id and currency = 'ILS'), 0),
        'paid_minor', coalesce((select sum(amount_minor) from public.reward_payouts where org_id = o.id and currency = 'ILS'), 0))
        order by o.created_at)
      from public.organizations o join public.memberships m on m.org_id = o.id
     where m.user_id = auth.uid() and m.role in ('owner', 'admin')), '[]'),
    'referrals', coalesce((select json_agg(json_build_object(
        'name', ro.name, 'type', ro.type, 'joined_at', r.created_at, 'via', r.referrer_org_id,
        'state', case when r.status = 'blocked' or r.program <> 'founding_partners' then 'not_eligible'
                      when public.first_sale_at(ro.id, r.created_at) is null and r.reward_until < now() then 'expired'
                      when public.first_sale_at(ro.id, r.created_at) is null then 'waiting_first_sale'
                      when public.first_sale_at(ro.id, r.created_at) > r.reward_until then 'expired'
                      when public.first_sale_at(ro.id, r.created_at) + make_interval(days => public.setting_int('referral_reward_days')) > now() then 'earning'
                      else 'completed' end,
        'earning_until', public.first_sale_at(ro.id, r.created_at) + make_interval(days => public.setting_int('referral_reward_days')),
        'first_sale_deadline', r.reward_until,
        'earned_minor', coalesce((select sum(rr.amount_minor) from public.referral_rewards rr where rr.referral_id = r.id), 0))
        order by r.created_at desc)
      from public.referrals r join public.organizations ro on ro.id = r.referred_org_id
     where exists (select 1 from public.memberships m where m.org_id = r.referrer_org_id and m.user_id = auth.uid()
                     and m.role in ('owner', 'admin'))), '[]'))
  where auth.uid() is not null;
$$;

/* ================= Creator payout tracking (store pays the creator directly) ================= */
create table public.creator_payouts (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  creator_org_id uuid not null references public.organizations(id),
  currency char(3) not null,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null default 'bank_transfer' check (method in ('bank_transfer', 'bit', 'paybox', 'credit', 'other')),
  reference text check (char_length(reference) <= 120),
  marked_by uuid,
  paid_at timestamptz not null default now(),
  creator_status text not null default 'awaiting' check (creator_status in ('awaiting', 'confirmed', 'disputed')),
  creator_responded_at timestamptz
);
create index creator_payouts_pair_idx on public.creator_payouts(store_org_id, creator_org_id);

create table public.creator_payout_items (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.creator_payouts(id),
  ledger_id uuid not null unique references public.commission_ledger(id),
  amount_minor bigint not null
);
create index creator_payout_items_payout_idx on public.creator_payout_items(payout_id);
create trigger creator_payout_items_append_only before update or delete on public.creator_payout_items
  for each row execute function public.forbid_change();

-- Store marks "I paid this creator everything approved so far". Negative lines (refunds after payment) net off.
create function public.record_creator_payout(p_store uuid, p_creator uuid, p_method text, p_reference text,
                                             p_currency text default 'ILS') returns json
language plpgsql security definer set search_path = '' as $$
declare v_sum bigint; v_id uuid;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = p_store for update;
  select coalesce(sum(l.amount_minor), 0) into v_sum from public.commission_ledger l
   where l.store_org_id = p_store and l.party_org_id = p_creator and l.party_role = 'creator'
     and l.state = 'approved' and l.currency = p_currency
     and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id);
  if v_sum <= 0 then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  insert into public.creator_payouts(store_org_id, creator_org_id, currency, amount_minor, method, reference, marked_by)
  values (p_store, p_creator, p_currency, v_sum, coalesce(p_method, 'bank_transfer'),
          nullif(btrim(coalesce(p_reference, '')), ''), auth.uid())
  returning id into v_id;
  insert into public.creator_payout_items(payout_id, ledger_id, amount_minor)
  select v_id, l.id, l.amount_minor from public.commission_ledger l
   where l.store_org_id = p_store and l.party_org_id = p_creator and l.party_role = 'creator'
     and l.state = 'approved' and l.currency = p_currency
     and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id);
  insert into public.notifications(org_id, kind, payload)
  values (p_creator, 'payout_marked', jsonb_build_object('payout_id', v_id, 'store', (select name from public.organizations where id = p_store)));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'creator_payout.recorded', v_id::text, jsonb_build_object('amount_minor', v_sum));
  return json_build_object('payout_id', v_id, 'amount_minor', v_sum);
end $$;

create function public.respond_creator_payout(p_payout uuid, p_confirm boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.creator_payouts;
begin
  select * into p from public.creator_payouts where id = p_payout for update;
  if not found or not public.is_admin(p.creator_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p.creator_status <> 'awaiting' then raise exception 'already_responded' using errcode = '22023'; end if;
  update public.creator_payouts set creator_status = case when p_confirm then 'confirmed' else 'disputed' end,
         creator_responded_at = now() where id = p_payout;
  insert into public.notifications(org_id, kind, payload)
  values (p.store_org_id, case when p_confirm then 'payout_confirmed' else 'payout_disputed' end,
          jsonb_build_object('payout_id', p.id, 'creator', (select name from public.organizations where id = p.creator_org_id)));
end $$;

-- Per-partner balances for a store (or per-store balances for a creator).
create function public.payout_balances(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_type text;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select type into v_type from public.organizations where id = p_org;
  return coalesce((select json_agg(x order by x.approved_unpaid_minor desc) from (
    select case when v_type = 'store' then l.party_org_id else l.store_org_id end as other_org_id,
           (select name from public.organizations where id = case when v_type = 'store' then l.party_org_id else l.store_org_id end) as other_name,
           l.currency,
           sum(l.amount_minor) filter (where l.state = 'pending') as pending_minor,
           coalesce(sum(l.amount_minor) filter (where l.state = 'approved'
                    and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)), 0) as approved_unpaid_minor,
           coalesce(sum(l.amount_minor) filter (where exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)), 0) as paid_minor
      from public.commission_ledger l
     where l.party_role = 'creator' and ((v_type = 'store' and l.store_org_id = p_org) or (v_type <> 'store' and l.party_org_id = p_org))
     group by 1, 2, 3) x), '[]');
end $$;

/* ================= Funnel ================= */
alter table public.funnel_events drop constraint if exists funnel_events_event_check;
alter table public.funnel_events add constraint funnel_events_event_check check (event in (
  'invite_sent', 'invite_opened', 'proposal_accepted', 'proposal_rejected', 'store_connected', 'first_attributed_sale',
  'signup', 'activity_added', 'referral_signup', 'products_synced', 'opportunity_published', 'opportunity_joined',
  'campaign_launched', 'creative_shared', 'referral_link_shared', 'invoice_paid', 'reward_earned'));

-- Client-reported share actions (rate-limited). Everything else is recorded server-side.
create function public.track_event(p_org uuid, p_event text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_event not in ('creative_shared', 'referral_link_shared') then raise exception 'invalid_event' using errcode = '22023'; end if;
  if (select count(*) from public.funnel_events where org_id = p_org and occurred_at > now() - interval '1 hour') > 200 then return; end if;
  insert into public.funnel_events(event, org_id) values (p_event, p_org);
end $$;

/* ================= Dashboard: staff (role member) never receive money figures ================= */
alter function public.org_dashboard(uuid) rename to org_dashboard_full;
create function public.org_dashboard(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare d jsonb;
begin
  d := public.org_dashboard_full(p_org)::jsonb;   -- checks membership
  if public.is_admin(p_org) then return d::json; end if;
  d := d - array['pending_commissions_minor', 'approved_commissions_minor', 'month_platform_fee_minor',
                 'month_earnings_minor', 'pending_minor', 'approved_minor', 'fee_bps'];
  if d ? 'recent_sales' then
    d := jsonb_set(d, '{recent_sales}', coalesce((select jsonb_agg(x - 'commission_minor') from jsonb_array_elements(d -> 'recent_sales') x), '[]'));
  end if;
  return d::json;
end $$;

/* ================= Status for "next action" ================= */
create function public.org_status(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_org public.organizations;
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_org from public.organizations where id = p_org;
  return json_build_object(
    'type', v_org.type, 'name', v_org.name, 'referral_code', v_org.referral_code,
    'is_admin', public.is_admin(p_org),
    'connected', exists (select 1 from public.store_connections where org_id = p_org and status = 'connected'),
    'connection_pending', exists (select 1 from public.store_connections where org_id = p_org and status = 'pending'),
    'products', (select count(*) from public.products where store_org_id = p_org and status = 'active'),
    'standing_live', exists (select 1 from public.opportunities where store_org_id = p_org and kind = 'standing' and status = 'live'),
    'live_campaigns', (select count(*) from public.opportunities where store_org_id = p_org and kind = 'campaign' and status = 'live' and ends_at > now()),
    'partners', (select count(*) from public.agreements where (store_org_id = p_org or creator_org_id = p_org) and status = 'active'),
    'pending_applications', (select count(*) from public.opportunity_applications ap join public.opportunities o on o.id = ap.opportunity_id
                              where o.store_org_id = p_org and ap.status = 'pending'),
    'proposals_sent', (select count(*) from public.proposals where from_org_id = p_org),
    'sales', (select count(*) from public.attributions where store_org_id = p_org or creator_org_id = p_org),
    'referrals', (select count(*) from public.referrals where referrer_org_id = p_org),
    'unread', (select count(*) from public.notifications where org_id = p_org and read_at is null),
    'open_invoices', case when public.is_admin(p_org) then (select count(*) from public.invoices where store_org_id = p_org and status = 'issued') else 0 end,
    'payouts_to_confirm', case when public.is_admin(p_org) then (select count(*) from public.creator_payouts where creator_org_id = p_org and creator_status = 'awaiting') else 0 end,
    'approved_unpaid_minor', case when not public.is_admin(p_org) then 0 else (select coalesce(sum(l.amount_minor), 0) from public.commission_ledger l
                               where l.party_role = 'creator' and l.state = 'approved'
                                 and (l.store_org_id = p_org or l.party_org_id = p_org)
                                 and not exists (select 1 from public.creator_payout_items i where i.ledger_id = l.id)) end);
end $$;

/* ================= Platform admin views ================= */
create function public.admin_overview() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'funnel', (select json_object_agg(event, json_build_object('total', total, 'last_30d', recent)) from (
                 select event, count(*) as total, count(*) filter (where occurred_at > now() - interval '30 days') as recent
                   from public.funnel_events group by event) f),
    'stores', (select count(*) from public.organizations where type = 'store'),
    'creators', (select count(*) from public.organizations where type = 'creator'),
    'connected_stores', (select count(distinct org_id) from public.store_connections where status = 'connected'),
    'silent_connections', coalesce((select json_agg(json_build_object('org', o.name, 'site_url', c.site_url, 'last_sync_at', c.last_sync_at))
                            from public.store_connections c join public.organizations o on o.id = c.org_id
                           where c.status = 'connected' and (c.last_sync_at is null or c.last_sync_at < now() - interval '24 hours')), '[]'),
    'attributed_sales_30d', (select count(*) from public.attributions where created_at > now() - interval '30 days'),
    'platform_fees_pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and state = 'pending'),
    'platform_fees_uninvoiced_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger l where party_role = 'platform' and state = 'approved'
                                         and not exists (select 1 from public.invoice_items i where i.ledger_id = l.id)),
    'invoices_open_minor', (select coalesce(sum(total_minor), 0) from public.invoices where status = 'issued'),
    'invoices_paid_minor', (select coalesce(sum(total_minor), 0) from public.invoices where status = 'paid'),
    'rewards_earned_minor', (select coalesce(sum(amount_minor), 0) from public.referral_rewards),
    'rewards_owed', coalesce((select json_agg(x) from (
        select o.id as org_id, o.name, public.wallet_balance_minor(o.id, 'ILS') as balance_minor
          from public.organizations o where public.wallet_balance_minor(o.id, 'ILS') > 0) x), '[]'),
    'suspected_self_referrals', (select count(*) from public.attributions where self_referral_suspected),
    'blocked_referrals', (select count(*) from public.referrals where status = 'blocked'),
    'invoices', coalesce((select json_agg(x order by x.issued_at desc) from (
        select i.id, i.number, o.name as store, i.period_start, i.currency, i.fees_minor, i.credit_minor, i.total_minor,
               i.status, i.issued_at, i.paid_at, i.paid_reference
          from public.invoices i join public.organizations o on o.id = i.store_org_id
         order by i.issued_at desc limit 100) x), '[]'),
    'recent_orgs', coalesce((select json_agg(x order by x.created_at desc) from (
        select o.id, o.name, o.type, o.created_at,
               exists (select 1 from public.store_connections c where c.org_id = o.id and c.status = 'connected') as connected,
               (select count(*) from public.agreements a where a.store_org_id = o.id or a.creator_org_id = o.id) as partners,
               (select count(*) from public.attributions a where a.store_org_id = o.id or a.creator_org_id = o.id) as sales,
               (select ro.name from public.referrals r join public.organizations ro on ro.id = r.referrer_org_id where r.referred_org_id = o.id) as referred_by
          from public.organizations o order by o.created_at desc limit 100) x), '[]'),
    'settings', (select json_object_agg(key, value) from public.app_settings));
end $$;

create function public.admin_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key not in ('founding_partners_open', 'reward_transfer_min_minor', 'max_proposals_per_day') then
    raise exception 'setting_locked' using errcode = '42501';   -- pricing & reward terms change only by migration (explicit decision)
  end if;
  if (p_key = 'founding_partners_open' and jsonb_typeof(p_value) <> 'boolean')
     or (p_key <> 'founding_partners_open' and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0
         or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric))) then
    raise exception 'invalid_setting' using errcode = '22023';
  end if;
  update public.app_settings set value = p_value where key = p_key;
  insert into public.audit_events(actor_user_id, action, target, details)
  values (auth.uid(), 'setting.changed', p_key, jsonb_build_object('value', p_value));
end $$;

/* ================= Public (anon) helpers for landing pages ================= */
-- Up to 6 real live opportunities with one in-stock product each. Never returns anything not already public
-- on the store's own site (store name, product name/image/price) plus the published commission terms.
create function public.public_catalog_preview() returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x), '[]') from (
    select o.kind, o.commission_bps, o.coupon_discount_pct, o.ends_at, s.name as store_name,
           p.name as product_name, p.image_url, p.price_minor, p.currency
      from public.opportunities o join public.organizations s on s.id = o.store_org_id
      join lateral (select * from public.products p where p.store_org_id = s.id and p.status = 'active' and p.in_stock
                       and p.image_url is not null order by p.synced_at desc limit 1) p on true
     where o.status = 'live' and (o.ends_at is null or o.ends_at > now())
       and exists (select 1 from public.store_connections c where c.org_id = s.id and c.status = 'connected')
     order by o.kind = 'campaign' desc, o.created_at desc limit 6) x;
$$;

-- Referral codes are only resolved for signed-in users, with per-user limits, so codes can't be enumerated:
-- at most 30 lookups and 5 unknown codes per hour. The public /join link never reveals whether a code exists.
create table public.lookup_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index lookup_attempts_user_idx on public.lookup_attempts(user_id, kind, at);
alter table public.lookup_attempts enable row level security;   -- no client policies: internal only

create function public.resolve_referral_code(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if (select count(*) from public.lookup_attempts where user_id = v_uid and kind = 'ref' and at > now() - interval '1 hour') >= 30
     or (select count(*) from public.lookup_attempts where user_id = v_uid and kind = 'ref' and not ok and at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  if p_code ~ '^[A-Za-z0-9]{6,12}$' then
    select id into v_id from public.organizations where lower(referral_code) = lower(p_code);
  end if;
  insert into public.lookup_attempts(user_id, kind, ok) values (v_uid, 'ref', v_id is not null);
  delete from public.lookup_attempts where at < now() - interval '2 days' and user_id = v_uid;
  return v_id;
end $$;

create function public.referrer_name(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  v_id := public.resolve_referral_code(p_code);
  return (select name from public.organizations where id = v_id);
end $$;

/* ================= RLS for new tables ================= */
alter table public.platform_admins enable row level security;
alter table public.team_invites enable row level security;
alter table public.products enable row level security;
alter table public.opportunities enable row level security;
alter table public.opportunity_applications enable row level security;
alter table public.notifications enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.referral_rewards enable row level security;
alter table public.reward_payouts enable row level security;
alter table public.creator_payouts enable row level security;
alter table public.creator_payout_items enable row level security;

create policy platform_admin_self on public.platform_admins for select to authenticated using (user_id = auth.uid());
create policy team_invite_read on public.team_invites for select to authenticated using (public.is_admin(org_id));
create policy product_read on public.products for select to authenticated using (
  public.is_member(store_org_id)
  or exists (select 1 from public.agreements a where a.store_org_id = products.store_org_id and a.status = 'active' and public.is_member(a.creator_org_id))
  or exists (select 1 from public.opportunities o where o.store_org_id = products.store_org_id and o.status = 'live')
);
-- Definer helpers avoid policy recursion between opportunities and applications.
create function public.member_applied_to(p_opportunity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.opportunity_applications ap
                  where ap.opportunity_id = p_opportunity and public.is_member(ap.creator_org_id));
$$;
create function public.opportunity_store(p_opportunity uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select store_org_id from public.opportunities where id = p_opportunity;
$$;
create policy opportunity_read on public.opportunities for select to authenticated using (
  public.is_member(store_org_id) or status = 'live' or public.member_applied_to(id)
);
create policy opp_app_read on public.opportunity_applications for select to authenticated using (
  public.is_member(creator_org_id) or public.is_member(public.opportunity_store(opportunity_id))
);
create policy notification_read on public.notifications for select to authenticated using (public.is_member(org_id));
create policy invoice_read on public.invoices for select to authenticated using (public.is_admin(store_org_id));
create policy invoice_item_read on public.invoice_items for select to authenticated using (
  exists (select 1 from public.invoices i where i.id = invoice_id and public.is_admin(i.store_org_id))
);
-- referral_rewards: no client access (row-level detail would reveal per-order sales of the referred party).
create policy reward_payout_read on public.reward_payouts for select to authenticated using (public.is_admin(org_id));
create policy creator_payout_read on public.creator_payouts for select to authenticated using (
  public.is_admin(store_org_id) or public.is_admin(creator_org_id)
);
create policy creator_payout_item_read on public.creator_payout_items for select to authenticated using (
  exists (select 1 from public.creator_payouts p where p.id = payout_id and (public.is_admin(p.store_org_id) or public.is_admin(p.creator_org_id)))
);

-- Ledger: members (non-admin staff) of a store no longer see money lines; admins and the earning party do.
drop policy ledger_read on public.commission_ledger;
create policy ledger_read on public.commission_ledger for select to authenticated using (
  public.is_admin(store_org_id) or (party_org_id is not null and public.is_admin(party_org_id))
);

revoke all on public.platform_admins, public.team_invites, public.products, public.opportunities,
  public.opportunity_applications, public.notifications, public.invoices, public.invoice_items,
  public.referral_rewards, public.reward_payouts, public.creator_payouts, public.creator_payout_items
  from anon, authenticated;
grant select on public.platform_admins, public.team_invites, public.products, public.opportunities,
  public.opportunity_applications, public.notifications, public.invoices, public.invoice_items,
  public.reward_payouts, public.creator_payouts, public.creator_payout_items
  to authenticated;

/* ================= Execute grants ================= */
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_member(uuid), public.is_admin(uuid), public.is_platform_admin(),
  public.member_applied_to(uuid), public.opportunity_store(uuid) to authenticated;
grant execute on function
  public.create_organization(text, text, text, text, text),
  public.update_organization(uuid, text, text, text, text, text),
  public.create_store_connection(uuid, text),
  public.create_proposal(uuid, int, text, text, int, int, text, uuid),
  public.accept_proposal(text, uuid),
  public.reject_proposal(text),
  public.org_dashboard(uuid),
  public.org_status(uuid),
  public.invite_team_member(uuid, text, text),
  public.accept_team_invite(text),
  public.org_members(uuid),
  public.set_member_role(uuid, uuid, text),
  public.remove_member(uuid, uuid),
  public.revoke_team_invite(uuid),
  public.save_standing_opportunity(uuid, text, text, int, int, boolean, text, uuid[]),
  public.create_campaign(uuid, text, text, int, timestamptz, timestamptz, uuid[]),
  public.set_opportunity_status(uuid, text),
  public.join_opportunity(uuid, uuid, text),
  public.decide_application(uuid, boolean),
  public.catalog(text, text, int),
  public.pending_applications(uuid),
  public.mark_notifications_read(uuid),
  public.my_wallet(),
  public.record_creator_payout(uuid, uuid, text, text, text),
  public.respond_creator_payout(uuid, boolean),
  public.payout_balances(uuid),
  public.track_event(uuid, text),
  public.admin_overview(),
  public.admin_set_setting(text, jsonb),
  public.generate_invoices(date),
  public.mark_invoice_paid(uuid, text),
  public.void_invoice(uuid),
  public.record_reward_transfer(uuid, text, text)
  to authenticated;
grant execute on function public.get_public_proposal(text), public.resolve_partner_link(text),
                          public.get_team_invite(text), public.public_catalog_preview()
  to anon, authenticated;
grant execute on function public.referrer_name(text) to authenticated;
grant execute on function public.ingest_order_event(uuid, jsonb), public.plugin_sync(uuid, text),
                          public.plugin_sync_products(uuid, jsonb, timestamptz),
                          public.approve_matured_commissions(), public.platform_fee_report(timestamptz, timestamptz),
                          public.run_invoice_generation(date)
  to service_role;

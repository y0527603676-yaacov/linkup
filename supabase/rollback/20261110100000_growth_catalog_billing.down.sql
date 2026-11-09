-- EMERGENCY ROLLBACK of 20261110100000_growth_catalog_billing (and the invoice cron).
-- Restores the exact previous functions and policies; drops every object the migration added.
-- Data written only by the new features (products, opportunities, invoices, rewards, payouts, team invites,
-- notifications) is removed. Orders, attributions, ledger, referrals and organizations are kept.
-- Take a backup first. Run as one transaction.
begin;
do $$ begin perform cron.unschedule('linkup-monthly-invoices'); exception when others then null; end $$;

drop trigger if exists attributions_notify on public.attributions;
drop trigger if exists referrals_notify on public.referrals;
drop trigger if exists referrals_program on public.referrals;
drop trigger if exists agreements_enroll_campaigns on public.agreements;

drop table if exists public.referral_rewards, public.reward_payouts, public.invoice_items, public.invoices,
  public.creator_payout_items, public.creator_payouts, public.opportunity_applications, public.notifications,
  public.team_invites, public.products, public.platform_admins, public.lookup_attempts cascade;

alter table public.attributions drop column if exists campaign_id, drop column if exists base_commission_bps;
drop table if exists public.opportunities cascade;

drop function if exists public.org_dashboard(uuid);
alter function public.org_dashboard_full(uuid) rename to org_dashboard;
drop function if exists public.create_organization(text, text, text, text, text);

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
    'is_platform_admin','orgs_share_member','referrals_before_insert','update_organization','invite_team_member','get_team_invite',
    'accept_team_invite','org_members','set_member_role','remove_member','revoke_team_invite','plugin_sync_products',
    'upsert_agreement_terms','enroll_live_campaigns','agreements_enroll_campaigns','save_standing_opportunity','create_campaign',
    'set_opportunity_status','join_opportunity','decide_application','pending_applications','catalog','mark_notifications_read',
    'notify_on_attribution','notify_on_referral','wallet_balance_minor','first_sale_at','referral_shares','settle_invoice_rewards',
    'settle_reward_reversals','run_invoice_generation','generate_invoices','mark_invoice_paid','void_invoice','record_reward_transfer',
    'my_wallet','record_creator_payout','respond_creator_payout','payout_balances','track_event','org_status','admin_overview',
    'admin_set_setting','member_applied_to','opportunity_store','public_catalog_preview','resolve_referral_code','referrer_name')
  loop execute 'drop function if exists ' || f.sig || ' cascade'; end loop; end $$;

-- Previous function bodies (exact copies from the current production schema).
CREATE OR REPLACE FUNCTION public.approve_matured_commissions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int;
begin
  update public.commission_ledger l set state = 'approved', approved_at = now()
    from public.attributions a, public.orders o, public.agreement_versions v
   where l.state = 'pending' and a.id = l.attribution_id and o.id = a.order_id and v.id = a.agreement_version_id
     and o.status = 'completed' and o.completed_at is not null
     and o.completed_at + make_interval(days => v.refund_hold_days) <= now();
  get diagnostics n = row_count;
  return n;
end $function$
;
CREATE OR REPLACE FUNCTION public.create_organization(p_type text, p_name text, p_website_url text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_id uuid; v_slug text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('store', 'creator', 'agency') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'invalid_name' using errcode = '22023'; end if;
  if (select count(*) from public.memberships where user_id = v_uid) >= 10 then
    raise exception 'too_many_orgs' using errcode = '54000';
  end if;
  v_slug := btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), '-');
  if v_slug = '' then v_slug := p_type; end if;
  v_slug := left(v_slug, 40) || '-' || public.random_token(6);

  insert into public.organizations(type, name, slug, website_url)
  values (p_type, btrim(p_name), v_slug, public.normalize_url(p_website_url))
  returning id into v_id;
  insert into public.memberships(user_id, org_id, role) values (v_uid, v_id, 'owner');
  insert into public.audit_events(actor_user_id, org_id, action, target) values (v_uid, v_id, 'org.created', p_type);
  return v_id;
end $function$
;
CREATE OR REPLACE FUNCTION public.ingest_order_event(p_connection uuid, p_event jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_conn public.store_connections;
  o jsonb := p_event -> 'order';
  v_evt uuid; v_occ timestamptz; v_created timestamptz;
  v_total bigint; v_tax bigint; v_ship bigint; v_ship_tax bigint; v_base bigint;
  v_status text; v_ref text; v_ref_code text; v_ref_at timestamptz;
  v_order public.orders; v_attr public.attributions; v_code public.partner_codes; v_ver public.agreement_versions;
  v_method text; v_c text; v_fee int; v_self boolean; v_founders timestamptz; v_store_fee int;
  v_eff bigint; v_r jsonb; v_new_attr boolean := false;
begin
  select * into v_conn from public.store_connections where id = p_connection;
  if not found then raise exception 'unknown_connection' using errcode = 'P0002'; end if;
  if v_conn.status = 'disconnected' then raise exception 'connection_disconnected' using errcode = '22023'; end if;

  -- Validate payload (never trust money values blindly).
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

  -- 1. Idempotent inbox.
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

  -- 2. Upsert order; an older (out-of-order) event never overwrites newer state.
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

  -- 3. Refunds: every event carries the full refund list (self-healing if one event is lost).
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

  -- 4. Attribution (once per order). Coupon beats link; first applied LINKUP coupon wins.
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
      v_self := v_order.customer_email_hash is not null and exists (
        select 1 from public.memberships m join auth.users u on u.id = m.user_id
         join public.agreements a on a.id = v_code.agreement_id
         where m.org_id = a.creator_org_id
           and encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = v_order.customer_email_hash);
      select founders_until, platform_fee_bps into v_founders, v_store_fee from public.organizations where id = v_conn.org_id;
      v_fee := coalesce(v_store_fee,
                 case when v_founders is not null and v_order.order_created_at < v_founders
                      then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end);
      insert into public.attributions(order_id, agreement_version_id, partner_code_id, store_org_id, creator_org_id,
                                      method, commission_bps, platform_fee_bps, self_referral_suspected, evidence)
      select v_order.id, v_ver.id, v_code.id, a.store_org_id, a.creator_org_id, v_method, v_ver.commission_bps, v_fee,
             v_self, jsonb_build_object('code', v_code.code, 'coupons', to_jsonb(v_order.coupon_codes),
                                        'ref_code', v_order.ref_code, 'ref_at', v_order.ref_at)
        from public.agreements a where a.id = v_code.agreement_id
      returning * into v_attr;
      v_new_attr := true;
      if not exists (select 1 from public.attributions where store_org_id = v_attr.store_org_id and id <> v_attr.id) then
        insert into public.funnel_events(event, org_id) values ('first_attributed_sale', v_attr.store_org_id);
      end if;
    end if;
  end if;

  -- 5. Ledger: bring totals to target for current order state (handles refunds, edits, cancellations).
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
end $function$
;
CREATE OR REPLACE FUNCTION public.org_dashboard(p_org uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org public.organizations; v_month timestamptz := date_trunc('month', now()); v_cur text;
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_org from public.organizations where id = p_org;

  if v_org.type = 'store' then
    select coalesce((select currency from public.orders where store_org_id = p_org order by created_at desc limit 1), 'ILS') into v_cur;
    return json_build_object(
      'type', 'store', 'name', v_org.name, 'currency', v_cur,
      'default_commission_bps', v_org.default_commission_bps,
      'fee_bps', coalesce(v_org.platform_fee_bps, case when v_org.founders_until > now()
                   then public.setting_int('founders_fee_bps') else public.setting_int('standard_fee_bps') end),
      'founders_until', v_org.founders_until,
      'month_sales_minor', (select coalesce(sum(public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor)), 0)
                              from public.attributions a join public.orders o on o.id = a.order_id
                             where a.store_org_id = p_org and o.order_created_at >= v_month and o.currency = v_cur),
      'pending_commissions_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                    where store_org_id = p_org and party_role in ('creator', 'agency') and state = 'pending' and currency = v_cur),
      'approved_commissions_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                    where store_org_id = p_org and party_role in ('creator', 'agency') and state = 'approved' and currency = v_cur),
      'month_platform_fee_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                                   where store_org_id = p_org and party_role = 'platform' and created_at >= v_month and currency = v_cur),
      'active_partners', (select count(*) from public.agreements where store_org_id = p_org and status = 'active'),
      'connection', (select json_build_object('status', status, 'site_url', site_url, 'last_sync_at', last_sync_at)
                       from public.store_connections where org_id = p_org order by created_at desc limit 1),
      'partners', coalesce((select json_agg(x order by x.created_at desc) from (
          select a.created_at, c.name, pc.code,
                 (select commission_bps from public.agreement_versions where agreement_id = a.id order by version desc limit 1) as commission_bps
            from public.agreements a join public.organizations c on c.id = a.creator_org_id
            left join public.partner_codes pc on pc.agreement_id = a.id and pc.active
           where a.store_org_id = p_org and a.status = 'active') x), '[]'),
      'recent_sales', coalesce((select json_agg(x order by x.order_created_at desc) from (
          select o.external_order_id, o.order_created_at, o.status, c.name as partner, a.method, a.self_referral_suspected,
                 public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor) as base_minor,
                 (select coalesce(sum(amount_minor), 0) from public.commission_ledger l
                   where l.attribution_id = a.id and l.party_role in ('creator', 'agency')) as commission_minor
            from public.attributions a join public.orders o on o.id = a.order_id
            join public.organizations c on c.id = a.creator_org_id
           where a.store_org_id = p_org order by o.order_created_at desc limit 10) x), '[]'),
      'proposals', coalesce((select json_agg(x order by x.created_at desc) from (
          select token, invitee_name, status, commission_bps, created_at from public.proposals
           where from_org_id = p_org order by created_at desc limit 10) x), '[]'));
  elsif v_org.type = 'creator' then
    return json_build_object(
      'type', 'creator', 'name', v_org.name, 'currency', 'ILS',
      'month_earnings_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger
                               where party_org_id = p_org and created_at >= v_month),
      'pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_org_id = p_org and state = 'pending'),
      'approved_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_org_id = p_org and state = 'approved'),
      'active_stores', (select count(*) from public.agreements where creator_org_id = p_org and status = 'active'),
      'partnerships', coalesce((select json_agg(x order by x.created_at desc) from (
          select a.created_at, s.name as store_name, s.website_url, pc.code, v.commission_bps, v.coupon_discount_pct,
                 exists (select 1 from public.store_connections sc where sc.org_id = s.id and sc.status = 'connected') as store_connected
            from public.agreements a join public.organizations s on s.id = a.store_org_id
            join lateral (select commission_bps, coupon_discount_pct from public.agreement_versions
                          where agreement_id = a.id order by version desc limit 1) v on true
            left join public.partner_codes pc on pc.agreement_id = a.id and pc.active
           where a.creator_org_id = p_org and a.status = 'active') x), '[]'),
      'recent_sales', coalesce((select json_agg(x order by x.order_created_at desc) from (
          select o.order_created_at, s.name as store_name, a.method,
                 (select coalesce(sum(amount_minor), 0) from public.commission_ledger l
                   where l.attribution_id = a.id and l.party_org_id = p_org) as commission_minor
            from public.attributions a join public.orders o on o.id = a.order_id
            join public.organizations s on s.id = a.store_org_id
           where a.creator_org_id = p_org order by o.order_created_at desc limit 10) x), '[]'),
      'proposals', coalesce((select json_agg(x order by x.created_at desc) from (
          select token, invitee_name, status, commission_bps, created_at from public.proposals
           where from_org_id = p_org order by created_at desc limit 10) x), '[]'));
  else
    return json_build_object('type', v_org.type, 'name', v_org.name);
  end if;
end $function$
;

drop policy if exists ledger_read on public.commission_ledger;
create policy ledger_read on public.commission_ledger for select to authenticated using (
  public.is_member(store_org_id) or (party_org_id is not null and public.is_member(party_org_id)));

delete from public.funnel_events where event not in ('invite_sent','invite_opened','proposal_accepted','proposal_rejected','store_connected','first_attributed_sale');
alter table public.funnel_events drop constraint if exists funnel_events_event_check;
alter table public.funnel_events add constraint funnel_events_event_check CHECK ((event = ANY (ARRAY['invite_sent'::text, 'invite_opened'::text, 'proposal_accepted'::text, 'proposal_rejected'::text, 'store_connected'::text, 'first_attributed_sale'::text])));
alter table public.referrals drop constraint if exists referrals_source_check;
update public.referrals set source = 'proposal' where source = 'link';
alter table public.referrals add constraint referrals_source_check CHECK ((source = ANY (ARRAY['proposal'::text, 'partner_page'::text, 'import'::text])));
alter table public.referrals drop column if exists program, drop column if exists status;
alter table public.organizations drop column if exists referral_code, drop column if exists locale,
  drop column if exists logo_url, drop column if exists description;
update public.app_settings set value = '1000' where key = 'referral_reward_bps';
delete from public.app_settings where key in ('referral_reward_days','founding_partners_open','reward_transfer_min_minor','max_team_invites_per_day');

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_member(uuid), public.is_admin(uuid),
  public.create_organization(text, text, text), public.create_store_connection(uuid, text),
  public.create_proposal(uuid, int, text, text, int, int, text, uuid), public.accept_proposal(text, uuid),
  public.reject_proposal(text), public.org_dashboard(uuid) to authenticated;
grant execute on function public.get_public_proposal(text), public.resolve_partner_link(text) to anon, authenticated;
grant execute on function public.ingest_order_event(uuid, jsonb), public.plugin_sync(uuid, text),
  public.approve_matured_commissions(), public.platform_fee_report(timestamptz, timestamptz) to service_role;
commit;

-- Test data never reaches real money or financial reports.
--
-- A "test" activity (organizations.is_test) keeps working exactly like a real one — orders, attributions, coupon/link
-- precedence, cancellations, refunds and commission amounts are computed by the same engine — so tests are realistic.
-- What changes, for any ledger row whose store OR creator is a test activity:
--   1. It can never become 'approved' (approval is the only door to invoices, creator balances due, payment reminders,
--      referral rewards and collection). Enforced in approve_matured_commissions AND in the ledger guard trigger.
--   2. Hard stop on every table that represents real money: invoices, invoice_items, billing_charges, creator_payouts,
--      creator_payout_items, reward_payouts, referral_rewards → insert refused for test activities.
--   3. Platform-wide reports (admin overview, finance dashboard, platform fee report) leave test activities out.
--   4. An activity that already has attributed sales cannot be switched from test back to real (its test ledger would
--      otherwise become billable).
-- The test activity still sees its own data on its own screens (that is what is being tested).
-- No change to fees, fee terms, founders periods, agreements, entitlements or existing rows. No DROP.

create or replace function public.org_is_test(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select is_test from public.organizations where id = p_org), false);
$$;
revoke all on function public.org_is_test(uuid) from public, anon, authenticated;

-- 1a. Approval skips test activities.
CREATE OR REPLACE FUNCTION public.approve_matured_commissions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int; m int;
begin
  update public.commission_ledger l set state = 'approved', approved_at = now()
    from public.attributions a, public.orders o, public.agreement_versions v
   where l.state = 'pending' and a.id = l.attribution_id and o.id = a.order_id and v.id = a.agreement_version_id
     and o.status = 'completed' and o.completed_at is not null
     and o.completed_at + make_interval(days => v.refund_hold_days) <= now()
     and not public.org_is_test(a.store_org_id) and not public.org_is_test(a.creator_org_id);
  get diagnostics n = row_count;
  update public.commission_ledger l set state = 'approved', approved_at = now()
   where l.state = 'pending' and l.amount_minor < 0
     and not public.org_is_test(l.store_org_id) and not public.org_is_test(l.party_org_id)
     and exists (select 1 from public.commission_ledger x where x.attribution_id = l.attribution_id
                   and x.party_role = l.party_role and x.state = 'approved' and x.id <> l.id);
  get diagnostics m = row_count;
  perform public.settle_reward_reversals();
  return n + m;
end $function$;

-- 1b. Ledger guard: same immutability rules, plus test rows can never be approved by any path.
CREATE OR REPLACE FUNCTION public.guard_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'append_only: delete on commission_ledger' using errcode = '42501';
  end if;
  if not (old.state = 'pending' and new.state = 'approved' and new.approved_at is not null
          and new.amount_minor = old.amount_minor and new.attribution_id = old.attribution_id
          and new.party_role = old.party_role and new.party_org_id is not distinct from old.party_org_id
          and new.entry_type = old.entry_type and new.currency = old.currency
          and new.store_org_id = old.store_org_id and new.idempotency_key = old.idempotency_key) then
    raise exception 'append_only: commission_ledger rows are immutable' using errcode = '42501';
  end if;
  if public.org_is_test(new.store_org_id) or public.org_is_test(new.party_org_id) then
    raise exception 'test_data_not_billable' using errcode = '42501';
  end if;
  return new;
end $function$;

-- 2. Hard stop on real-money tables.
create or replace function public.block_test_money() returns trigger
language plpgsql security definer set search_path to '' as $$
declare j jsonb := to_jsonb(new); k text; v_test boolean := false;
begin
  foreach k in array array['store_org_id', 'creator_org_id', 'org_id', 'referrer_org_id'] loop
    if j ? k and public.org_is_test((j ->> k)::uuid) then v_test := true; end if;
  end loop;
  if not v_test and j ? 'ledger_id' and j ->> 'ledger_id' is not null then
    select public.org_is_test(l.store_org_id) or public.org_is_test(l.party_org_id) into v_test
      from public.commission_ledger l where l.id = (j ->> 'ledger_id')::uuid;
  end if;
  if not coalesce(v_test, false) and j ? 'attribution_id' and j ->> 'attribution_id' is not null then
    select public.org_is_test(a.store_org_id) or public.org_is_test(a.creator_org_id) into v_test
      from public.attributions a where a.id = (j ->> 'attribution_id')::uuid;
  end if;
  if coalesce(v_test, false) then
    raise exception 'test_data_not_billable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.block_test_money() from public, anon, authenticated;

drop trigger if exists block_test_money on public.invoices;
create trigger block_test_money before insert on public.invoices for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.invoice_items;
create trigger block_test_money before insert on public.invoice_items for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.billing_charges;
create trigger block_test_money before insert on public.billing_charges for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.creator_payouts;
create trigger block_test_money before insert on public.creator_payouts for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.creator_payout_items;
create trigger block_test_money before insert on public.creator_payout_items for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.reward_payouts;
create trigger block_test_money before insert on public.reward_payouts for each row execute function public.block_test_money();
drop trigger if exists block_test_money on public.referral_rewards;
create trigger block_test_money before insert on public.referral_rewards for each row execute function public.block_test_money();

-- 4. Test → real is refused once the activity has attributed sales.
create or replace function public.guard_test_flag() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if old.is_test and not new.is_test and exists (
       select 1 from public.attributions a where a.store_org_id = old.id or a.creator_org_id = old.id) then
    raise exception 'test_activity_has_sales' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_test_flag() from public, anon, authenticated;
drop trigger if exists guard_test_flag on public.organizations;
create trigger guard_test_flag before update of is_test on public.organizations
  for each row execute function public.guard_test_flag();

-- 3. Platform-wide reports without test activities.
CREATE OR REPLACE FUNCTION public.platform_fee_report(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(json_agg(x order by x.store_name), '[]') from (
    select o.name as store_name, o.id as store_org_id, l.currency, sum(l.amount_minor) as fee_minor,
           (select r.referrer_org_id from public.referrals r where r.referred_org_id = o.id and r.reward_until > p_from) as referrer_org_id,
           (select r.reward_bps from public.referrals r where r.referred_org_id = o.id and r.reward_until > p_from) as referral_reward_bps
      from public.commission_ledger l join public.organizations o on o.id = l.store_org_id
     where l.party_role = 'platform' and l.created_at >= p_from and l.created_at < p_to and not o.is_test
     group by o.id, o.name, l.currency) x;
$function$;

CREATE OR REPLACE FUNCTION public.admin_overview()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'attributed_sales_30d', (select count(*) from public.attributions where created_at > now() - interval '30 days'
                               and not public.org_is_test(store_org_id) and not public.org_is_test(creator_org_id)),
    'platform_fees_pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and state = 'pending'
                                      and not public.org_is_test(store_org_id)),
    'platform_fees_uninvoiced_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger l where party_role = 'platform' and state = 'approved'
                                         and not public.org_is_test(l.store_org_id)
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
end $function$;

CREATE OR REPLACE FUNCTION public.finance_dashboard()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_m timestamptz := date_trunc('month', now());
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'auto_enabled', public.setting_bool('auto_collection_enabled'),
    'provider', public.setting_text('billing_provider'),
    'fees_accrued_month_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and created_at >= v_m
                                   and not public.org_is_test(store_org_id)),
    'fees_pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and state = 'pending'
                             and not public.org_is_test(store_org_id)),
    'requests_open_minor', (select coalesce(sum(total_minor), 0) from public.invoices where status = 'issued'),
    'requests_overdue_minor', (select coalesce(sum(total_minor), 0) from public.invoices where status = 'issued' and due_at < now()),
    'collected_month_minor', (select coalesce(sum(total_minor), 0) from public.invoices where status = 'paid' and paid_at >= v_m),
    'vat_month_minor', (select coalesce(sum(vat_minor), 0) from public.invoices where status = 'paid' and paid_at >= v_m),
    'auto_collected_month_minor', (select coalesce(sum(amount_minor), 0) from public.billing_charges where status = 'succeeded' and completed_at >= v_m),
    'charges_scheduled', (select count(*) from public.billing_charges where status = 'scheduled'),
    'charges_failed_final', (select count(*) from public.billing_charges c where c.status = 'failed'
                               and not exists (select 1 from public.billing_charges n where n.invoice_id = c.invoice_id and n.attempt > c.attempt)),
    'refunds_month_minor', (select coalesce(sum(amount_minor), 0) from public.billing_refunds where status = 'succeeded' and completed_at >= v_m),
    'stores_with_method', (select count(*) from public.billing_payment_methods where status = 'active'),
    'rewards_liability_minor', (select coalesce(sum(public.wallet_balance_minor(o.id, 'ILS')), 0) from public.organizations o),
    'creator_outstanding_minor', (select coalesce(sum((public.creator_pair_balance(x.s, x.c, x.cur) ->> 'outstanding_minor')::bigint), 0)
                                    from (select distinct store_org_id s, party_org_id c, currency cur from public.commission_ledger
                                           where party_role = 'creator' and state = 'approved') x),
    'creator_overdue_pairs', (select count(*) from (select distinct store_org_id s, party_org_id c, currency cur from public.commission_ledger
                                           where party_role = 'creator' and state = 'approved') x
                               where (public.creator_pair_balance(x.s, x.c, x.cur) ->> 'overdue')::boolean));
end $function$;

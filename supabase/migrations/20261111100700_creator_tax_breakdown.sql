-- LINKUP — creator commission tax breakdown (business decision 10.11.2026).
--  * A creator commission is agreed BEFORE VAT. VAT is added by law only where it applies, by the creator's
--    VERIFIED tax classification. It is never assumed and never estimated.
--  * Displayed and recorded separately: agreed base commission · VAT (if applicable) · withholding tax (if required)
--    · net to transfer · amount actually transferred.
--  * Withholding is never computed by LINKUP: the store enters the amount it actually withheld (per its accountant
--    or the creator's withholding certificate), with an optional reference.
--  * Existing agreements were made before this definition was shown to the parties. They are marked
--    'unspecified' and NO VAT is computed for them until the basis is decided (no retroactive change of meaning).
--    Recording an actual payment of the base commission stays possible; nothing about the agreed rate changes.

/* ================= 1. VAT basis per agreement ================= */
alter table public.agreements add column commission_vat_basis text not null default 'plus_vat'
  check (commission_vat_basis in ('plus_vat', 'unspecified'));
alter table public.agreements add column vat_basis_decided_at timestamptz;
alter table public.agreements add column vat_basis_note text check (char_length(vat_basis_note) <= 500);
-- Every agreement that exists now predates the definition → pending a decision.
update public.agreements set commission_vat_basis = 'unspecified';

-- Platform admin records the decision for one legacy agreement (after the parties / counsel decide). Audited, one-way.
create function public.set_commission_vat_basis(p_agreement uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.agreements set commission_vat_basis = 'plus_vat', vat_basis_decided_at = now(), vat_basis_note = btrim(p_note)
   where id = p_agreement and commission_vat_basis = 'unspecified';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  select auth.uid(), a.store_org_id, 'agreement.vat_basis_decided', a.id::text, jsonb_build_object('note', btrim(p_note))
    from public.agreements a where a.id = p_agreement;
end $$;

/* ================= 2. VAT rate on a creator commission (NULL = cannot be determined) ================= */
-- Returns json {vat_bps, basis, reason}. basis: plus_vat | exempt | undetermined.
create function public.creator_vat_basis(p_store uuid, p_creator uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_basis text; t record;
begin
  select a.commission_vat_basis into v_basis from public.agreements a
   where a.store_org_id = p_store and a.creator_org_id = p_creator order by (a.status = 'active') desc, a.created_at desc limit 1;
  if v_basis is null then return json_build_object('vat_bps', null, 'basis', 'undetermined', 'reason', 'no_agreement'); end if;
  if v_basis = 'unspecified' then return json_build_object('vat_bps', null, 'basis', 'undetermined', 'reason', 'agreement_unspecified'); end if;
  select * into t from public.tax_profiles where org_id = p_creator;
  if not found or t.verified_at is null then
    return json_build_object('vat_bps', null, 'basis', 'undetermined', 'reason', 'classification_unverified');
  end if;
  if t.classification in ('company', 'authorized_dealer') and t.country = 'IL' then
    return json_build_object('vat_bps', public.setting_int('vat_bps'), 'basis', 'plus_vat', 'reason', t.classification);
  elsif t.classification = 'exempt_dealer' and t.country = 'IL' then
    return json_build_object('vat_bps', 0, 'basis', 'exempt', 'reason', t.classification);
  end if;
  -- private individual, foreign resident: the accountant decides; nothing is computed.
  return json_build_object('vat_bps', null, 'basis', 'undetermined', 'reason', 'needs_accountant');
end $$;

/* ================= 3. Payment records: withholding and net ================= */
alter table public.creator_payouts add column withholding_minor bigint not null default 0 check (withholding_minor >= 0);
alter table public.creator_payouts add column withholding_ref text check (char_length(withholding_ref) <= 120);
alter table public.creator_payouts add column vat_bps int check (vat_bps between 0 and 10000);
alter table public.creator_payouts add column tax_basis text check (tax_basis in ('plus_vat', 'exempt', 'undetermined'));
alter table public.creator_payouts add column net_minor bigint generated always as (amount_minor + vat_minor - withholding_minor) stored;
alter table public.creator_payouts add constraint creator_payouts_net_positive check (amount_minor + vat_minor - withholding_minor > 0);

create or replace function public.creator_payouts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if (new.store_org_id, new.creator_org_id, new.currency, new.amount_minor, new.vat_minor, new.method, new.reference, new.paid_at,
      new.paid_on, new.marked_by, new.idempotency_key, new.via, new.withholding_minor, new.withholding_ref, new.vat_bps, new.tax_basis)
     is distinct from
     (old.store_org_id, old.creator_org_id, old.currency, old.amount_minor, old.vat_minor, old.method, old.reference, old.paid_at,
      old.paid_on, old.marked_by, old.idempotency_key, old.via, old.withholding_minor, old.withholding_ref, old.vat_bps, old.tax_basis) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  if old.withdrawn_at is not null then raise exception 'append_only' using errcode = '42501'; end if;
  return new;
end $$;

/* ================= 4. Report a payment (replaces the 9-argument version) ================= */
drop function public.report_creator_payment(uuid, uuid, bigint, bigint, text, date, text, text, text);
create function public.report_creator_payment(p_store uuid, p_creator uuid, p_amount_minor bigint, p_vat_minor bigint,
                                              p_method text, p_paid_on date, p_reference text, p_idempotency_key text,
                                              p_currency text default 'ILS', p_withholding_minor bigint default 0,
                                              p_withholding_ref text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare v_out bigint; v_id uuid; v_existing uuid; v_tax json; v_rate int; v_vat bigint; v_wh bigint := coalesce(p_withholding_minor, 0);
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_idempotency_key is not null then
    select id into v_existing from public.creator_payouts where idempotency_key = p_idempotency_key;
    if v_existing is not null then return json_build_object('payout_id', v_existing, 'duplicate', true); end if;
  end if;
  perform 1 from public.organizations where id = p_store for update;
  v_out := (public.creator_pair_balance(p_store, p_creator, p_currency) ->> 'outstanding_minor')::bigint;
  if v_out <= 0 then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > v_out then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if coalesce(p_vat_minor, 0) < 0 or v_wh < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_paid_on is not null and (p_paid_on > current_date or p_paid_on < current_date - 400) then raise exception 'invalid_dates' using errcode = '22023'; end if;
  -- VAT: computed from the verified basis only. Undetermined → no VAT is recorded (never estimated).
  v_tax := public.creator_vat_basis(p_store, p_creator);
  v_rate := (v_tax ->> 'vat_bps')::int;
  if v_rate is null then
    if coalesce(p_vat_minor, 0) > 0 then raise exception 'creator_tax_undetermined' using errcode = '22023'; end if;
    v_vat := 0;
  else
    v_vat := round(p_amount_minor * v_rate / 10000.0);
    if p_vat_minor is not null and abs(p_vat_minor - v_vat) > 1 then raise exception 'vat_mismatch' using errcode = '22023'; end if;
  end if;
  if p_amount_minor + v_vat - v_wh <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  insert into public.creator_payouts(store_org_id, creator_org_id, currency, amount_minor, vat_minor, method, reference, marked_by, paid_on,
                                     idempotency_key, withholding_minor, withholding_ref, vat_bps, tax_basis)
  values (p_store, p_creator, p_currency, p_amount_minor, v_vat, coalesce(p_method, 'bank_transfer'),
          nullif(btrim(coalesce(p_reference, '')), ''), auth.uid(), coalesce(p_paid_on, current_date), p_idempotency_key,
          v_wh, nullif(btrim(coalesce(p_withholding_ref, '')), ''), v_rate, v_tax ->> 'basis')
  returning id into v_id;
  insert into public.notifications(org_id, kind, payload)
  values (p_creator, 'payout_marked', jsonb_build_object('payout_id', v_id, 'store', (select name from public.organizations where id = p_store),
          'amount_minor', p_amount_minor, 'net_minor', p_amount_minor + v_vat - v_wh));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'creator_payout.reported', v_id::text,
          jsonb_build_object('amount_minor', p_amount_minor, 'vat_minor', v_vat, 'withholding_minor', v_wh,
                             'tax_basis', v_tax ->> 'basis', 'partial', p_amount_minor < v_out));
  return json_build_object('payout_id', v_id, 'amount_minor', p_amount_minor, 'vat_minor', v_vat, 'withholding_minor', v_wh,
                           'net_minor', p_amount_minor + v_vat - v_wh, 'remaining_minor', v_out - p_amount_minor);
end $$;

create or replace function public.record_creator_payout(p_store uuid, p_creator uuid, p_method text, p_reference text,
                                             p_currency text default 'ILS') returns json
language plpgsql security definer set search_path = '' as $$
declare v_out bigint;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_out := (public.creator_pair_balance(p_store, p_creator, p_currency) ->> 'outstanding_minor')::bigint;
  if v_out <= 0 then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  return public.report_creator_payment(p_store, p_creator, v_out, null, p_method, current_date, p_reference, null, p_currency, 0, null);
end $$;

/* ================= 5. Balance: separate base · VAT · withholding · net · transferred ================= */
-- Wraps the existing balance: the commission balance itself (base, before VAT) is unchanged.
create function public.creator_pair_tax_summary(p_store uuid, p_creator uuid, p_currency text default 'ILS') returns json
language plpgsql stable security definer set search_path = '' as $$
declare b json; t json; v_rate int; v_out bigint; s record;
begin
  b := public.creator_pair_balance(p_store, p_creator, p_currency);
  t := public.creator_vat_basis(p_store, p_creator);
  v_rate := (t ->> 'vat_bps')::int;
  v_out := (b ->> 'outstanding_minor')::bigint;
  select coalesce(sum(vat_minor), 0) as vat, coalesce(sum(withholding_minor), 0) as wh, coalesce(sum(net_minor), 0) as net
    into s from public.creator_payouts
   where store_org_id = p_store and creator_org_id = p_creator and currency = p_currency and withdrawn_at is null;
  return json_build_object(
    'vat_basis', t ->> 'basis', 'vat_reason', t ->> 'reason', 'vat_bps', v_rate,
    'outstanding_base_minor', v_out,
    'outstanding_vat_minor', case when v_rate is null then null else round(v_out * v_rate / 10000.0)::bigint end,
    'outstanding_gross_minor', case when v_rate is null then null else v_out + round(v_out * v_rate / 10000.0)::bigint end,
    'reported_base_minor', (b ->> 'reported_minor')::bigint, 'reported_vat_minor', s.vat, 'withheld_minor', s.wh, 'transferred_minor', s.net);
end $$;

create or replace function public.payout_balances(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_type text;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select type into v_type from public.organizations where id = p_org;
  return coalesce((select json_agg(z order by (z ->> 'outstanding_minor')::bigint desc) from (
    select (b::jsonb || public.creator_pair_tax_summary(p.s, p.c, p.currency)::jsonb || jsonb_build_object(
              'other_org_id', p.other, 'other_name', (select name from public.organizations where id = p.other),
              'approved_unpaid_minor', (b ->> 'balance_minor')::bigint,
              'paid_minor', (b ->> 'reported_minor')::bigint,
              'awaiting_confirmation', (select count(*) from public.creator_payouts cp where cp.store_org_id = p.s and cp.creator_org_id = p.c
                                          and cp.withdrawn_at is null and cp.creator_status = 'awaiting')))::json as z
      from (select distinct case when v_type = 'store' then l.party_org_id else l.store_org_id end as other,
                   case when v_type = 'store' then p_org else l.store_org_id end as s,
                   case when v_type = 'store' then l.party_org_id else p_org end as c, l.currency
              from public.commission_ledger l
             where l.party_role = 'creator' and ((v_type = 'store' and l.store_org_id = p_org) or (v_type <> 'store' and l.party_org_id = p_org))) p
      cross join lateral public.creator_pair_balance(p.s, p.c, p.currency) b) q), '[]');
end $$;

/* ================= 6. Statement: tax summary + per-payment breakdown ================= */
create or replace function public.creator_statement(p_store uuid, p_creator uuid, p_from date default null, p_to date default null,
                                                    p_currency text default 'ILS') returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := coalesce(p_from, '2000-01-01')::timestamptz; v_to timestamptz := (coalesce(p_to, current_date) + 1)::timestamptz;
begin
  if not (public.is_admin(p_store) or public.is_admin(p_creator)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.agreements where store_org_id = p_store and creator_org_id = p_creator) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return json_build_object(
    'store', (select json_build_object('id', id, 'name', name) from public.organizations where id = p_store),
    'creator', (select json_build_object('id', id, 'name', name) from public.organizations where id = p_creator),
    'creator_classification', (select classification from public.tax_profiles where org_id = p_creator and verified_at is not null),
    'creator_classification_unverified', (select classification from public.tax_profiles where org_id = p_creator),
    'from', p_from, 'to', coalesce(p_to, current_date), 'generated_at', now(),
    'balance', public.creator_pair_balance(p_store, p_creator, p_currency),
    'tax', public.creator_pair_tax_summary(p_store, p_creator, p_currency),
    'lines', coalesce((select json_agg(json_build_object('date', o.order_created_at, 'order', o.external_order_id, 'type', l.entry_type,
              'base_minor', public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor), 'rate_bps', a.commission_bps,
              'amount_minor', l.amount_minor, 'state', l.state, 'approved_at', l.approved_at) order by l.created_at)
         from public.commission_ledger l join public.attributions a on a.id = l.attribution_id join public.orders o on o.id = a.order_id
        where l.party_role = 'creator' and l.store_org_id = p_store and l.party_org_id = p_creator and l.currency = p_currency
          and l.created_at >= v_from and l.created_at < v_to), '[]'),
    'payments', coalesce((select json_agg(json_build_object('id', p.id, 'paid_on', p.paid_on, 'reported_at', p.paid_at, 'amount_minor', p.amount_minor,
              'vat_minor', p.vat_minor, 'withholding_minor', p.withholding_minor, 'withholding_ref', p.withholding_ref, 'net_minor', p.net_minor,
              'tax_basis', p.tax_basis, 'method', p.method, 'reference', p.reference,
              'status', case when p.withdrawn_at is not null then 'withdrawn' else p.creator_status end,
              'dispute_reason', p.dispute_reason, 'store_response', p.store_response, 'withdraw_note', p.withdraw_note,
              'proofs', (select json_agg(json_build_object('id', pp.id, 'filename', pp.filename) order by pp.created_at) from public.payout_proofs pp where pp.payout_id = p.id))
              order by p.paid_at)
         from public.creator_payouts p where p.store_org_id = p_store and p.creator_org_id = p_creator and p.currency = p_currency
          and p.paid_at >= v_from and p.paid_at < v_to), '[]'));
end $$;

-- Owner view: legacy agreements awaiting the VAT-basis decision.
create function public.admin_vat_basis_pending() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', a.id, 'store', s.name, 'creator', c.name, 'status', a.status, 'created_at', a.created_at)
                                   order by a.created_at)
    from public.agreements a join public.organizations s on s.id = a.store_org_id join public.organizations c on c.id = a.creator_org_id
   where a.commission_vat_basis = 'unspecified'), '[]');
end $$;

revoke execute on function public.set_commission_vat_basis(uuid, text), public.creator_vat_basis(uuid, uuid),
  public.report_creator_payment(uuid, uuid, bigint, bigint, text, date, text, text, text, bigint, text),
  public.creator_pair_tax_summary(uuid, uuid, text),
  public.admin_vat_basis_pending() from public, anon, authenticated;
grant execute on function public.set_commission_vat_basis(uuid, text),
  public.report_creator_payment(uuid, uuid, bigint, bigint, text, date, text, text, text, bigint, text),
  public.admin_vat_basis_pending() to authenticated;

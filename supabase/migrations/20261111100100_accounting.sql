-- LINKUP — accounting basis approved by the accountant (11/2026).
--  * VAT on the LINKUP fee is computed on the full fee, before any FOUNDING PARTNERS offset (already in pilot_prep).
--  * The referral reward is a separate supply by the referrer to LINKUP. VAT on it depends on the referrer's
--    verified tax classification — never assumed. The offset is a settlement, not a discount.
--  * Separate records: fee before VAT, VAT on fee, reward, VAT on reward, offset, balance to pay, and the external
--    accounting documents from both sides. Tax invoices/receipts stay external and manual.
--  * A payment request, once created, is never edited or deleted. Corrections flow into the next period.
--  * Zero-rate VAT for a foreign store only with recorded evidence and platform-admin approval.
-- Creator commissions are unchanged: the store pays the creator directly; LINKUP is not a party to that money.

/* ================= 1. Business tax profiles ================= */
create table public.tax_profiles (
  org_id uuid primary key references public.organizations(id),
  legal_name text not null check (char_length(legal_name) between 2 and 200),
  classification text not null check (classification in
    ('company', 'authorized_dealer', 'exempt_dealer', 'foreign_resident', 'private_individual')),
  tax_id text check (char_length(tax_id) between 2 and 40),         -- ח.פ / ע.מ / foreign VAT ID / EIN
  address text check (char_length(address) <= 300),
  country char(2) not null default 'IL' check (country ~ '^[A-Z]{2}$'),
  -- Evidence for zero-rate VAT (foreign residents only)
  foreign_no_il_presence boolean not null default false,           -- declared: no branch / registered office in Israel
  foreign_evidence text check (char_length(foreign_evidence) <= 500), -- certificate of incorporation / tax residency ref
  foreign_payment_method text check (char_length(foreign_payment_method) <= 200),
  -- Verification by LINKUP (any change by the business resets it)
  verified_at timestamptz,
  verified_by uuid,
  zero_rate_approved boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (classification = 'foreign_resident' or country = 'IL' or classification = 'private_individual'),
  check (not zero_rate_approved or (classification = 'foreign_resident' and country <> 'IL'
                                    and foreign_no_il_presence and coalesce(foreign_evidence, '') <> '' and verified_at is not null))
);
create trigger tax_profiles_no_delete before delete on public.tax_profiles for each row execute function public.forbid_change();

create table public.tax_profile_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  snapshot jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create trigger tax_profile_history_append_only before update or delete on public.tax_profile_history
  for each row execute function public.forbid_change();

create function public.tax_profile_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tax_profile_history(org_id, snapshot, changed_by) values (new.org_id, to_jsonb(new), auth.uid());
  return new;
end $$;
create trigger tax_profiles_log after insert or update on public.tax_profiles for each row execute function public.tax_profile_log();

create function public.save_tax_profile(p_org uuid, p_legal_name text, p_classification text, p_tax_id text, p_address text,
                                        p_country text, p_no_il_presence boolean default false,
                                        p_evidence text default null, p_payment_method text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.tax_profiles as t (org_id, legal_name, classification, tax_id, address, country, foreign_no_il_presence,
                                        foreign_evidence, foreign_payment_method, updated_by, updated_at)
  values (p_org, btrim(p_legal_name), p_classification, nullif(btrim(coalesce(p_tax_id, '')), ''), nullif(btrim(coalesce(p_address, '')), ''),
          upper(coalesce(nullif(btrim(p_country), ''), 'IL')), coalesce(p_no_il_presence, false),
          nullif(btrim(coalesce(p_evidence, '')), ''), nullif(btrim(coalesce(p_payment_method, '')), ''), auth.uid(), now())
  on conflict (org_id) do update set
    legal_name = excluded.legal_name, classification = excluded.classification, tax_id = excluded.tax_id,
    address = excluded.address, country = excluded.country, foreign_no_il_presence = excluded.foreign_no_il_presence,
    foreign_evidence = excluded.foreign_evidence, foreign_payment_method = excluded.foreign_payment_method,
    verified_at = null, verified_by = null, zero_rate_approved = false,   -- every change needs re-verification
    updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_events(actor_user_id, org_id, action, details)
  values (auth.uid(), p_org, 'tax_profile.saved', jsonb_build_object('classification', p_classification, 'country', p_country));
end $$;

create function public.verify_tax_profile(p_org uuid, p_zero_rate boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.tax_profiles set verified_at = now(), verified_by = auth.uid(), zero_rate_approved = coalesce(p_zero_rate, false)
   where org_id = p_org;
  if not found then raise exception 'tax_profile_required' using errcode = '22023'; end if;
  insert into public.audit_events(actor_user_id, org_id, action, details)
  values (auth.uid(), p_org, 'tax_profile.verified', jsonb_build_object('zero_rate', coalesce(p_zero_rate, false)));
exception when check_violation then
  raise exception 'zero_rate_not_allowed' using errcode = '22023';
end $$;

-- VAT rate on the LINKUP fee for a store: standard rate unless a verified, approved zero-rate (foreign resident).
create function public.fee_vat_bps(p_store uuid) returns int
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from public.tax_profiles t where t.org_id = p_store and t.verified_at is not null and t.zero_rate_approved)
              then 0 else public.setting_int('vat_bps') end;
$$;

-- VAT rate on a referral reward supplied by this org to LINKUP. NULL = cannot be settled yet
-- (no verified profile, a private individual, or a foreign resident — pending a decision).
create function public.reward_vat_bps(p_org uuid) returns int
language sql stable security definer set search_path = '' as $$
  select case when t.verified_at is null then null
              when t.classification in ('company', 'authorized_dealer') and t.country = 'IL' then public.setting_int('vat_bps')
              when t.classification = 'exempt_dealer' and t.country = 'IL' then 0
              else null end
    from public.tax_profiles t where t.org_id = p_org;
$$;

/* ================= 2. Separate records on payment requests and reward settlements ================= */
alter table public.invoices add column store_classification text;
alter table public.invoices add column reward_offset_minor bigint not null default 0 check (reward_offset_minor >= 0);
alter table public.invoices add column reward_vat_bps int not null default 0 check (reward_vat_bps between 0 and 5000);
alter table public.invoices add column reward_vat_minor bigint not null default 0 check (reward_vat_minor >= 0);
update public.invoices set reward_offset_minor = credit_minor where credit_minor > 0;
alter table public.invoices add constraint invoices_offset_check check (credit_minor = reward_offset_minor + reward_vat_minor);

alter table public.reward_payouts add column vat_bps int not null default 0 check (vat_bps between 0 and 5000);
alter table public.reward_payouts add column vat_minor bigint not null default 0 check (vat_minor >= 0);
alter table public.reward_payouts add column recipient_classification text;
create trigger reward_payouts_append_only before update or delete on public.reward_payouts
  for each row execute function public.forbid_change();

/* ================= 3. Payment requests are immutable ================= */
-- Allowed changes only: delivery (once), issued → paid, issued → void before delivery. Money fields never change.
create function public.invoices_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if (new.store_org_id, new.period_start, new.currency, new.fees_minor, new.vat_bps, new.vat_minor, new.credit_minor,
      new.reward_offset_minor, new.reward_vat_bps, new.reward_vat_minor, new.total_minor, new.issued_at, new.number,
      new.store_classification)
     is distinct from
     (old.store_org_id, old.period_start, old.currency, old.fees_minor, old.vat_bps, old.vat_minor, old.credit_minor,
      old.reward_offset_minor, old.reward_vat_bps, old.reward_vat_minor, old.total_minor, old.issued_at, old.number,
      old.store_classification) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  if old.delivered_at is not null and (new.delivered_at, new.delivery_method, new.delivery_reference, new.due_at)
       is distinct from (old.delivered_at, old.delivery_method, old.delivery_reference, old.due_at) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  if new.status <> old.status and not ((old.status = 'issued' and new.status = 'paid')
                                       or (old.status = 'issued' and new.status = 'void' and old.delivered_at is null)) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  if old.status <> 'issued' and (new.paid_at, new.paid_reference) is distinct from (old.paid_at, old.paid_reference) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger invoices_guard before update or delete on public.invoices for each row execute function public.invoices_guard();

-- Items stay attached to a voided request (history kept); a fee line may belong to at most one live request.
alter table public.invoice_items drop constraint invoice_items_ledger_id_key;
create index invoice_items_ledger_idx on public.invoice_items(ledger_id);
create function public.invoice_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'append_only' using errcode = '42501'; end if;
  if exists (select 1 from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
              where ii.ledger_id = new.ledger_id and i.status <> 'void') then
    raise exception 'ledger_already_invoiced' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger invoice_items_guard before insert or update or delete on public.invoice_items
  for each row execute function public.invoice_items_guard();

create function public.ledger_invoiced(p_ledger uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
                  where ii.ledger_id = p_ledger and i.status <> 'void');
$$;

-- Offsets taken by a voided request return to the wallet (the payout row itself is kept).
create or replace function public.wallet_balance_minor(p_org uuid, p_currency text) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(amount_minor) from public.referral_rewards where referrer_org_id = p_org and currency = p_currency), 0)
       - coalesce((select sum(p.amount_minor) from public.reward_payouts p left join public.invoices i on i.id = p.invoice_id
                    where p.org_id = p_org and p.currency = p_currency and (i.id is null or i.status <> 'void')), 0);
$$;

create or replace function public.void_invoice(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Only an internal request that was never delivered may be voided; nothing is deleted.
  update public.invoices set status = 'void' where id = p_invoice and status = 'issued' and delivered_at is null
  returning store_org_id into v_store;
  if v_store is null then raise exception 'invoice_not_voidable' using errcode = '22023'; end if;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), v_store, 'invoice.voided', p_invoice::text);
end $$;

/* ================= 4. Payment request generation with the approved split ================= */
-- Offset amount = reward used + VAT on the reward (by the store's verified classification). Without a verified
-- classification no offset is taken — the reward stays in the wallet for a later request (no right is lost).
create function public.reward_offset_split(p_gross bigint, p_wallet bigint, p_rate int, out reward_used bigint, out reward_vat bigint)
language plpgsql immutable set search_path = '' as $$
begin
  reward_used := 0; reward_vat := 0;
  if p_rate is null or p_wallet <= 0 or p_gross <= 0 then return; end if;
  reward_used := least(p_wallet, floor(p_gross::numeric * 10000 / (10000 + p_rate))::bigint);
  reward_vat := round(reward_used::numeric * p_rate / 10000)::bigint;
  while reward_used + reward_vat > p_gross and reward_used > 0 loop
    reward_used := reward_used - 1;
    reward_vat := round(reward_used::numeric * p_rate / 10000)::bigint;
  end loop;
end $$;

create or replace function public.run_invoice_generation(p_period_start date) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_inv uuid; v_end timestamptz; n int := 0; v_vat_bps int; v_vat bigint; v_gross bigint;
        v_rate int; v_used bigint; v_rvat bigint; v_credit bigint; v_class text;
begin
  if not public.setting_bool('invoicing_tax_approved') then
    raise exception 'invoicing_not_approved' using errcode = '42501';   -- see preview_invoices for test mode
  end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_end := (p_period_start + interval '1 month')::timestamptz;
  if v_end > now() then raise exception 'period_not_closed' using errcode = '22023'; end if;
  for r in select l.store_org_id, l.currency, sum(l.amount_minor) as fees
             from public.commission_ledger l
            where l.party_role = 'platform' and l.state = 'approved' and l.approved_at < v_end
              and not public.ledger_invoiced(l.id)
            group by l.store_org_id, l.currency
           having sum(l.amount_minor) > 0 loop
    continue when exists (select 1 from public.invoices where store_org_id = r.store_org_id and period_start = p_period_start
                                                          and currency = r.currency and status <> 'void');
    perform 1 from public.organizations where id = r.store_org_id for update;   -- serialises with reward transfers
    select classification into v_class from public.tax_profiles where org_id = r.store_org_id;
    -- VAT on the full LINKUP fee; the offset never reduces this base.
    v_vat_bps := public.fee_vat_bps(r.store_org_id);
    v_vat := round(r.fees::numeric * v_vat_bps / 10000)::bigint;
    v_gross := r.fees + v_vat;
    -- Separate supply: the store's referral reward (+ VAT by its classification), used as settlement.
    v_rate := public.reward_vat_bps(r.store_org_id);
    select s.reward_used, s.reward_vat into v_used, v_rvat
      from public.reward_offset_split(v_gross, greatest(0, public.wallet_balance_minor(r.store_org_id, r.currency)), v_rate) s;
    v_credit := v_used + v_rvat;
    insert into public.invoices(store_org_id, period_start, currency, fees_minor, vat_bps, vat_minor, store_classification,
                                reward_offset_minor, reward_vat_bps, reward_vat_minor, credit_minor, total_minor, status, paid_at)
    values (r.store_org_id, p_period_start, r.currency, r.fees, v_vat_bps, v_vat, v_class,
            v_used, case when v_used > 0 then v_rate else 0 end, v_rvat, v_credit, v_gross - v_credit,
            case when v_gross - v_credit = 0 then 'paid' else 'issued' end,
            case when v_gross - v_credit = 0 then now() end)
    returning id into v_inv;
    insert into public.invoice_items(invoice_id, ledger_id, amount_minor)
    select v_inv, l.id, l.amount_minor from public.commission_ledger l
     where l.store_org_id = r.store_org_id and l.currency = r.currency and l.party_role = 'platform'
       and l.state = 'approved' and l.approved_at < v_end and not public.ledger_invoiced(l.id);
    if v_used > 0 then
      insert into public.reward_payouts(org_id, currency, amount_minor, method, invoice_id, vat_bps, vat_minor, recipient_classification)
      values (r.store_org_id, r.currency, v_used, 'invoice_credit', v_inv, v_rate, v_rvat, v_class);
    end if;
    if v_gross - v_credit = 0 then perform public.settle_invoice_rewards(v_inv); end if;
    insert into public.notifications(org_id, kind, payload)
    values (r.store_org_id, 'invoice_issued', jsonb_build_object('invoice_id', v_inv));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.preview_invoices(p_period_start date) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_end timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_end := (p_period_start + interval '1 month')::timestamptz;
  return coalesce((select json_agg(z order by z.store) from (
    select y.*, s.reward_used as reward_offset_minor, s.reward_vat as reward_vat_minor,
           s.reward_used + s.reward_vat as credit_minor, y.fees_minor + y.vat_minor - s.reward_used - s.reward_vat as total_minor,
           (y.wallet_minor > 0 and y.reward_vat_bps is null) as offset_blocked
      from (
      select x.*, round(x.fees_minor::numeric * x.vat_bps / 10000)::bigint as vat_minor
        from (
        select o.name as store, l.store_org_id, l.currency, sum(l.amount_minor) as fees_minor,
               public.fee_vat_bps(l.store_org_id) as vat_bps, public.reward_vat_bps(l.store_org_id) as reward_vat_bps,
               greatest(0, public.wallet_balance_minor(l.store_org_id, l.currency)) as wallet_minor,
               (select classification from public.tax_profiles t where t.org_id = l.store_org_id) as classification
          from public.commission_ledger l join public.organizations o on o.id = l.store_org_id
         where l.party_role = 'platform' and l.state = 'approved' and l.approved_at < v_end and not public.ledger_invoiced(l.id)
         group by o.name, l.store_org_id, l.currency having sum(l.amount_minor) > 0) x) y
      cross join lateral public.reward_offset_split((y.fees_minor + y.vat_minor)::bigint, y.wallet_minor, y.reward_vat_bps) s) z), '[]');
end $$;

/* ================= 5. External accounting documents ================= */
create table public.accounting_documents (
  id uuid primary key default gen_random_uuid(),
  issuer text not null check (issuer in ('linkup', 'counterparty')),
  doc_type text not null check (doc_type in ('tax_invoice', 'receipt', 'tax_invoice_receipt', 'exempt_invoice_receipt',
                                             'self_invoice', 'credit_note', 'other')),
  doc_number text not null check (char_length(doc_number) between 1 and 60),
  issued_on date not null,
  org_id uuid not null references public.organizations(id),          -- the counterparty (store / referrer)
  invoice_id uuid references public.invoices(id),
  reward_payout_id uuid references public.reward_payouts(id),
  currency char(3) not null default 'ILS',
  amount_minor bigint not null check (amount_minor >= 0),            -- before VAT
  vat_minor bigint not null default 0 check (vat_minor >= 0),
  software text check (char_length(software) <= 60),                 -- e.g. the licensed invoicing software used
  note text check (char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (invoice_id is not null or reward_payout_id is not null)
);
create index accounting_documents_invoice_idx on public.accounting_documents(invoice_id);
create index accounting_documents_payout_idx on public.accounting_documents(reward_payout_id);
create trigger accounting_documents_append_only before update or delete on public.accounting_documents
  for each row execute function public.forbid_change();

create function public.record_accounting_document(p_issuer text, p_doc_type text, p_number text, p_issued_on date,
                                                  p_invoice uuid, p_reward_payout uuid, p_amount_minor bigint, p_vat_minor bigint,
                                                  p_software text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_cur text; v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_invoice is not null then select store_org_id, currency into v_org, v_cur from public.invoices where id = p_invoice;
  elsif p_reward_payout is not null then select org_id, currency into v_org, v_cur from public.reward_payouts where id = p_reward_payout;
  end if;
  if v_org is null then raise exception 'not_found' using errcode = '22023'; end if;
  if p_issued_on is null or p_issued_on > current_date then raise exception 'invalid_dates' using errcode = '22023'; end if;
  insert into public.accounting_documents(issuer, doc_type, doc_number, issued_on, org_id, invoice_id, reward_payout_id, currency,
                                          amount_minor, vat_minor, software, note, created_by)
  values (p_issuer, p_doc_type, btrim(p_number), p_issued_on, v_org, p_invoice, p_reward_payout, v_cur,
          p_amount_minor, coalesce(p_vat_minor, 0), nullif(btrim(coalesce(p_software, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), v_org, 'accounting_document.recorded', v_id::text, jsonb_build_object('issuer', p_issuer, 'type', p_doc_type, 'number', p_number));
  return v_id;
end $$;

/* ================= 6. Cash reward transfers to referrers ================= */
-- Needs a verified tax classification and the referrer's own accounting document (recorded before the transfer).
-- VAT is added only where the classification makes it applicable. Private individuals: blocked pending a decision.
drop function public.record_reward_transfer(uuid, text, text);
create function public.record_reward_transfer(p_org uuid, p_currency text, p_reference text,
                                              p_doc_type text, p_doc_number text, p_doc_date date) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_bal bigint; v_rate int; v_vat bigint; v_pid uuid; v_class text;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = p_org for update;
  v_bal := public.wallet_balance_minor(p_org, p_currency);
  if v_bal < public.setting_int('reward_transfer_min_minor') then raise exception 'below_minimum' using errcode = '22023'; end if;
  v_rate := public.reward_vat_bps(p_org);
  if v_rate is null then raise exception 'tax_profile_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_doc_number), '') = '' then raise exception 'document_required' using errcode = '22023'; end if;
  select classification into v_class from public.tax_profiles where org_id = p_org;
  v_vat := round(v_bal::numeric * v_rate / 10000)::bigint;
  insert into public.reward_payouts(org_id, currency, amount_minor, method, reference, created_by, vat_bps, vat_minor, recipient_classification)
  values (p_org, p_currency, v_bal, 'transfer', nullif(btrim(coalesce(p_reference, '')), ''), auth.uid(), v_rate, v_vat, v_class)
  returning id into v_pid;
  insert into public.accounting_documents(issuer, doc_type, doc_number, issued_on, org_id, reward_payout_id, currency, amount_minor, vat_minor, created_by)
  values ('counterparty', p_doc_type, btrim(p_doc_number), coalesce(p_doc_date, current_date), p_org, v_pid, p_currency, v_bal, v_vat, auth.uid());
  insert into public.notifications(org_id, kind, payload) values (p_org, 'reward_paid', '{}');
  insert into public.audit_events(actor_user_id, org_id, action, details)
  values (auth.uid(), p_org, 'reward.transferred', jsonb_build_object('amount_minor', v_bal, 'vat_minor', v_vat, 'currency', p_currency));
  return v_bal + v_vat;
end $$;

/* ================= 7. Commission base breakdown per sale (read model) ================= */
create view public.sale_fee_breakdown with (security_invoker = true) as
  select a.id as attribution_id, o.store_org_id, o.external_order_id, o.currency, o.order_created_at,
         o.total_minor as gross_sales_minor,
         nullif(ev.payload -> 'order' ->> 'discount', '')::bigint as discount_minor,
         coalesce((ev.payload -> 'order' ->> 'shipping')::bigint, 0) + coalesce((ev.payload -> 'order' ->> 'shipping_tax')::bigint, 0) as shipping_minor,
         o.total_minor - o.base_minor - coalesce((ev.payload -> 'order' ->> 'shipping')::bigint, 0)
                       - coalesce((ev.payload -> 'order' ->> 'shipping_tax')::bigint, 0) as sale_vat_minor,
         o.base_minor as eligible_base_minor, o.refunded_minor,
         a.platform_fee_bps as linkup_fee_bps,
         (select coalesce(sum(l.amount_minor), 0) from public.commission_ledger l where l.attribution_id = a.id and l.party_role = 'platform') as linkup_fee_minor
    from public.attributions a join public.orders o on o.id = a.order_id
    left join lateral (select e.payload from public.order_events e
                        where e.connection_id = o.connection_id and e.external_order_id = o.external_order_id
                        order by e.occurred_at desc limit 1) ev on true;

/* ================= 8. Admin list (adds the split and document status) ================= */
create or replace function public.admin_invoices() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'tax_approved', public.setting_bool('invoicing_tax_approved'),
    'vat_bps', public.setting_int('vat_bps'),
    'invoices', coalesce((select json_agg(x order by x.issued_at desc) from (
      select i.id, i.number, o.name as store, i.store_org_id, i.period_start, i.currency, i.fees_minor, i.vat_bps, i.vat_minor,
             i.reward_offset_minor, i.reward_vat_bps, i.reward_vat_minor, i.credit_minor, i.store_classification,
             i.total_minor, i.status, i.issued_at, i.delivered_at, i.delivery_method, i.delivery_reference, i.due_at,
             (i.status = 'issued' and i.due_at is not null and i.due_at < now()) as overdue, i.paid_at, i.paid_reference,
             (select json_agg(json_build_object('issuer', d.issuer, 'type', d.doc_type, 'number', d.doc_number, 'date', d.issued_on) order by d.created_at)
                from public.accounting_documents d where d.invoice_id = i.id) as documents,
             (i.status = 'paid' and not exists (select 1 from public.accounting_documents d where d.invoice_id = i.id and d.issuer = 'linkup')) as missing_linkup_doc,
             (i.credit_minor > 0 and i.status <> 'void' and not exists (select 1 from public.accounting_documents d where d.invoice_id = i.id and d.issuer = 'counterparty')) as missing_counterparty_doc
        from public.invoices i join public.organizations o on o.id = i.store_org_id
       order by i.issued_at desc limit 100) x), '[]'),
    'tax_profiles', coalesce((select json_agg(json_build_object('org_id', t.org_id, 'org', o.name, 'type', o.type, 'legal_name', t.legal_name,
         'classification', t.classification, 'tax_id', t.tax_id, 'country', t.country, 'verified_at', t.verified_at,
         'zero_rate_approved', t.zero_rate_approved, 'foreign_no_il_presence', t.foreign_no_il_presence,
         'foreign_evidence', t.foreign_evidence) order by t.verified_at nulls first, t.updated_at desc)
       from public.tax_profiles t join public.organizations o on o.id = t.org_id), '[]'));
end $$;

/* ================= Security ================= */
alter table public.tax_profiles enable row level security;
alter table public.tax_profile_history enable row level security;
alter table public.accounting_documents enable row level security;
create policy tax_profiles_read on public.tax_profiles for select to authenticated using (public.is_admin(org_id) or public.is_platform_admin());
create policy accounting_documents_read on public.accounting_documents for select to authenticated using (public.is_admin(org_id) or public.is_platform_admin());
revoke all on public.tax_profiles, public.tax_profile_history, public.accounting_documents, public.sale_fee_breakdown from anon, authenticated;
grant select on public.tax_profiles, public.accounting_documents to authenticated;

revoke execute on function public.save_tax_profile(uuid, text, text, text, text, text, boolean, text, text),
  public.verify_tax_profile(uuid, boolean), public.fee_vat_bps(uuid), public.reward_vat_bps(uuid),
  public.reward_offset_split(bigint, bigint, int), public.ledger_invoiced(uuid),
  public.record_accounting_document(text, text, text, date, uuid, uuid, bigint, bigint, text, text),
  public.record_reward_transfer(uuid, text, text, text, text, date), public.tax_profile_log(),
  public.invoices_guard(), public.invoice_items_guard()
  from public, anon, authenticated;
grant execute on function public.save_tax_profile(uuid, text, text, text, text, text, boolean, text, text),
  public.verify_tax_profile(uuid, boolean),
  public.record_accounting_document(text, text, text, date, uuid, uuid, bigint, bigint, text, text),
  public.record_reward_transfer(uuid, text, text, text, text, date)
  to authenticated;

-- LINKUP — creator settlement (business decision 10.11.2026): every store keeps its own payment provider; no
-- split at sale time; LINKUP never holds or moves creator money. LINKUP keeps the books both sides see:
-- approved balance, due date, payments the store REPORTS, receipts the creator CONFIRMS, disputes and corrections.
--  * Balance model: outstanding = approved creator commission − payments reported (not withdrawn). Partial payments
--    are supported; a payment can never exceed the approved outstanding amount (no unapproved or double payment).
--  * Due date = approval date of the oldest approved amount not yet covered (first in, first out) + 14 days.
--  * Payment details of the creator are readable only through audited functions, never by table access.
--  * Nothing is deleted: a report made by mistake is withdrawn (kept, with who and why).
--  * VAT the store pays on top of the commission (when the creator charges it) is recorded separately and never
--    counted against the commission balance.

/* ================= 1. Payment reports ================= */
alter table public.creator_payouts drop constraint creator_payouts_creator_status_check;
alter table public.creator_payouts add constraint creator_payouts_creator_status_check
  check (creator_status in ('awaiting', 'confirmed', 'disputed'));
alter table public.creator_payouts add column vat_minor bigint not null default 0 check (vat_minor >= 0);
alter table public.creator_payouts add column paid_on date;
alter table public.creator_payouts add column idempotency_key text unique check (char_length(idempotency_key) <= 80);
alter table public.creator_payouts add column dispute_reason text check (char_length(dispute_reason) <= 1000);
alter table public.creator_payouts add column store_response text check (char_length(store_response) <= 1000);
alter table public.creator_payouts add column withdrawn_at timestamptz;
alter table public.creator_payouts add column withdrawn_by uuid;
alter table public.creator_payouts add column withdraw_note text check (char_length(withdraw_note) <= 500);
alter table public.creator_payouts add column via text not null default 'manual' check (via in ('manual', 'provider'));

create function public.creator_payouts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if (new.store_org_id, new.creator_org_id, new.currency, new.amount_minor, new.vat_minor, new.method, new.reference, new.paid_at,
      new.paid_on, new.marked_by, new.idempotency_key, new.via)
     is distinct from
     (old.store_org_id, old.creator_org_id, old.currency, old.amount_minor, old.vat_minor, old.method, old.reference, old.paid_at,
      old.paid_on, old.marked_by, old.idempotency_key, old.via) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  if old.withdrawn_at is not null then raise exception 'append_only' using errcode = '42501'; end if;
  return new;
end $$;
create trigger creator_payouts_guard before update or delete on public.creator_payouts
  for each row execute function public.creator_payouts_guard();

/* ================= 2. Balance per store–creator pair ================= */
create function public.creator_pair_balance(p_store uuid, p_creator uuid, p_currency text default 'ILS') returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_approved bigint; v_pending bigint; v_reported bigint; v_confirmed bigint; v_disputed bigint; v_out bigint;
        v_due_basis timestamptz; v_days int := public.setting_int('creator_payment_days'); v_sales int;
begin
  select coalesce(sum(amount_minor) filter (where state = 'approved'), 0), coalesce(sum(amount_minor) filter (where state = 'pending'), 0)
    into v_approved, v_pending
    from public.commission_ledger where party_role = 'creator' and store_org_id = p_store and party_org_id = p_creator and currency = p_currency;
  select coalesce(sum(amount_minor), 0), coalesce(sum(amount_minor) filter (where creator_status = 'confirmed'), 0),
         coalesce(sum(amount_minor) filter (where creator_status = 'disputed'), 0)
    into v_reported, v_confirmed, v_disputed
    from public.creator_payouts where store_org_id = p_store and creator_org_id = p_creator and currency = p_currency and withdrawn_at is null;
  v_out := greatest(0, v_approved - v_reported);
  -- First in, first out: the approval date of the first approved amount the payments do not yet cover.
  if v_out > 0 then
    select x.approved_at into v_due_basis from (
      select l.approved_at, sum(l.amount_minor) over (order by l.approved_at, l.id) as cum
        from public.commission_ledger l
       where l.party_role = 'creator' and l.state = 'approved' and l.store_org_id = p_store and l.party_org_id = p_creator and l.currency = p_currency) x
     where x.cum > v_reported order by x.cum limit 1;
  end if;
  select count(*) into v_sales from public.attributions where store_org_id = p_store and creator_org_id = p_creator;
  return json_build_object('store_org_id', p_store, 'creator_org_id', p_creator, 'currency', p_currency, 'sales', v_sales,
    'pending_minor', v_pending, 'approved_minor', v_approved, 'reported_minor', v_reported, 'confirmed_minor', v_confirmed,
    'disputed_minor', v_disputed, 'outstanding_minor', v_out,
    -- signed: negative = the store paid more than is now approved (e.g. a refund after payment) → offset against future commissions
    'balance_minor', v_approved - v_reported,
    'oldest_unpaid_approved_at', v_due_basis,
    'due_at', case when v_due_basis is not null then v_due_basis + make_interval(days => v_days) end,
    'overdue', coalesce(v_due_basis + make_interval(days => v_days) < now(), false),
    'due_soon', coalesce(v_due_basis + make_interval(days => v_days) between now() and now() + interval '3 days', false));
end $$;

-- Per-partner balances (store: its creators; creator: its stores). Same field names as before plus the new ones.
create or replace function public.payout_balances(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_type text;
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select type into v_type from public.organizations where id = p_org;
  return coalesce((select json_agg(z order by (z ->> 'outstanding_minor')::bigint desc) from (
    select (b::jsonb || jsonb_build_object(
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

/* ================= 3. Report, confirm, dispute, withdraw ================= */
create function public.report_creator_payment(p_store uuid, p_creator uuid, p_amount_minor bigint, p_vat_minor bigint,
                                              p_method text, p_paid_on date, p_reference text, p_idempotency_key text,
                                              p_currency text default 'ILS') returns json
language plpgsql security definer set search_path = '' as $$
declare v_out bigint; v_id uuid; v_existing uuid;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Same submission twice (double click, retry) → the first report, nothing new.
  if p_idempotency_key is not null then
    select id into v_existing from public.creator_payouts where idempotency_key = p_idempotency_key;
    if v_existing is not null then return json_build_object('payout_id', v_existing, 'duplicate', true); end if;
  end if;
  perform 1 from public.organizations where id = p_store for update;   -- serialise reports of the same store
  v_out := (public.creator_pair_balance(p_store, p_creator, p_currency) ->> 'outstanding_minor')::bigint;
  if v_out <= 0 then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > v_out then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if coalesce(p_vat_minor, 0) < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_paid_on is not null and (p_paid_on > current_date or p_paid_on < current_date - 400) then raise exception 'invalid_dates' using errcode = '22023'; end if;
  insert into public.creator_payouts(store_org_id, creator_org_id, currency, amount_minor, vat_minor, method, reference, marked_by, paid_on, idempotency_key)
  values (p_store, p_creator, p_currency, p_amount_minor, coalesce(p_vat_minor, 0), coalesce(p_method, 'bank_transfer'),
          nullif(btrim(coalesce(p_reference, '')), ''), auth.uid(), coalesce(p_paid_on, current_date), p_idempotency_key)
  returning id into v_id;
  insert into public.notifications(org_id, kind, payload)
  values (p_creator, 'payout_marked', jsonb_build_object('payout_id', v_id, 'store', (select name from public.organizations where id = p_store),
          'amount_minor', p_amount_minor));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'creator_payout.reported', v_id::text,
          jsonb_build_object('amount_minor', p_amount_minor, 'vat_minor', coalesce(p_vat_minor, 0), 'partial', p_amount_minor < v_out));
  return json_build_object('payout_id', v_id, 'amount_minor', p_amount_minor, 'remaining_minor', v_out - p_amount_minor);
end $$;

-- Older single-click "mark all paid": now a report of the full outstanding balance.
create or replace function public.record_creator_payout(p_store uuid, p_creator uuid, p_method text, p_reference text,
                                                        p_currency text default 'ILS') returns json
language plpgsql security definer set search_path = '' as $$
declare v_out bigint;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_out := (public.creator_pair_balance(p_store, p_creator, p_currency) ->> 'outstanding_minor')::bigint;
  if v_out <= 0 then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  return public.report_creator_payment(p_store, p_creator, v_out, 0, p_method, current_date, p_reference, null, p_currency);
end $$;

drop function public.respond_creator_payout(uuid, boolean);
create function public.respond_creator_payout(p_payout uuid, p_confirm boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.creator_payouts;
begin
  select * into p from public.creator_payouts where id = p_payout for update;
  if not found or not public.is_admin(p.creator_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p.withdrawn_at is not null then raise exception 'already_responded' using errcode = '22023'; end if;
  -- A disputed report can still be confirmed later (money arrived); a confirmed one is final.
  if p.creator_status = 'confirmed' or (p.creator_status = 'disputed' and not p_confirm) then
    raise exception 'already_responded' using errcode = '22023';
  end if;
  update public.creator_payouts set creator_status = case when p_confirm then 'confirmed' else 'disputed' end,
         creator_responded_at = now(), dispute_reason = case when p_confirm then dispute_reason else nullif(btrim(coalesce(p_reason, '')), '') end
   where id = p_payout;
  insert into public.notifications(org_id, kind, payload)
  values (p.store_org_id, case when p_confirm then 'payout_confirmed' else 'payout_disputed' end,
          jsonb_build_object('payout_id', p.id, 'creator', (select name from public.organizations where id = p.creator_org_id)));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p.creator_org_id, case when p_confirm then 'creator_payout.confirmed' else 'creator_payout.disputed' end, p.id::text,
          jsonb_build_object('reason', p_reason));
end $$;

-- The store answers a dispute (e.g. adds the transfer reference) — kept as text, the money record does not change.
create function public.answer_payout_dispute(p_payout uuid, p_response text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.creator_payouts;
begin
  select * into p from public.creator_payouts where id = p_payout for update;
  if not found or not public.is_admin(p.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p.creator_status <> 'disputed' or p.withdrawn_at is not null then raise exception 'not_disputed' using errcode = '22023'; end if;
  if coalesce(btrim(p_response), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  update public.creator_payouts set store_response = btrim(p_response) where id = p_payout;
  insert into public.notifications(org_id, kind, payload) values (p.creator_org_id, 'payout_dispute_answered', jsonb_build_object('payout_id', p.id));
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p.store_org_id, 'creator_payout.dispute_answered', p.id::text);
end $$;

-- A report made by mistake is withdrawn (never deleted). Not possible once the creator confirmed receipt.
create function public.withdraw_creator_payout(p_payout uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.creator_payouts;
begin
  select * into p from public.creator_payouts where id = p_payout for update;
  if not found or not public.is_admin(p.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p.creator_status = 'confirmed' or p.withdrawn_at is not null then raise exception 'not_withdrawable' using errcode = '22023'; end if;
  if exists (select 1 from public.creator_payout_items where payout_id = p.id) then raise exception 'not_withdrawable' using errcode = '22023'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  update public.creator_payouts set withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_note = btrim(p_note) where id = p_payout;
  insert into public.notifications(org_id, kind, payload) values (p.creator_org_id, 'payout_withdrawn', jsonb_build_object('payout_id', p.id));
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p.store_org_id, 'creator_payout.withdrawn', p.id::text, jsonb_build_object('note', p_note));
end $$;

/* ================= 4. Transfer proofs ================= */
create table public.payout_proofs (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.creator_payouts(id),
  filename text not null check (char_length(filename) between 1 and 120),
  mime text not null check (mime in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes int not null check (size_bytes between 1 and 2097152),
  content bytea not null,
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
create index payout_proofs_payout_idx on public.payout_proofs(payout_id);
create trigger payout_proofs_append_only before update or delete on public.payout_proofs for each row execute function public.forbid_change();

create function public.attach_payout_proof(p_payout uuid, p_filename text, p_mime text, p_base64 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.creator_payouts; v_bytes bytea; v_id uuid;
begin
  select * into p from public.creator_payouts where id = p_payout;
  if not found or not public.is_admin(p.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select count(*) from public.payout_proofs where payout_id = p_payout) >= 5 then raise exception 'too_many' using errcode = '22023'; end if;
  begin v_bytes := decode(p_base64, 'base64'); exception when others then raise exception 'invalid_input' using errcode = '22023'; end;
  insert into public.payout_proofs(payout_id, filename, mime, size_bytes, content, uploaded_by)
  values (p_payout, left(regexp_replace(coalesce(p_filename, 'proof'), '[^A-Za-z0-9א-ת._ -]', '_', 'g'), 120), p_mime, octet_length(v_bytes), v_bytes, auth.uid())
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p.store_org_id, 'creator_payout.proof_attached', p_payout::text);
  return v_id;
exception when check_violation then raise exception 'invalid_input' using errcode = '22023';
end $$;

create function public.get_payout_proof(p_proof uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select pp.*, cp.store_org_id, cp.creator_org_id into r from public.payout_proofs pp join public.creator_payouts cp on cp.id = pp.payout_id where pp.id = p_proof;
  if not found or not (public.is_admin(r.store_org_id) or public.is_admin(r.creator_org_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object('filename', r.filename, 'mime', r.mime, 'base64', encode(r.content, 'base64'));
end $$;

/* ================= 5. Creator payment details (sensitive) ================= */
create table public.creator_payout_details (
  org_id uuid primary key references public.organizations(id),
  method text not null check (method in ('bank_transfer', 'bit', 'paybox', 'payment_link', 'other')),
  holder_name text check (char_length(holder_name) <= 120),
  bank_code text check (bank_code ~ '^[0-9]{2,3}$'),
  branch text check (branch ~ '^[0-9]{3,4}$'),
  account_number text check (account_number ~ '^[0-9]{4,13}$'),
  phone text check (phone ~ '^\+?[0-9]{9,13}$'),
  payment_link text check (payment_link ~ '^https://' and char_length(payment_link) <= 300),
  note text check (char_length(note) <= 200),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create trigger creator_payout_details_no_delete before delete on public.creator_payout_details for each row execute function public.forbid_change();

create function public.save_payout_details(p_org uuid, p_method text, p_holder text, p_bank text, p_branch text, p_account text,
                                           p_phone text, p_link text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin(p_org) or (select type from public.organizations where id = p_org) <> 'creator' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.creator_payout_details as d (org_id, method, holder_name, bank_code, branch, account_number, phone, payment_link, note, updated_by, updated_at)
  values (p_org, p_method, nullif(btrim(coalesce(p_holder, '')), ''), nullif(regexp_replace(coalesce(p_bank, ''), '\D', '', 'g'), ''),
          nullif(regexp_replace(coalesce(p_branch, ''), '\D', '', 'g'), ''), nullif(regexp_replace(coalesce(p_account, ''), '\D', '', 'g'), ''),
          nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), ''), nullif(btrim(coalesce(p_link, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), now())
  on conflict (org_id) do update set method = excluded.method, holder_name = excluded.holder_name, bank_code = excluded.bank_code,
     branch = excluded.branch, account_number = excluded.account_number, phone = excluded.phone, payment_link = excluded.payment_link,
     note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  if p_method = 'bank_transfer' and exists (select 1 from public.creator_payout_details where org_id = p_org
                                              and (holder_name is null or bank_code is null or branch is null or account_number is null)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_method in ('bit', 'paybox') and not exists (select 1 from public.creator_payout_details where org_id = p_org and phone is not null) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_method = 'payment_link' and not exists (select 1 from public.creator_payout_details where org_id = p_org and payment_link is not null) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, details) values (auth.uid(), p_org, 'payout_details.saved', jsonb_build_object('method', p_method));
exception when check_violation then raise exception 'invalid_input' using errcode = '22023';
end $$;

create function public.my_payout_details(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select row_to_json(d) from (select method, holder_name, bank_code, branch, account_number, phone, payment_link, note, updated_at
                                        from public.creator_payout_details where org_id = p_org) d);
end $$;

-- A store admin sees a creator's details only to pay an outstanding balance of a real collaboration; every view is audited.
create function public.payee_details(p_store uuid, p_creator uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare v json;
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.agreements where store_org_id = p_store and creator_org_id = p_creator) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (public.creator_pair_balance(p_store, p_creator) ->> 'outstanding_minor')::bigint <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;
  select row_to_json(d) into v from (select method, holder_name, bank_code, branch, account_number, phone, payment_link, note
                                       from public.creator_payout_details where org_id = p_creator) d;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), p_store, 'payout_details.viewed', p_creator::text);
  return v;
end $$;

/* ================= 6. Statement (both sides) ================= */
create function public.creator_statement(p_store uuid, p_creator uuid, p_from date default null, p_to date default null,
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
    'lines', coalesce((select json_agg(json_build_object('date', o.order_created_at, 'order', o.external_order_id, 'type', l.entry_type,
              'base_minor', public.effective_base_minor(o.status, o.total_minor, o.base_minor, o.refunded_minor), 'rate_bps', a.commission_bps,
              'amount_minor', l.amount_minor, 'state', l.state, 'approved_at', l.approved_at) order by l.created_at)
         from public.commission_ledger l join public.attributions a on a.id = l.attribution_id join public.orders o on o.id = a.order_id
        where l.party_role = 'creator' and l.store_org_id = p_store and l.party_org_id = p_creator and l.currency = p_currency
          and l.created_at >= v_from and l.created_at < v_to), '[]'),
    'payments', coalesce((select json_agg(json_build_object('id', p.id, 'paid_on', p.paid_on, 'reported_at', p.paid_at, 'amount_minor', p.amount_minor,
              'vat_minor', p.vat_minor, 'method', p.method, 'reference', p.reference, 'status', case when p.withdrawn_at is not null then 'withdrawn' else p.creator_status end,
              'dispute_reason', p.dispute_reason, 'store_response', p.store_response, 'withdraw_note', p.withdraw_note,
              'proofs', (select json_agg(json_build_object('id', pp.id, 'filename', pp.filename) order by pp.created_at) from public.payout_proofs pp where pp.payout_id = p.id))
              order by p.paid_at)
         from public.creator_payouts p where p.store_org_id = p_store and p.creator_org_id = p_creator and p.currency = p_currency
          and p.paid_at >= v_from and p.paid_at < v_to), '[]'));
end $$;

/* ================= 7. Reminders (run daily; idempotent) ================= */
create function public.creator_payment_reminders() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; b json; n int := 0; v_kind text; v_due text;
begin
  for r in select distinct store_org_id, party_org_id, currency from public.commission_ledger where party_role = 'creator' and state = 'approved' loop
    b := public.creator_pair_balance(r.store_org_id, r.party_org_id, r.currency);
    continue when (b ->> 'outstanding_minor')::bigint <= 0;
    v_kind := case when (b ->> 'overdue')::boolean then 'payout_overdue' when (b ->> 'due_soon')::boolean then 'payout_due_soon' end;
    continue when v_kind is null;
    v_due := b ->> 'due_at';
    continue when exists (select 1 from public.notifications where org_id = r.store_org_id and kind = v_kind
                            and payload ->> 'creator_org_id' = r.party_org_id::text and payload ->> 'due_at' = v_due);
    insert into public.notifications(org_id, kind, payload) values
      (r.store_org_id, v_kind, jsonb_build_object('creator_org_id', r.party_org_id, 'due_at', v_due, 'amount_minor', (b ->> 'outstanding_minor')::bigint,
        'creator', (select name from public.organizations where id = r.party_org_id))),
      (r.party_org_id, v_kind, jsonb_build_object('store_org_id', r.store_org_id, 'creator_org_id', r.party_org_id, 'due_at', v_due,
        'amount_minor', (b ->> 'outstanding_minor')::bigint, 'store', (select name from public.organizations where id = r.store_org_id)));
    n := n + 1;
  end loop;
  return n;
end $$;

/* ================= 8. Dashboard status uses the balance model ================= */
create or replace function public.org_status(p_org uuid) returns json
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
    'payouts_to_confirm', case when public.is_admin(p_org) then (select count(*) from public.creator_payouts where creator_org_id = p_org
                                                                    and creator_status = 'awaiting' and withdrawn_at is null) else 0 end,
    'approved_unpaid_minor', case when not public.is_admin(p_org) then 0 else coalesce((select sum((public.creator_pair_balance(x.s, x.c, x.cur) ->> 'outstanding_minor')::bigint)
                               from (select distinct l.store_org_id s, l.party_org_id c, l.currency cur from public.commission_ledger l
                                      where l.party_role = 'creator' and l.state = 'approved' and (l.store_org_id = p_org or l.party_org_id = p_org)) x), 0) end);
end $$;

/* ================= Security ================= */
alter table public.payout_proofs enable row level security;
alter table public.creator_payout_details enable row level security;
revoke all on public.payout_proofs, public.creator_payout_details from anon, authenticated;   -- functions only

revoke execute on function public.creator_payouts_guard(), public.creator_pair_balance(uuid, uuid, text),
  public.report_creator_payment(uuid, uuid, bigint, bigint, text, date, text, text, text), public.respond_creator_payout(uuid, boolean, text),
  public.answer_payout_dispute(uuid, text), public.withdraw_creator_payout(uuid, text), public.attach_payout_proof(uuid, text, text, text),
  public.get_payout_proof(uuid), public.save_payout_details(uuid, text, text, text, text, text, text, text, text),
  public.my_payout_details(uuid), public.payee_details(uuid, uuid), public.creator_statement(uuid, uuid, date, date, text),
  public.creator_payment_reminders() from public, anon, authenticated;
grant execute on function public.report_creator_payment(uuid, uuid, bigint, bigint, text, date, text, text, text),
  public.respond_creator_payout(uuid, boolean, text), public.answer_payout_dispute(uuid, text), public.withdraw_creator_payout(uuid, text),
  public.attach_payout_proof(uuid, text, text, text), public.get_payout_proof(uuid),
  public.save_payout_details(uuid, text, text, text, text, text, text, text, text), public.my_payout_details(uuid),
  public.payee_details(uuid, uuid), public.creator_statement(uuid, uuid, date, date, text)
  to authenticated;
grant execute on function public.creator_payment_reminders() to service_role;

-- LINKUP — automatic collection of the LINKUP fee (stages 1–3: provider-neutral layer, simulated provider in dev).
--  * The store saves a payment method once at the provider's hosted page; LINKUP keeps only the provider's token
--    reference and a masked card (never card numbers).
--  * When to charge is the store's explicit, recorded choice — never assumed: N days after verified delivery
--    (0..14) or on the contractual due date. The contractual due date stays delivery + 14 days.
--  * Master switch auto_collection_enabled = false: nothing is scheduled or charged until switched on.
--  * Failed charge → retries per collection_retry_days → exception for the owner. Refunds and tax documents go
--    through the provider; every step is recorded and nothing is deleted.
--  * A payment request with an open dispute is not charged automatically (exception instead).

insert into public.app_settings(key, value) values
  ('auto_collection_enabled', 'false'),
  ('billing_provider', '"simulated"'),
  ('collection_retry_days', '[2, 5]')
on conflict (key) do nothing;

create function public.setting_text(p_key text) returns text
language sql stable security definer set search_path = '' as $$ select value #>> '{}' from public.app_settings where key = p_key $$;
create function public.setting_json(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$ select value::jsonb from public.app_settings where key = p_key $$;
revoke execute on function public.setting_text(text), public.setting_json(text) from public, anon, authenticated;

/* ================= Payment methods ================= */
create table public.billing_payment_methods (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  provider text not null check (provider in ('simulated', 'morning')),
  token_ref text not null check (char_length(token_ref) between 4 and 200),
  brand text check (char_length(brand) <= 30),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  exp_month int check (exp_month between 1 and 12),
  exp_year int check (exp_year between 2024 and 2100),
  charge_timing text not null check (charge_timing in ('days_after_delivery', 'on_due_date')),
  charge_days int check (charge_days between 0 and 14),
  authorization_version text not null check (char_length(authorization_version) between 1 and 40),
  authorized_by uuid not null,
  authorized_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  ended_at timestamptz,
  check (charge_timing = 'on_due_date' or charge_days is not null)
);
create unique index billing_payment_methods_active_uq on public.billing_payment_methods(store_org_id) where status = 'active';
create function public.billing_methods_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if old.status <> 'active' or new.status = 'active'
     or (new.store_org_id, new.provider, new.token_ref, new.charge_timing, new.charge_days, new.authorized_at)
        is distinct from (old.store_org_id, old.provider, old.token_ref, old.charge_timing, old.charge_days, old.authorized_at) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger billing_payment_methods_guard before update or delete on public.billing_payment_methods
  for each row execute function public.billing_methods_guard();

/* ================= Charges, refunds, webhook log ================= */
create table public.billing_charges (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  store_org_id uuid not null references public.organizations(id),
  payment_method_id uuid not null references public.billing_payment_methods(id),
  attempt int not null check (attempt between 1 and 10),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'processing', 'succeeded', 'failed', 'cancelled')),
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  provider_ref text check (char_length(provider_ref) <= 200),
  failure_code text check (char_length(failure_code) <= 60),
  failure_message text check (char_length(failure_message) <= 300),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  unique (invoice_id, attempt)
);
create index billing_charges_due_idx on public.billing_charges(status, scheduled_for);
create function public.billing_charges_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if (new.invoice_id, new.store_org_id, new.payment_method_id, new.attempt, new.amount_minor, new.currency, new.idempotency_key, new.scheduled_for)
     is distinct from (old.invoice_id, old.store_org_id, old.payment_method_id, old.attempt, old.amount_minor, old.currency, old.idempotency_key, old.scheduled_for)
     or not ((old.status = 'scheduled' and new.status in ('processing', 'cancelled')) or (old.status = 'processing' and new.status in ('succeeded', 'failed'))) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger billing_charges_guard before update or delete on public.billing_charges for each row execute function public.billing_charges_guard();

create table public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.billing_charges(id),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null check (char_length(reason) between 3 and 300),
  status text not null default 'requested' check (status in ('requested', 'processing', 'succeeded', 'failed')),
  provider_ref text,
  failure_message text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create trigger billing_refunds_no_delete before delete on public.billing_refunds for each row execute function public.forbid_change();

create table public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  kind text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);
create trigger billing_webhook_events_append_only before update or delete on public.billing_webhook_events
  for each row execute function public.forbid_change();

/* ================= Store: payment method ================= */
create function public.save_payment_method(p_store uuid, p_provider text, p_token_ref text, p_brand text, p_last4 text,
                                           p_exp_month int, p_exp_year int, p_charge_timing text, p_charge_days int,
                                           p_authorization_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_admin(p_store) or (select type from public.organizations where id = p_store) <> 'store' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_provider is distinct from (public.setting_text('billing_provider')) then raise exception 'invalid_input' using errcode = '22023'; end if;
  if coalesce(btrim(p_authorization_version), '') = '' then raise exception 'legal_acceptance_required' using errcode = '42501'; end if;
  update public.billing_payment_methods set status = 'replaced', ended_at = now() where store_org_id = p_store and status = 'active';
  insert into public.billing_payment_methods(store_org_id, provider, token_ref, brand, last4, exp_month, exp_year, charge_timing, charge_days,
                                             authorization_version, authorized_by)
  values (p_store, p_provider, p_token_ref, p_brand, p_last4, p_exp_month, p_exp_year, p_charge_timing,
          case when p_charge_timing = 'on_due_date' then null else p_charge_days end, p_authorization_version, auth.uid())
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_store, 'billing.method_saved', v_id::text,
          jsonb_build_object('timing', p_charge_timing, 'days', p_charge_days, 'last4', p_last4, 'authorization', p_authorization_version));
  return v_id;
exception when check_violation then raise exception 'invalid_input' using errcode = '22023';
end $$;

create function public.remove_payment_method(p_store uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.billing_payment_methods set status = 'removed', ended_at = now() where store_org_id = p_store and status = 'active';
  -- charges not yet started for this store are cancelled (nothing is charged without a valid authorization)
  update public.billing_charges set status = 'cancelled', completed_at = now(), failure_code = 'method_removed'
   where store_org_id = p_store and status = 'scheduled';
  insert into public.audit_events(actor_user_id, org_id, action) values (auth.uid(), p_store, 'billing.method_removed');
end $$;

create function public.my_billing(p_store uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'provider', public.setting_text('billing_provider'),
    'auto_enabled', public.setting_bool('auto_collection_enabled'),
    'payment_terms_days', public.setting_int('payment_terms_days'),
    'method', (select json_build_object('brand', brand, 'last4', last4, 'exp_month', exp_month, 'exp_year', exp_year,
                 'charge_timing', charge_timing, 'charge_days', charge_days, 'authorized_at', authorized_at)
                 from public.billing_payment_methods where store_org_id = p_store and status = 'active'),
    'charges', coalesce((select json_agg(json_build_object('invoice_id', invoice_id, 'attempt', attempt, 'amount_minor', amount_minor,
                 'status', status, 'scheduled_for', scheduled_for, 'completed_at', completed_at, 'failure_message', failure_message)
                 order by created_at desc)
               from public.billing_charges where store_org_id = p_store), '[]'));
end $$;

/* ================= Internal settlement used by manual "paid" and by automatic charges ================= */
create function public.settle_invoice_payment(p_invoice uuid, p_reference text, p_actor uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_n int;
begin
  update public.invoices set status = 'paid', paid_at = now(), paid_reference = nullif(btrim(coalesce(p_reference, '')), '')
   where id = p_invoice and status = 'issued' returning store_org_id into v_store;
  if v_store is null then raise exception 'invoice_not_payable' using errcode = '22023'; end if;
  v_n := public.settle_invoice_rewards(p_invoice);
  insert into public.funnel_events(event, org_id) values ('invoice_paid', v_store);
  insert into public.audit_events(actor_user_id, org_id, action, target) values (p_actor, v_store, 'invoice.paid', p_invoice::text);
  -- an automatic charge still waiting for this request is no longer needed
  update public.billing_charges set status = 'cancelled', completed_at = now(), failure_code = 'paid_otherwise'
   where invoice_id = p_invoice and status = 'scheduled';
  return v_n;
end $$;

create or replace function public.mark_invoice_paid(p_invoice uuid, p_reference text) returns int
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.billing_charges where invoice_id = p_invoice and status = 'processing') then
    raise exception 'charge_in_progress' using errcode = '22023';
  end if;
  return public.settle_invoice_payment(p_invoice, p_reference, auth.uid());
end $$;

/* ================= Runner functions (service role: the billing worker) ================= */
create function public.billing_charge_date(p_invoice uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case when m.charge_timing = 'on_due_date' then i.due_at
              else least(i.due_at, i.delivered_at + make_interval(days => m.charge_days)) end
    from public.invoices i join public.billing_payment_methods m on m.store_org_id = i.store_org_id and m.status = 'active'
   where i.id = p_invoice and i.delivered_at is not null;
$$;

create function public.billing_schedule() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  if not public.setting_bool('auto_collection_enabled') then return 0; end if;
  for r in select i.id, i.store_org_id, i.total_minor, i.currency, m.id as method_id
             from public.invoices i join public.billing_payment_methods m on m.store_org_id = i.store_org_id and m.status = 'active'
            where i.status = 'issued' and i.delivered_at is not null and i.total_minor > 0
              and m.provider = public.setting_text('billing_provider')
              and not exists (select 1 from public.billing_charges c where c.invoice_id = i.id)
              and not exists (select 1 from public.invoice_disputes d where d.invoice_id = i.id and d.resolved_at is null) loop
    insert into public.billing_charges(invoice_id, store_org_id, payment_method_id, attempt, amount_minor, currency, scheduled_for, idempotency_key)
    values (r.id, r.store_org_id, r.method_id, 1, r.total_minor, r.currency, public.billing_charge_date(r.id), 'inv:' || r.id || ':1');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Claims due charges for processing (skips rows another worker holds). Re-checks every condition at claim time.
create function public.billing_claim_due(p_limit int default 20) returns json
language plpgsql security definer set search_path = '' as $$
declare v json;
begin
  if not public.setting_bool('auto_collection_enabled') then return '[]'; end if;
  with due as (
    select c.id from public.billing_charges c
      join public.invoices i on i.id = c.invoice_id
      join public.billing_payment_methods m on m.id = c.payment_method_id
     where c.status = 'scheduled' and c.scheduled_for <= now() and i.status = 'issued' and m.status = 'active'
       and not exists (select 1 from public.invoice_disputes d where d.invoice_id = i.id and d.resolved_at is null)
     order by c.scheduled_for limit p_limit for update of c skip locked
  ), claimed as (
    update public.billing_charges c set status = 'processing', started_at = now() from due where c.id = due.id returning c.*
  )
  select coalesce(json_agg(json_build_object('charge_id', cl.id, 'invoice_id', cl.invoice_id, 'store_org_id', cl.store_org_id,
           'amount_minor', cl.amount_minor, 'currency', cl.currency, 'attempt', cl.attempt, 'idempotency_key', cl.idempotency_key,
           'provider', m.provider, 'token_ref', m.token_ref)), '[]') into v
    from claimed cl join public.billing_payment_methods m on m.id = cl.payment_method_id;
  return v;
end $$;

create function public.billing_complete_charge(p_charge uuid, p_success boolean, p_provider_ref text, p_failure_code text, p_failure_message text)
returns json
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_retry jsonb := public.setting_json('collection_retry_days'); v_days int; v_next uuid;
begin
  select * into c from public.billing_charges where id = p_charge for update;
  if not found or c.status <> 'processing' then raise exception 'not_found' using errcode = '22023'; end if;
  if p_success then
    update public.billing_charges set status = 'succeeded', completed_at = now(), provider_ref = p_provider_ref where id = p_charge;
    perform public.settle_invoice_payment(c.invoice_id, 'auto:' || coalesce(p_provider_ref, c.id::text), null);
    insert into public.notifications(org_id, kind, payload) values (c.store_org_id, 'charge_succeeded', jsonb_build_object('invoice_id', c.invoice_id, 'amount_minor', c.amount_minor));
    return json_build_object('result', 'paid');
  end if;
  update public.billing_charges set status = 'failed', completed_at = now(), provider_ref = p_provider_ref,
         failure_code = left(p_failure_code, 60), failure_message = left(p_failure_message, 300) where id = p_charge;
  v_days := (v_retry ->> (c.attempt - 1))::int;    -- NULL when no retry left
  if v_days is not null and (select status from public.invoices where id = c.invoice_id) = 'issued' then
    insert into public.billing_charges(invoice_id, store_org_id, payment_method_id, attempt, amount_minor, currency, scheduled_for, idempotency_key)
    values (c.invoice_id, c.store_org_id, c.payment_method_id, c.attempt + 1, c.amount_minor, c.currency, now() + make_interval(days => v_days),
            'inv:' || c.invoice_id || ':' || (c.attempt + 1))
    returning id into v_next;
    insert into public.notifications(org_id, kind, payload) values (c.store_org_id, 'charge_failed', jsonb_build_object('invoice_id', c.invoice_id, 'retry_in_days', v_days));
    return json_build_object('result', 'retry_scheduled', 'next_charge', v_next);
  end if;
  insert into public.notifications(org_id, kind, payload) values (c.store_org_id, 'charge_failed_final', jsonb_build_object('invoice_id', c.invoice_id));
  insert into public.audit_events(org_id, action, target, details) values (c.store_org_id, 'billing.charge_failed_final', c.invoice_id::text,
          jsonb_build_object('code', p_failure_code));
  return json_build_object('result', 'failed_final');
end $$;

-- Tax document issued by the provider for a paid request / refund (the worker records it; nothing is typed by hand).
create function public.billing_record_document(p_invoice uuid, p_doc_type text, p_number text, p_issued_on date, p_amount_minor bigint,
                                               p_vat_minor bigint, p_provider text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_cur text; v_id uuid;
begin
  select store_org_id, currency into v_org, v_cur from public.invoices where id = p_invoice;
  if v_org is null then raise exception 'not_found' using errcode = '22023'; end if;
  select id into v_id from public.accounting_documents where invoice_id = p_invoice and issuer = 'linkup' and doc_number = p_number;
  if v_id is not null then return v_id; end if;   -- idempotent
  insert into public.accounting_documents(issuer, doc_type, doc_number, issued_on, org_id, invoice_id, currency, amount_minor, vat_minor, software, note)
  values ('linkup', p_doc_type, p_number, p_issued_on, v_org, p_invoice, v_cur, p_amount_minor, coalesce(p_vat_minor, 0), p_provider, p_note)
  returning id into v_id;
  return v_id;
end $$;

create function public.billing_record_webhook(p_provider text, p_event_id text, p_kind text, p_payload jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.billing_webhook_events(provider, event_id, kind, payload) values (p_provider, p_event_id, p_kind, p_payload);
  return 'new';
exception when unique_violation then return 'duplicate';
end $$;

create function public.billing_invoice_summary(p_invoice uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('fees_minor', fees_minor, 'vat_minor', vat_minor, 'total_minor', total_minor, 'credit_minor', credit_minor,
                           'currency', currency, 'store_org_id', store_org_id) from public.invoices where id = p_invoice;
$$;
revoke execute on function public.billing_invoice_summary(uuid) from public, anon, authenticated;
grant execute on function public.billing_invoice_summary(uuid) to service_role;

/* ================= Admin: refunds, manual retry ================= */
create function public.request_refund(p_charge uuid, p_amount_minor bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_id uuid; v_done bigint;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into c from public.billing_charges where id = p_charge;
  if not found or c.status <> 'succeeded' then raise exception 'not_found' using errcode = '22023'; end if;
  select coalesce(sum(amount_minor), 0) into v_done from public.billing_refunds where charge_id = p_charge and status <> 'failed';
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > c.amount_minor - v_done then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  insert into public.billing_refunds(charge_id, amount_minor, reason, requested_by) values (p_charge, p_amount_minor, btrim(p_reason), auth.uid()) returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details) values (auth.uid(), c.store_org_id, 'billing.refund_requested', v_id::text,
          jsonb_build_object('amount_minor', p_amount_minor));
  return v_id;
end $$;

create function public.billing_claim_refunds(p_limit int default 20) returns json
language plpgsql security definer set search_path = '' as $$
declare v json;
begin
  with due as (select r.id from public.billing_refunds r where r.status = 'requested' order by r.created_at limit p_limit for update skip locked),
  claimed as (update public.billing_refunds r set status = 'processing' from due where r.id = due.id returning r.*)
  select coalesce(json_agg(json_build_object('refund_id', cl.id, 'charge_id', cl.charge_id, 'amount_minor', cl.amount_minor,
           'provider_ref', c.provider_ref, 'invoice_id', c.invoice_id, 'currency', c.currency, 'provider', m.provider)), '[]') into v
    from claimed cl join public.billing_charges c on c.id = cl.charge_id join public.billing_payment_methods m on m.id = c.payment_method_id;
  return v;
end $$;

create function public.billing_complete_refund(p_refund uuid, p_success boolean, p_provider_ref text, p_failure_message text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.billing_refunds; v_store uuid;
begin
  select * into r from public.billing_refunds where id = p_refund for update;
  if not found or r.status <> 'processing' then raise exception 'not_found' using errcode = '22023'; end if;
  update public.billing_refunds set status = case when p_success then 'succeeded' else 'failed' end, completed_at = now(),
         provider_ref = p_provider_ref, failure_message = left(p_failure_message, 300) where id = p_refund;
  select store_org_id into v_store from public.billing_charges where id = r.charge_id;
  insert into public.notifications(org_id, kind, payload) values (v_store, case when p_success then 'refund_succeeded' else 'refund_failed' end,
          jsonb_build_object('amount_minor', r.amount_minor));
end $$;

create function public.retry_charge_now(p_invoice uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_id uuid; m uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into c from public.billing_charges where invoice_id = p_invoice order by attempt desc limit 1;
  if not found or c.status <> 'failed' or (select status from public.invoices where id = p_invoice) <> 'issued' then
    raise exception 'not_found' using errcode = '22023';
  end if;
  select id into m from public.billing_payment_methods where store_org_id = c.store_org_id and status = 'active';
  if m is null then raise exception 'no_payment_method' using errcode = '22023'; end if;
  insert into public.billing_charges(invoice_id, store_org_id, payment_method_id, attempt, amount_minor, currency, scheduled_for, idempotency_key)
  values (p_invoice, c.store_org_id, m, c.attempt + 1, c.amount_minor, c.currency, now(), 'inv:' || p_invoice || ':' || (c.attempt + 1))
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), c.store_org_id, 'billing.retry_now', p_invoice::text);
  return v_id;
end $$;

/* ================= Owner: finance dashboard and exceptions queue ================= */
create function public.finance_dashboard() returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_m timestamptz := date_trunc('month', now());
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'auto_enabled', public.setting_bool('auto_collection_enabled'),
    'provider', public.setting_text('billing_provider'),
    'fees_accrued_month_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and created_at >= v_m),
    'fees_pending_minor', (select coalesce(sum(amount_minor), 0) from public.commission_ledger where party_role = 'platform' and state = 'pending'),
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
end $$;

create function public.billing_exceptions() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.since) from (
    -- final failed charge on an open request
    select 'charge_failed' as kind, o.name as org, i.store_org_id as org_id, i.id::text as ref, c.failure_message as detail, c.completed_at as since, 'retry' as action
      from public.billing_charges c join public.invoices i on i.id = c.invoice_id join public.organizations o on o.id = i.store_org_id
     where c.status = 'failed' and i.status = 'issued'
       and not exists (select 1 from public.billing_charges n where n.invoice_id = c.invoice_id and n.attempt > c.attempt)
    union all
    select 'request_not_delivered', o.name, i.store_org_id, i.id::text, '#' || i.number, i.issued_at, 'deliver'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'issued' and i.delivered_at is null and i.issued_at < now() - interval '2 days'
    union all
    select 'request_overdue', o.name, i.store_org_id, i.id::text, '#' || i.number, i.due_at, 'contact'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'issued' and i.due_at < now()
       and not exists (select 1 from public.billing_charges c where c.invoice_id = i.id and c.status in ('scheduled', 'processing'))
    union all
    select 'request_disputed', o.name, d.org_id, d.invoice_id::text, d.reason, d.created_at, 'resolve'
      from public.invoice_disputes d join public.organizations o on o.id = d.org_id where d.resolved_at is null
    union all
    select 'document_missing', o.name, i.store_org_id, i.id::text, '#' || i.number, i.paid_at, 'document'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'paid' and not exists (select 1 from public.accounting_documents a where a.invoice_id = i.id and a.issuer = 'linkup')
    union all
    select 'refund_failed', o.name, c.store_org_id, r.id::text, r.failure_message, r.completed_at, 'refund'
      from public.billing_refunds r join public.billing_charges c on c.id = r.charge_id join public.organizations o on o.id = c.store_org_id
     where r.status = 'failed'
    union all
    select 'tax_profile_unverified', o.name, t.org_id, t.org_id::text, t.classification, t.updated_at, 'verify'
      from public.tax_profiles t join public.organizations o on o.id = t.org_id where t.verified_at is null
    union all
    select 'payout_disputed', o.name, p.store_org_id, p.id::text, p.dispute_reason, p.creator_responded_at, 'follow_up'
      from public.creator_payouts p join public.organizations o on o.id = p.creator_org_id
     where p.creator_status = 'disputed' and p.withdrawn_at is null
  ) x), '[]');
end $$;

/* ================= Admin list: automatic charges per request ================= */
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
             public.invoice_lines(i.id) as lines,
             (select json_agg(json_build_object('id', c.id, 'attempt', c.attempt, 'status', c.status, 'amount_minor', c.amount_minor,
                      'scheduled_for', c.scheduled_for, 'failure_message', c.failure_message,
                      'refunded_minor', (select coalesce(sum(r.amount_minor), 0) from public.billing_refunds r where r.charge_id = c.id and r.status <> 'failed'))
                      order by c.attempt) from public.billing_charges c where c.invoice_id = i.id) as charges,
             (select json_agg(json_build_object('id', d.id, 'disputed_minor', d.disputed_minor, 'reason', d.reason, 'evidence', d.evidence,
                      'created_at', d.created_at, 'resolved_at', d.resolved_at, 'resolution', d.resolution) order by d.created_at)
                from public.invoice_disputes d where d.invoice_id = i.id) as disputes,
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
       from public.tax_profiles t join public.organizations o on o.id = t.org_id), '[]'),
    'wind_down', coalesce((select json_agg(json_build_object('org_id', o.id, 'org', o.name)) from public.organizations o
                            where o.type = 'store' and public.store_new_activity_blocked(o.id)), '[]'));
end $$;

/* ================= Security ================= */
alter table public.billing_payment_methods enable row level security;
alter table public.billing_charges enable row level security;
alter table public.billing_refunds enable row level security;
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_payment_methods, public.billing_charges, public.billing_refunds, public.billing_webhook_events from anon, authenticated;

revoke execute on function public.billing_methods_guard(), public.billing_charges_guard(),
  public.save_payment_method(uuid, text, text, text, text, int, int, text, int, text), public.remove_payment_method(uuid), public.my_billing(uuid),
  public.settle_invoice_payment(uuid, text, uuid), public.billing_charge_date(uuid), public.billing_schedule(), public.billing_claim_due(int),
  public.billing_complete_charge(uuid, boolean, text, text, text), public.billing_record_document(uuid, text, text, date, bigint, bigint, text, text),
  public.billing_record_webhook(text, text, text, jsonb), public.request_refund(uuid, bigint, text), public.billing_claim_refunds(int),
  public.billing_complete_refund(uuid, boolean, text, text), public.retry_charge_now(uuid), public.finance_dashboard(), public.billing_exceptions()
  from public, anon, authenticated;
grant execute on function public.save_payment_method(uuid, text, text, text, text, int, int, text, int, text), public.remove_payment_method(uuid),
  public.my_billing(uuid), public.request_refund(uuid, bigint, text), public.retry_charge_now(uuid), public.finance_dashboard(), public.billing_exceptions()
  to authenticated;
grant execute on function public.billing_schedule(), public.billing_claim_due(int), public.billing_complete_charge(uuid, boolean, text, text, text),
  public.billing_record_document(uuid, text, text, date, bigint, bigint, text, text), public.billing_record_webhook(text, text, text, jsonb),
  public.billing_claim_refunds(int), public.billing_complete_refund(uuid, boolean, text, text), public.creator_payment_reminders()
  to service_role;

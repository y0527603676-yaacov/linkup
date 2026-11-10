-- LINKUP — no second charge while an earlier result is unknown (owner instruction 10.11.2026).
--  * A charge whose result is not known (timeout, lost response, provider 5xx, worker stopped mid-call) becomes
--    'unknown'. Nothing else is charged for that payment request until it is resolved: by the provider's status
--    query, by a provider webhook, or by the owner after checking the provider's dashboard.
--  * Only a DEFINITIVE decline leads to the normal retry policy.
--  * Webhooks are applied, not only stored: a late/duplicate success settles once (one payment request = one charge);
--    a success that arrives after the request was already paid otherwise raises an alert for a refund decision and
--    cancels any waiting charge immediately.

/* ================= 1. 'unknown' status and resolution trail ================= */
alter table public.billing_charges drop constraint billing_charges_status_check;
alter table public.billing_charges add constraint billing_charges_status_check
  check (status in ('scheduled', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled'));
alter table public.billing_charges add column unknown_since timestamptz;
alter table public.billing_charges add column resolution_source text check (resolution_source in ('provider_query', 'webhook', 'admin'));
alter table public.billing_charges add column resolution_note text check (char_length(resolution_note) <= 300);
alter table public.billing_charges add column resolved_by uuid;
-- one payment request is paid by at most one successful charge
create unique index billing_charges_one_success_uq on public.billing_charges(invoice_id) where status = 'succeeded';

create or replace function public.billing_charges_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if (new.invoice_id, new.store_org_id, new.payment_method_id, new.attempt, new.amount_minor, new.currency, new.idempotency_key, new.scheduled_for)
     is distinct from (old.invoice_id, old.store_org_id, old.payment_method_id, old.attempt, old.amount_minor, old.currency, old.idempotency_key, old.scheduled_for)
     or not ((old.status = 'scheduled' and new.status in ('processing', 'cancelled'))
          or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'unknown'))
          or (old.status = 'unknown' and new.status in ('succeeded', 'failed'))) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;

-- Provider signals that need the owner (append-only): e.g. money taken although the request was already paid.
create table public.billing_alerts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  charge_id uuid references public.billing_charges(id),
  kind text not null check (kind in ('payment_after_paid', 'success_after_decline')),
  provider text not null,
  provider_ref text,
  detail text,
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid,
  handled_note text check (char_length(handled_note) <= 300)
);
alter table public.billing_alerts enable row level security;
create unique index billing_alerts_once_uq on public.billing_alerts(invoice_id, kind, coalesce(provider_ref, ''));
create function public.billing_alerts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.handled_at is not null
     or (new.invoice_id, new.charge_id, new.kind, new.provider, new.provider_ref, new.detail, new.created_at)
        is distinct from (old.invoice_id, old.charge_id, old.kind, old.provider, old.provider_ref, old.detail, old.created_at) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger billing_alerts_guard before update or delete on public.billing_alerts for each row execute function public.billing_alerts_guard();

/* ================= 2. After a definitive failure: the retry policy (shared) ================= */
create function public.billing_after_failure(p_charge uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_days int; v_next uuid;
begin
  select * into c from public.billing_charges where id = p_charge;
  v_days := (public.setting_json('collection_retry_days') ->> (c.attempt - 1))::int;    -- NULL when no retry left
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
          jsonb_build_object('code', c.failure_code));
  return json_build_object('result', 'failed_final');
end $$;

-- Success (worker, status query, webhook or owner): settle once. If the request was already paid otherwise → alert.
create function public.billing_after_success(p_charge uuid, p_provider_ref text) returns json
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_status text;
begin
  select * into c from public.billing_charges where id = p_charge;
  select status into v_status from public.invoices where id = c.invoice_id for update;
  if v_status = 'issued' then
    perform public.settle_invoice_payment(c.invoice_id, 'auto:' || coalesce(p_provider_ref, c.id::text), null);
    insert into public.notifications(org_id, kind, payload) values (c.store_org_id, 'charge_succeeded', jsonb_build_object('invoice_id', c.invoice_id, 'amount_minor', c.amount_minor));
    return json_build_object('result', 'paid');
  end if;
  insert into public.billing_alerts(invoice_id, charge_id, kind, provider, provider_ref, detail)
  values (c.invoice_id, c.id, 'payment_after_paid', (select provider from public.billing_payment_methods where id = c.payment_method_id), p_provider_ref,
          'request status: ' || coalesce(v_status, '?'))
  on conflict do nothing;
  return json_build_object('result', 'alert_payment_after_paid');
end $$;

/* ================= 3. Worker: complete (definitive), mark unknown, sweep stale ================= */
create or replace function public.billing_complete_charge(p_charge uuid, p_success boolean, p_provider_ref text, p_failure_code text, p_failure_message text)
returns json
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges;
begin
  select * into c from public.billing_charges where id = p_charge for update;
  if not found or c.status <> 'processing' then raise exception 'not_found' using errcode = '22023'; end if;
  if p_success then
    update public.billing_charges set status = 'succeeded', completed_at = now(), provider_ref = p_provider_ref where id = p_charge;
    return public.billing_after_success(p_charge, p_provider_ref);
  end if;
  -- only a DEFINITIVE decline reaches here; unknown results go to billing_mark_unknown
  update public.billing_charges set status = 'failed', completed_at = now(), provider_ref = p_provider_ref,
         failure_code = left(p_failure_code, 60), failure_message = left(p_failure_message, 300) where id = p_charge;
  return public.billing_after_failure(p_charge);
end $$;

create function public.billing_mark_unknown(p_charge uuid, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges;
begin
  select * into c from public.billing_charges where id = p_charge for update;
  if not found or c.status <> 'processing' then raise exception 'not_found' using errcode = '22023'; end if;
  update public.billing_charges set status = 'unknown', unknown_since = now(), failure_message = left(p_detail, 300) where id = p_charge;
  insert into public.audit_events(org_id, action, target, details) values (c.store_org_id, 'billing.charge_unknown', c.invoice_id::text,
          jsonb_build_object('charge', c.id, 'detail', left(p_detail, 300)));
end $$;

-- A charge left 'processing' (the worker stopped after calling the provider) is unknown, never retried blindly.
create function public.billing_sweep_stale(p_minutes int default 15) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.billing_charges set status = 'unknown', unknown_since = now(), failure_message = 'worker stopped during the charge'
   where status = 'processing' and started_at < now() - make_interval(mins => p_minutes);
  get diagnostics n = row_count;
  return n;
end $$;

-- Unknown charges for the worker to look up at the provider.
create function public.billing_unknown_open() returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('charge_id', c.id, 'invoice_id', c.invoice_id, 'provider', m.provider, 'attempt', c.attempt,
                  'unknown_since', c.unknown_since) order by c.unknown_since), '[]')
    from public.billing_charges c join public.billing_payment_methods m on m.id = c.payment_method_id where c.status = 'unknown';
$$;

-- Resolve an unknown charge. 'succeeded' settles (or alerts); 'failed' only with a definitive provider answer or the
-- owner's decision — then the normal retry policy applies.
create function public.billing_resolve_unknown(p_charge uuid, p_outcome text, p_provider_ref text, p_source text, p_note text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges;
begin
  if p_outcome not in ('succeeded', 'failed') or p_source not in ('provider_query', 'webhook', 'admin') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into c from public.billing_charges where id = p_charge for update;
  if not found or c.status <> 'unknown' then raise exception 'not_found' using errcode = '22023'; end if;
  update public.billing_charges set status = p_outcome, completed_at = now(), provider_ref = coalesce(p_provider_ref, provider_ref),
         resolution_source = p_source, resolution_note = left(p_note, 300), resolved_by = auth.uid(),
         failure_code = case when p_outcome = 'failed' then 'resolved_failed' end
   where id = p_charge;
  insert into public.audit_events(actor_user_id, org_id, action, target, details) values (auth.uid(), c.store_org_id, 'billing.unknown_resolved',
          c.invoice_id::text, jsonb_build_object('charge', c.id, 'outcome', p_outcome, 'source', p_source, 'note', left(p_note, 300)));
  if p_outcome = 'succeeded' then return public.billing_after_success(p_charge, p_provider_ref); end if;
  return public.billing_after_failure(p_charge);
end $$;

-- Owner decision after checking the provider's dashboard (reason required).
create function public.admin_resolve_charge(p_charge uuid, p_outcome text, p_provider_ref text, p_note text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  return public.billing_resolve_unknown(p_charge, p_outcome, nullif(btrim(coalesce(p_provider_ref, '')), ''), 'admin', btrim(p_note));
end $$;

/* ================= 4. Claiming and manual payment respect unknown results ================= */
create or replace function public.billing_claim_due(p_limit int default 20) returns json
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
       -- never while another attempt of the same request is running or its result is unknown
       and not exists (select 1 from public.billing_charges o where o.invoice_id = c.invoice_id and o.status in ('processing', 'unknown', 'succeeded'))
       and not exists (select 1 from public.billing_alerts a where a.invoice_id = c.invoice_id and a.handled_at is null)
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

create or replace function public.mark_invoice_paid(p_invoice uuid, p_reference text) returns int
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.billing_charges where invoice_id = p_invoice and status = 'processing') then
    raise exception 'charge_in_progress' using errcode = '22023';
  end if;
  if exists (select 1 from public.billing_charges where invoice_id = p_invoice and status = 'unknown') then
    raise exception 'charge_outcome_unknown' using errcode = '22023';
  end if;
  return public.settle_invoice_payment(p_invoice, p_reference, auth.uid());
end $$;

create or replace function public.retry_charge_now(p_invoice uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_id uuid; m uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.billing_charges where invoice_id = p_invoice and status in ('processing', 'unknown', 'scheduled', 'succeeded'))
     or exists (select 1 from public.billing_alerts where invoice_id = p_invoice and handled_at is null) then
    raise exception 'charge_outcome_unknown' using errcode = '22023';
  end if;
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

/* ================= 5. Applying provider events (webhooks) — idempotent per request ================= */
-- p_outcome: 'succeeded' | 'failed'. Duplicate and late deliveries are harmless: one request = one successful charge.
create function public.billing_apply_provider_event(p_provider text, p_event_id text, p_invoice uuid, p_outcome text, p_provider_ref text)
returns text
language plpgsql security definer set search_path = '' as $$
declare c public.billing_charges; v_inv text; v_paid_ref text;
begin
  if p_outcome not in ('succeeded', 'failed') then raise exception 'invalid_input' using errcode = '22023'; end if;
  select status, paid_reference into v_inv, v_paid_ref from public.invoices where id = p_invoice for update;
  if v_inv is null then return 'unknown_request'; end if;
  select * into c from public.billing_charges where invoice_id = p_invoice order by attempt desc limit 1 for update;
  if p_outcome = 'failed' then
    if c.status = 'unknown' then perform public.billing_resolve_unknown(c.id, 'failed', p_provider_ref, 'webhook', p_event_id); return 'resolved_failed'; end if;
    return 'ignored';
  end if;
  -- success
  if exists (select 1 from public.billing_charges where invoice_id = p_invoice and status = 'succeeded') then return 'duplicate'; end if;
  if c.status = 'unknown' then perform public.billing_resolve_unknown(c.id, 'succeeded', p_provider_ref, 'webhook', p_event_id); return 'resolved_paid'; end if;
  if c.status = 'processing' then return 'in_progress'; end if;   -- the worker will complete it; the event stays stored
  -- money taken although LINKUP saw a decline, or the request was paid otherwise → stop waiting charges, alert the owner
  update public.billing_charges set status = 'cancelled', completed_at = now(), failure_code = 'provider_reported_payment'
   where invoice_id = p_invoice and status = 'scheduled';
  insert into public.billing_alerts(invoice_id, charge_id, kind, provider, provider_ref, detail)
  values (p_invoice, c.id, case when v_inv = 'issued' then 'success_after_decline' else 'payment_after_paid' end, p_provider, p_provider_ref,
          'event ' || p_event_id || '; request ' || v_inv || coalesce('; paid ref ' || v_paid_ref, ''))
  on conflict do nothing;
  return 'alert';
end $$;

create function public.handle_billing_alert(p_alert uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.billing_alerts set handled_at = now(), handled_by = auth.uid(), handled_note = btrim(p_note) where id = p_alert and handled_at is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
end $$;

/* ================= 6. Exceptions queue: unknown results and provider alerts first ================= */
create or replace function public.billing_exceptions() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.prio, x.since) from (
    select 0 as prio, 'charge_unknown' as kind, o.name as org, c.store_org_id as org_id, c.id::text as ref,
           '#' || i.number || ' · ' || coalesce(c.failure_message, '') as detail, c.unknown_since as since, 'resolve' as action
      from public.billing_charges c join public.invoices i on i.id = c.invoice_id join public.organizations o on o.id = c.store_org_id
     where c.status = 'unknown'
    union all
    select 0, 'provider_alert', o.name, i.store_org_id, a.id::text, a.kind || ' · #' || i.number || ' · ' || coalesce(a.provider_ref, ''), a.created_at, 'alert'
      from public.billing_alerts a join public.invoices i on i.id = a.invoice_id join public.organizations o on o.id = i.store_org_id
     where a.handled_at is null
    union all
    select 1, 'charge_failed', o.name, i.store_org_id, i.id::text, c.failure_message, c.completed_at, 'retry'
      from public.billing_charges c join public.invoices i on i.id = c.invoice_id join public.organizations o on o.id = i.store_org_id
     where c.status = 'failed' and i.status = 'issued'
       and not exists (select 1 from public.billing_charges n where n.invoice_id = c.invoice_id and n.attempt > c.attempt)
    union all
    select 1, 'request_not_delivered', o.name, i.store_org_id, i.id::text, '#' || i.number, i.issued_at, 'deliver'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'issued' and i.delivered_at is null and i.issued_at < now() - interval '2 days'
    union all
    select 1, 'request_overdue', o.name, i.store_org_id, i.id::text, '#' || i.number, i.due_at, 'contact'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'issued' and i.due_at < now()
       and not exists (select 1 from public.billing_charges c where c.invoice_id = i.id and c.status in ('scheduled', 'processing', 'unknown'))
    union all
    select 1, 'request_disputed', o.name, d.org_id, d.invoice_id::text, d.reason, d.created_at, 'resolve'
      from public.invoice_disputes d join public.organizations o on o.id = d.org_id where d.resolved_at is null
    union all
    select 1, 'document_missing', o.name, i.store_org_id, i.id::text, '#' || i.number, i.paid_at, 'document'
      from public.invoices i join public.organizations o on o.id = i.store_org_id
     where i.status = 'paid' and not exists (select 1 from public.accounting_documents a where a.invoice_id = i.id and a.issuer = 'linkup')
    union all
    select 1, 'refund_failed', o.name, c.store_org_id, r.id::text, r.failure_message, r.completed_at, 'refund'
      from public.billing_refunds r join public.billing_charges c on c.id = r.charge_id join public.organizations o on o.id = c.store_org_id
     where r.status = 'failed'
    union all
    select 1, 'tax_profile_unverified', o.name, t.org_id, t.org_id::text, t.classification, t.updated_at, 'verify'
      from public.tax_profiles t join public.organizations o on o.id = t.org_id where t.verified_at is null
    union all
    select 1, 'payout_disputed', o.name, p.store_org_id, p.id::text, p.dispute_reason, p.creator_responded_at, 'follow_up'
      from public.creator_payouts p join public.organizations o on o.id = p.creator_org_id
     where p.creator_status = 'disputed' and p.withdrawn_at is null
  ) x), '[]');
end $$;

revoke execute on function public.billing_after_failure(uuid), public.billing_after_success(uuid, text), public.billing_mark_unknown(uuid, text),
  public.billing_sweep_stale(int), public.billing_unknown_open(), public.billing_resolve_unknown(uuid, text, text, text, text),
  public.billing_apply_provider_event(text, text, uuid, text, text), public.handle_billing_alert(uuid, text),
  public.admin_resolve_charge(uuid, text, text, text), public.billing_alerts_guard() from public, anon, authenticated;
grant execute on function public.billing_mark_unknown(uuid, text), public.billing_sweep_stale(int), public.billing_unknown_open(),
  public.billing_resolve_unknown(uuid, text, text, text, text), public.billing_apply_provider_event(text, text, uuid, text, text) to service_role;
grant execute on function public.admin_resolve_charge(uuid, text, text, text), public.handle_billing_alert(uuid, text) to authenticated;

-- LINKUP — legal package v1.0 integration (Appendix A of LINKUP_legal_package_2026-11-10.md).
-- Uses the existing legal_documents / legal_acceptances / fee_terms tables. Documents are loaded separately as
-- DRAFTS (supabase/seed/legal_documents_v1_draft.sql) and published only after counsel/CPA approval.
--  * Acceptance records: + role, locale, action (accept / acknowledge), audit reference.
--  * Privacy notice is acknowledged, not "consented" (audience 'notice').
--  * Creator terms required when a creator activity is created.
--  * Rate increase not accepted by its effective date → new activity with that store stops (wind-down);
--    nothing existing is deleted or switched off, and existing deals keep the old rate.
--  * Payment-request disputes (undisputed amount stays due); fee base itemised per rate.
--  * Manual withholding tax on reward transfers (no rate is ever assumed).

/* ================= 1. Acceptance records ================= */
alter table public.legal_documents drop constraint legal_documents_audience_check;
alter table public.legal_documents add constraint legal_documents_audience_check
  check (audience in ('all', 'store', 'creator', 'notice', 'none'));

alter table public.legal_acceptances add column role text;              -- e.g. creator:owner / store:admin / user
alter table public.legal_acceptances add column locale text check (locale in ('he', 'en'));
alter table public.legal_acceptances add column action text not null default 'accept' check (action in ('accept', 'acknowledge'));
alter table public.legal_acceptances add column audit_event_id uuid references public.audit_events(id);

-- Pending documents for a context. 'signup' = general terms (all) + privacy notice (notice).
create or replace function public.legal_pending(p_context text) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'; end if;
  return coalesce((select json_agg(json_build_object('doc_key', c.doc_key, 'version', c.version, 'audience', c.audience,
           'title_he', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'he'),
           'title_en', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'en'),
           'reacceptance', exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.doc_key = c.doc_key))
           order by (select min(sort_order) from public.legal_documents where doc_key = c.doc_key))
      from public.legal_current() c
     where ((c.audience in ('all', 'notice') and p_context in ('signup', 'any'))
        or (c.audience = 'store' and p_context in ('store', 'any')
            and (p_context = 'store' or exists (select 1 from public.memberships m join public.organizations o on o.id = m.org_id
                                                 where m.user_id = v_uid and o.type = 'store' and m.role in ('owner', 'admin'))))
        or (c.audience = 'creator' and p_context in ('creator', 'any')
            and (p_context = 'creator' or exists (select 1 from public.memberships m join public.organizations o on o.id = m.org_id
                                                   where m.user_id = v_uid and o.type = 'creator' and m.role in ('owner', 'admin')))))
       and not exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.doc_key = c.doc_key and a.version >= c.requires_from)), '[]');
end $$;

drop function public.accept_legal(text[], text, uuid);
create function public.accept_legal(p_doc_keys text[], p_type text, p_org uuid default null, p_locale text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); k text; d public.legal_documents; n int := 0; v_role text; v_audit uuid; v_loc text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_type not in ('signup', 'store_connection', 'reacceptance', 'existing_user') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if p_org is not null and not public.is_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_loc := case when p_locale in ('he', 'en') then p_locale else 'he' end;
  v_role := coalesce((select o.type || ':' || m.role from public.memberships m join public.organizations o on o.id = m.org_id
                       where m.org_id = p_org and m.user_id = v_uid), 'user');
  foreach k in array coalesce(p_doc_keys, '{}') loop
    -- The exact text shown: the viewer's language version of the current version (fallback: the other language).
    select ld.* into d from public.legal_documents ld join public.legal_current() c on c.doc_key = ld.doc_key and c.version = ld.version
     where ld.doc_key = k order by (ld.locale = v_loc) desc limit 1;
    continue when not found;
    continue when exists (select 1 from public.legal_acceptances a where a.user_id = v_uid and a.document_id = d.id
                                                                    and a.org_id is not distinct from p_org);
    insert into public.audit_events(actor_user_id, org_id, action, target, details)
    values (v_uid, p_org, case when d.audience = 'notice' then 'legal.acknowledged' else 'legal.accepted' end, d.doc_key,
            jsonb_build_object('version', d.version, 'locale', d.locale, 'type', p_type, 'role', v_role, 'document_id', d.id))
    returning id into v_audit;
    insert into public.legal_acceptances(user_id, org_id, document_id, doc_key, version, acceptance_type, role, locale, action, audit_event_id)
    values (v_uid, p_org, d.id, d.doc_key, d.version, p_type, v_role, d.locale,
            case when d.audience = 'notice' then 'acknowledge' else 'accept' end, v_audit);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Creating a creator activity also requires the creator terms.
create or replace function public.create_organization(p_type text, p_name text, p_website_url text default null,
                                                      p_ref_code text default null, p_locale text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_legal('signup');
  if p_type = 'creator' then perform public.require_legal('creator'); end if;
  return public.create_organization_core(p_type, p_name, p_website_url, p_ref_code, p_locale);
end $$;

create or replace function public.my_legal_acceptances() returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('doc_key', doc_key, 'version', version, 'type', acceptance_type, 'action', action,
                  'locale', locale, 'role', role, 'accepted_at', accepted_at) order by accepted_at desc), '[]')
    from public.legal_acceptances where user_id = auth.uid();
$$;

-- Drafts are visible to platform admins only (review before approval).
create function public.legal_admin_documents() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', id, 'doc_key', doc_key, 'locale', locale, 'version', version, 'title', title,
           'audience', audience, 'status', status, 'effective_from', effective_from, 'published_at', published_at, 'chars', char_length(body))
           order by sort_order, doc_key, locale, version) from public.legal_documents), '[]');
end $$;

create function public.legal_admin_document(p_key text, p_locale text, p_version int) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select row_to_json(d) from (select doc_key, locale, version, title, body, status, effective_from, published_at
                                        from public.legal_documents where doc_key = p_key and locale = p_locale and version = p_version) d);
end $$;

-- Publish an already-saved version (both locales) exactly as stored — no text is changed on publication.
create function public.publish_legal_version(p_key text, p_version int, p_effective_from timestamptz default null) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.legal_documents set status = 'published', published_at = now(), effective_from = coalesce(p_effective_from, now())
   where doc_key = p_key and version = p_version and status = 'draft';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found' using errcode = '22023'; end if;
  insert into public.audit_events(actor_user_id, action, target, details)
  values (auth.uid(), 'legal.published', p_key, jsonb_build_object('version', p_version, 'effective_from', coalesce(p_effective_from, now())));
  return n;
end $$;

/* ================= 2. Rate increase not accepted → orderly wind-down ================= */
-- True from the effective date of an increase the store has not accepted (declined or never answered).
create function public.store_new_activity_blocked(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fee_terms f
                  where f.store_org_id = p_store and f.source = 'rate_change' and f.status in ('proposed', 'declined')
                    and f.effective_from <= now());
$$;

create function public.wind_down_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if tg_table_name = 'proposals' then
    v_store := (select id from public.organizations where id = (to_jsonb(new) ->> 'from_org_id')::uuid and type = 'store');
  else
    v_store := (to_jsonb(new) ->> 'store_org_id')::uuid;
  end if;
  if v_store is not null and public.store_new_activity_blocked(v_store) then
    raise exception 'store_rate_not_accepted' using errcode = '42501';
  end if;
  return new;
end $$;
-- New collaborations, offers/campaigns and store invitations only. Existing ones keep running at the old rate.
create trigger agreements_wind_down before insert on public.agreements for each row execute function public.wind_down_guard();
create trigger opportunities_wind_down before insert on public.opportunities for each row execute function public.wind_down_guard();
create trigger proposals_wind_down before insert on public.proposals for each row execute function public.wind_down_guard();

-- Accepting an increase after its effective date never charges the new rate retroactively: the proposal is
-- superseded (status 'withdrawn', kept as history) and the accepted rate starts at the moment of acceptance.
create or replace function public.respond_fee_change(p_term uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.fee_terms;
begin
  select * into t from public.fee_terms where id = p_term for update;
  if not found or not public.is_admin(t.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if t.status <> 'proposed' then raise exception 'already_decided' using errcode = '22023'; end if;
  if p_accept and t.effective_from < now() then
    update public.fee_terms set status = 'withdrawn', responded_at = now(), responded_by = auth.uid() where id = p_term;
    insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, status, source, note, notice_sent_at, responded_at, responded_by, created_by)
    values (t.store_org_id, t.kind, t.fee_bps, now(), 'active', 'rate_change',
            left(coalesce(t.note, '') || ' [accepted after the proposed date; applies from acceptance]', 500), t.notice_sent_at, now(), auth.uid(), auth.uid());
  else
    update public.fee_terms set status = case when p_accept then 'active' else 'declined' end,
           responded_at = now(), responded_by = auth.uid() where id = p_term;
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), t.store_org_id, case when p_accept then 'pricing.change_accepted' else 'pricing.change_declined' end,
          p_term::text, jsonb_build_object('fee_bps', t.fee_bps, 'effective_from', greatest(t.effective_from, now())));
end $$;

/* ================= 3. Payment requests: disputes and itemised base ================= */
create table public.invoice_disputes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  org_id uuid not null references public.organizations(id),
  opened_by uuid not null,
  disputed_minor bigint not null check (disputed_minor > 0),
  reason text not null check (char_length(reason) between 3 and 1000),
  evidence text check (char_length(evidence) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text check (char_length(resolution) <= 1000)
);
create index invoice_disputes_invoice_idx on public.invoice_disputes(invoice_id);
create function public.invoice_disputes_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only' using errcode = '42501'; end if;
  if old.resolved_at is not null or (new.invoice_id, new.org_id, new.opened_by, new.disputed_minor, new.reason, new.evidence, new.created_at)
       is distinct from (old.invoice_id, old.org_id, old.opened_by, old.disputed_minor, old.reason, old.evidence, old.created_at) then
    raise exception 'append_only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger invoice_disputes_guard before update or delete on public.invoice_disputes for each row execute function public.invoice_disputes_guard();

create function public.open_invoice_dispute(p_invoice uuid, p_disputed_minor bigint, p_reason text, p_evidence text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.invoices; v_id uuid;
begin
  select * into i from public.invoices where id = p_invoice;
  if not found or not public.is_admin(i.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if i.status <> 'issued' then raise exception 'invoice_not_disputable' using errcode = '22023'; end if;
  if p_disputed_minor is null or p_disputed_minor <= 0 or p_disputed_minor > i.total_minor then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if exists (select 1 from public.invoice_disputes where invoice_id = p_invoice and resolved_at is null) then
    raise exception 'dispute_open' using errcode = '22023';
  end if;
  insert into public.invoice_disputes(invoice_id, org_id, opened_by, disputed_minor, reason, evidence)
  values (p_invoice, i.store_org_id, auth.uid(), p_disputed_minor, btrim(p_reason), nullif(btrim(coalesce(p_evidence, '')), ''))
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), i.store_org_id, 'invoice.disputed', p_invoice::text, jsonb_build_object('disputed_minor', p_disputed_minor));
  return v_id;
end $$;

-- Resolution is a recorded note; any money correction flows into the next period as an adjustment.
create function public.resolve_invoice_dispute(p_dispute uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(btrim(p_resolution), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  update public.invoice_disputes set resolved_at = now(), resolved_by = auth.uid(), resolution = btrim(p_resolution)
   where id = p_dispute and resolved_at is null returning org_id into v_org;
  if v_org is null then raise exception 'not_found' using errcode = '22023'; end if;
  insert into public.notifications(org_id, kind, payload) values (v_org, 'dispute_resolved', jsonb_build_object('dispute_id', p_dispute));
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), v_org, 'invoice.dispute_resolved', p_dispute::text);
end $$;

-- Itemised fee base per rate (base = fee ÷ rate per line; reversals carry a negative base).
create function public.invoice_lines(p_invoice uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_org_id into v_store from public.invoices where id = p_invoice;
  if v_store is null or not (public.is_admin(v_store) or public.is_platform_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.rate_bps) from (
    select a.platform_fee_bps as rate_bps, count(*) as lines,
           sum(round(ii.amount_minor::numeric * 10000 / nullif(a.platform_fee_bps, 0)))::bigint as base_minor,
           sum(ii.amount_minor) as fee_minor
      from public.invoice_items ii join public.commission_ledger l on l.id = ii.ledger_id
      join public.attributions a on a.id = l.attribution_id
     where ii.invoice_id = p_invoice group by a.platform_fee_bps) x), '[]');
end $$;

/* ================= 4. Manual withholding on reward transfers ================= */
alter table public.reward_payouts add column withholding_minor bigint not null default 0 check (withholding_minor >= 0);
alter table public.accounting_documents add column withholding_minor bigint not null default 0 check (withholding_minor >= 0);

drop function public.record_reward_transfer(uuid, text, text, text, text, date);
create function public.record_reward_transfer(p_org uuid, p_currency text, p_reference text,
                                              p_doc_type text, p_doc_number text, p_doc_date date,
                                              p_withholding_minor bigint default 0) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_bal bigint; v_rate int; v_vat bigint; v_pid uuid; v_class text; v_wh bigint := coalesce(p_withholding_minor, 0);
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = p_org for update;
  v_bal := public.wallet_balance_minor(p_org, p_currency);
  if v_bal < public.setting_int('reward_transfer_min_minor') then raise exception 'below_minimum' using errcode = '22023'; end if;
  v_rate := public.reward_vat_bps(p_org);
  if v_rate is null then raise exception 'tax_profile_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_doc_number), '') = '' then raise exception 'document_required' using errcode = '22023'; end if;
  v_vat := round(v_bal::numeric * v_rate / 10000)::bigint;
  -- Withholding is entered by the operator from the referrer's valid certificate; never computed from an assumed rate.
  if v_wh < 0 or v_wh > v_bal then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select classification into v_class from public.tax_profiles where org_id = p_org;
  insert into public.reward_payouts(org_id, currency, amount_minor, method, reference, created_by, vat_bps, vat_minor, recipient_classification, withholding_minor)
  values (p_org, p_currency, v_bal, 'transfer', nullif(btrim(coalesce(p_reference, '')), ''), auth.uid(), v_rate, v_vat, v_class, v_wh)
  returning id into v_pid;
  insert into public.accounting_documents(issuer, doc_type, doc_number, issued_on, org_id, reward_payout_id, currency, amount_minor, vat_minor, withholding_minor, created_by)
  values ('counterparty', p_doc_type, btrim(p_doc_number), coalesce(p_doc_date, current_date), p_org, v_pid, p_currency, v_bal, v_vat, v_wh, auth.uid());
  insert into public.notifications(org_id, kind, payload) values (p_org, 'reward_paid', '{}');
  insert into public.audit_events(actor_user_id, org_id, action, details)
  values (auth.uid(), p_org, 'reward.transferred', jsonb_build_object('amount_minor', v_bal, 'vat_minor', v_vat, 'withholding_minor', v_wh, 'currency', p_currency));
  return v_bal + v_vat - v_wh;   -- net actually transferred
end $$;

/* ================= 5. Admin list: disputes and per-rate base ================= */
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

/* ================= 6. Website contact form (the documents' preferred channel) ================= */
create table public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  name text not null check (char_length(name) between 2 and 120),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 200),
  topic text not null check (topic in ('general', 'billing', 'dispute', 'privacy', 'legal')),
  message text not null check (char_length(message) between 5 and 4000),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid
);
create index contact_messages_created_idx on public.contact_messages(created_at);

create function public.submit_contact_message(p_name text, p_email text, p_topic text, p_message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select count(*) from public.contact_messages where lower(email) = lower(btrim(p_email)) and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.contact_messages where created_at > now() - interval '1 hour') >= 200 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  insert into public.contact_messages(user_id, name, email, topic, message)
  values (auth.uid(), btrim(p_name), btrim(p_email), p_topic, btrim(p_message)) returning id into v_id;
  return v_id;
exception when check_violation then
  raise exception 'invalid_input' using errcode = '22023';
end $$;

create function public.admin_contact_messages() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(row_to_json(m) order by m.created_at desc) from
    (select id, name, email, topic, message, created_at, handled_at from public.contact_messages order by created_at desc limit 100) m), '[]');
end $$;

create function public.mark_contact_handled(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.contact_messages set handled_at = now(), handled_by = auth.uid() where id = p_id and handled_at is null;
end $$;

alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
revoke execute on function public.submit_contact_message(text, text, text, text), public.admin_contact_messages(),
  public.mark_contact_handled(uuid) from public;
grant execute on function public.submit_contact_message(text, text, text, text) to anon, authenticated;
grant execute on function public.admin_contact_messages(), public.mark_contact_handled(uuid) to authenticated;

/* ================= Security ================= */
alter table public.invoice_disputes enable row level security;
create policy invoice_disputes_read on public.invoice_disputes for select to authenticated using (public.is_admin(org_id) or public.is_platform_admin());
revoke all on public.invoice_disputes from anon, authenticated;
grant select on public.invoice_disputes to authenticated;

revoke execute on function public.accept_legal(text[], text, uuid, text), public.legal_admin_documents(),
  public.legal_admin_document(text, text, int), public.publish_legal_version(text, int, timestamptz),
  public.store_new_activity_blocked(uuid), public.wind_down_guard(), public.invoice_disputes_guard(),
  public.open_invoice_dispute(uuid, bigint, text, text), public.resolve_invoice_dispute(uuid, text), public.invoice_lines(uuid),
  public.record_reward_transfer(uuid, text, text, text, text, date, bigint)
  from public, anon, authenticated;
grant execute on function public.accept_legal(text[], text, uuid, text), public.legal_admin_documents(),
  public.legal_admin_document(text, text, int), public.publish_legal_version(text, int, timestamptz),
  public.store_new_activity_blocked(uuid), public.open_invoice_dispute(uuid, bigint, text, text),
  public.resolve_invoice_dispute(uuid, text), public.invoice_lines(uuid),
  public.record_reward_transfer(uuid, text, text, text, text, date, bigint)
  to authenticated;

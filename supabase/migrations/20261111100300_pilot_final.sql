-- LINKUP — final pilot-prep items.
--  1. Rate-increase notices: creation, sending, channel and recipient, delivery status and reference.
--     The 30 days run from a delivery LINKUP can reasonably prove; an increase never applies without the
--     store's explicit, recorded acceptance.
--  2. Orderly future wind-down of existing collaborations after a refusal: planned by an admin, never automatic.
--     The notice period is a legal decision not yet made; until it is set, planning is refused.
--  3. Reward offsets and cash reward transfers stay blocked until the pending accounting decisions
--     (withholding on offsets, etc.) are made: reward_settlement_approved = false.

insert into public.app_settings(key, value) values ('reward_settlement_approved', 'false') on conflict (key) do nothing;
-- 'wind_down_notice_days' is intentionally NOT created: it must be decided by counsel first.

/* ================= 1. Notice delivery for rate increases ================= */
create table public.fee_change_notices (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null references public.fee_terms(id),
  store_org_id uuid not null references public.organizations(id),
  event text not null check (event in ('created', 'sent', 'delivered', 'failed')),
  channel text check (channel in ('email', 'whatsapp', 'in_app', 'registered_mail', 'other')),
  recipient text check (char_length(recipient) <= 200),
  reference text check (char_length(reference) <= 300),
  occurred_at timestamptz not null default now(),
  recorded_by uuid,
  created_at timestamptz not null default now()
);
create index fee_change_notices_term_idx on public.fee_change_notices(term_id, event);
create trigger fee_change_notices_append_only before update or delete on public.fee_change_notices
  for each row execute function public.forbid_change();

-- Every increase proposal gets a 'created' record (an in-app notification alone is not proof of delivery).
create function public.fee_notice_on_proposal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'rate_change' and new.status = 'proposed' then
    insert into public.fee_change_notices(term_id, store_org_id, event, channel, recorded_by)
    values (new.id, new.store_org_id, 'created', 'in_app', auth.uid());
  end if;
  return new;
end $$;
create trigger fee_terms_notice after insert on public.fee_terms for each row execute function public.fee_notice_on_proposal();

-- Earliest documented delivery of the notice for a proposal (NULL = not proven).
create function public.fee_notice_delivered_at(p_term uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select min(occurred_at) from public.fee_change_notices where term_id = p_term and event = 'delivered';
$$;

-- The date an increase could start: never before its stated date, and never earlier than the notice period after
-- proven delivery. NULL while delivery is not proven.
create function public.fee_term_start(p_term uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(t.effective_from, public.fee_notice_delivered_at(t.id) + make_interval(days => public.setting_int('rate_change_notice_days')))
    from public.fee_terms t where t.id = p_term and public.fee_notice_delivered_at(t.id) is not null;
$$;

create function public.record_fee_notice(p_term uuid, p_event text, p_channel text, p_recipient text, p_reference text,
                                         p_occurred_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.fee_terms; v_id uuid; v_at timestamptz := coalesce(p_occurred_at, now());
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from public.fee_terms where id = p_term;
  if not found or t.source <> 'rate_change' then raise exception 'not_found' using errcode = '22023'; end if;
  if p_event not in ('sent', 'delivered', 'failed') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if p_channel not in ('email', 'whatsapp', 'in_app', 'registered_mail', 'other') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if v_at > now() + interval '5 minutes' or v_at < t.created_at - interval '5 minutes' then raise exception 'invalid_dates' using errcode = '22023'; end if;
  if p_event = 'delivered' and coalesce(btrim(p_reference), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  insert into public.fee_change_notices(term_id, store_org_id, event, channel, recipient, reference, occurred_at, recorded_by)
  values (p_term, t.store_org_id, p_event, p_channel, nullif(btrim(coalesce(p_recipient, '')), ''), nullif(btrim(coalesce(p_reference, '')), ''), v_at, auth.uid())
  returning id into v_id;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), t.store_org_id, 'pricing.notice_' || p_event, p_term::text, jsonb_build_object('channel', p_channel, 'at', v_at));
  return v_id;
end $$;

-- Acceptance: explicit, by a store admin, only after proven delivery. The accepted rate starts at
-- greatest(stated date, delivery + notice period, moment of acceptance) — never retroactively.
create or replace function public.respond_fee_change(p_term uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.fee_terms; v_start timestamptz;
begin
  select * into t from public.fee_terms where id = p_term for update;
  if not found or not public.is_admin(t.store_org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if t.status <> 'proposed' then raise exception 'already_decided' using errcode = '22023'; end if;
  if p_accept then
    v_start := public.fee_term_start(p_term);
    if v_start is null then raise exception 'notice_not_delivered' using errcode = '22023'; end if;
    v_start := greatest(v_start, now());
    if v_start = t.effective_from then
      update public.fee_terms set status = 'active', responded_at = now(), responded_by = auth.uid() where id = p_term;
    else
      update public.fee_terms set status = 'withdrawn', responded_at = now(), responded_by = auth.uid() where id = p_term;
      insert into public.fee_terms(store_org_id, kind, fee_bps, effective_from, status, source, note, notice_sent_at, responded_at, responded_by, created_by)
      values (t.store_org_id, t.kind, t.fee_bps, v_start, 'active', 'rate_change',
              left(coalesce(t.note, '') || ' [accepted; starts after the documented notice period]', 500), t.notice_sent_at, now(), auth.uid(), auth.uid());
    end if;
  else
    update public.fee_terms set status = 'declined', responded_at = now(), responded_by = auth.uid() where id = p_term;
  end if;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), t.store_org_id, case when p_accept then 'pricing.change_accepted' else 'pricing.change_declined' end,
          p_term::text, jsonb_build_object('fee_bps', t.fee_bps, 'starts', v_start));
end $$;

-- New activity pauses only once a properly delivered increase reached its start date without acceptance.
create or replace function public.store_new_activity_blocked(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fee_terms f
                  where f.store_org_id = p_store and f.source = 'rate_change' and f.status in ('proposed', 'declined')
                    and coalesce(public.fee_term_start(f.id) <= now(), false));
$$;

create or replace function public.store_fee_terms(p_store uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'current_bps', public.fee_bps_at(p_store, now()),
    'vat_bps', public.setting_int('vat_bps'),
    'blocked', public.store_new_activity_blocked(p_store),
    'terms', coalesce((select json_agg(json_build_object('id', id, 'kind', kind, 'fee_bps', fee_bps,
                 'effective_from', case when effective_from = '-infinity' then null else effective_from end,
                 'effective_until', effective_until, 'status', status, 'source', source, 'notice_sent_at', notice_sent_at,
                 'delivered_at', public.fee_notice_delivered_at(id), 'starts_at', public.fee_term_start(id))
                 order by effective_from)
               from public.fee_terms where store_org_id = p_store and status in ('active', 'proposed')
                and (effective_until is null or effective_until > now())), '[]'));
end $$;

create function public.admin_fee_notices() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('term_id', t.id, 'store', o.name, 'store_org_id', t.store_org_id, 'fee_bps', t.fee_bps,
           'effective_from', t.effective_from, 'status', t.status, 'delivered_at', public.fee_notice_delivered_at(t.id),
           'starts_at', public.fee_term_start(t.id),
           'events', (select json_agg(json_build_object('event', n.event, 'channel', n.channel, 'recipient', n.recipient,
                        'reference', n.reference, 'at', n.occurred_at) order by n.occurred_at) from public.fee_change_notices n where n.term_id = t.id),
           'wind_down', (select json_build_object('id', w.id, 'end_at', w.end_at, 'status', w.status) from public.collaboration_wind_downs w
                          where w.term_id = t.id and w.status <> 'cancelled' order by w.created_at desc limit 1))
           order by t.created_at desc)
      from public.fee_terms t join public.organizations o on o.id = t.store_org_id
     where t.source = 'rate_change' and t.status in ('proposed', 'declined')), '[]');
end $$;

/* ================= 2. Orderly future wind-down of existing collaborations ================= */
create table public.collaboration_wind_downs (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  term_id uuid not null references public.fee_terms(id),
  announced_at timestamptz not null default now(),
  end_at timestamptz not null,
  note text not null check (char_length(note) between 3 and 500),
  status text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  agreements_ended int,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid
);
create trigger collaboration_wind_downs_no_delete before delete on public.collaboration_wind_downs for each row execute function public.forbid_change();

create function public.plan_collaboration_wind_down(p_term uuid, p_end_at timestamptz, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.fee_terms; v_days int; v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from public.fee_terms where id = p_term;
  -- Only after a refusal (declined, or the start date passed without acceptance following proven delivery).
  if not found or t.source <> 'rate_change'
     or not (t.status = 'declined' or (t.status = 'proposed' and coalesce(public.fee_term_start(t.id) <= now(), false))) then
    raise exception 'wind_down_not_allowed' using errcode = '22023';
  end if;
  -- The advance-notice period is a legal decision. Until it is made, nothing can be planned.
  select (value #>> '{}')::int into v_days from public.app_settings where key = 'wind_down_notice_days';
  if v_days is null then raise exception 'wind_down_rule_undecided' using errcode = '22023'; end if;
  if p_end_at < now() + make_interval(days => v_days) then raise exception 'notice_too_short' using errcode = '22023'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  if exists (select 1 from public.collaboration_wind_downs where term_id = p_term and status = 'planned') then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  insert into public.collaboration_wind_downs(store_org_id, term_id, end_at, note, created_by)
  values (t.store_org_id, p_term, p_end_at, btrim(p_note), auth.uid()) returning id into v_id;
  -- Advance notice to the store and to every creator in an active collaboration with it.
  insert into public.notifications(org_id, kind, payload) values (t.store_org_id, 'wind_down_planned', jsonb_build_object('end_at', p_end_at));
  insert into public.notifications(org_id, kind, payload)
  select distinct a.creator_org_id, 'wind_down_planned', jsonb_build_object('end_at', p_end_at, 'store_org_id', t.store_org_id)
    from public.agreements a where a.store_org_id = t.store_org_id and a.status = 'active';
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), t.store_org_id, 'collaboration.wind_down_planned', v_id::text, jsonb_build_object('end_at', p_end_at));
  return v_id;
end $$;

create function public.cancel_collaboration_wind_down(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.collaboration_wind_downs set status = 'cancelled' where id = p_plan and status = 'planned' returning store_org_id into v_store;
  if v_store is null then raise exception 'not_found' using errcode = '22023'; end if;
  insert into public.audit_events(actor_user_id, org_id, action, target) values (auth.uid(), v_store, 'collaboration.wind_down_cancelled', p_plan::text);
end $$;

-- Explicit admin action after the announced date: existing collaborations end for FUTURE attribution only.
-- Orders, attributions, commissions, rewards and payouts already recorded stay exactly as they are; nothing is
-- deleted, no coupon is touched in the store. Still blocked if the store has accepted in the meantime.
create function public.complete_collaboration_wind_down(p_plan uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare w public.collaboration_wind_downs; n int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into w from public.collaboration_wind_downs where id = p_plan for update;
  if not found or w.status <> 'planned' then raise exception 'not_found' using errcode = '22023'; end if;
  if w.end_at > now() then raise exception 'wind_down_not_due' using errcode = '22023'; end if;
  if not exists (select 1 from public.fee_terms where id = w.term_id and status in ('declined', 'proposed')) then
    raise exception 'wind_down_not_allowed' using errcode = '22023';
  end if;
  update public.agreements set status = 'ended' where store_org_id = w.store_org_id and status = 'active';
  get diagnostics n = row_count;
  update public.collaboration_wind_downs set status = 'completed', completed_at = now(), completed_by = auth.uid(), agreements_ended = n where id = p_plan;
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), w.store_org_id, 'collaboration.wind_down_completed', p_plan::text, jsonb_build_object('agreements_ended', n));
  return n;
end $$;

/* ================= 3. Settlements that await accounting decisions stay blocked ================= */
-- Offsets (run_invoice_generation / preview) and cash transfers both depend on reward_vat_bps: returning NULL
-- leaves every reward in the wallet (no right is lost) until reward_settlement_approved is switched on.
create or replace function public.reward_vat_bps(p_org uuid) returns int
language sql stable security definer set search_path = '' as $$
  select case when not public.setting_bool('reward_settlement_approved') then null
              when t.verified_at is null then null
              when t.classification in ('company', 'authorized_dealer') and t.country = 'IL' then public.setting_int('vat_bps')
              when t.classification = 'exempt_dealer' and t.country = 'IL' then 0
              else null end
    from public.tax_profiles t where t.org_id = p_org;
$$;

drop function public.record_reward_transfer(uuid, text, text, text, text, date, bigint);
create function public.record_reward_transfer(p_org uuid, p_currency text, p_reference text,
                                              p_doc_type text, p_doc_number text, p_doc_date date,
                                              p_withholding_minor bigint default 0) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_bal bigint; v_rate int; v_vat bigint; v_pid uuid; v_class text; v_wh bigint := coalesce(p_withholding_minor, 0);
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.setting_bool('reward_settlement_approved') then raise exception 'accounting_decision_pending' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = p_org for update;
  v_bal := public.wallet_balance_minor(p_org, p_currency);
  if v_bal < public.setting_int('reward_transfer_min_minor') then raise exception 'below_minimum' using errcode = '22023'; end if;
  v_rate := public.reward_vat_bps(p_org);
  if v_rate is null then raise exception 'tax_profile_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_doc_number), '') = '' then raise exception 'document_required' using errcode = '22023'; end if;
  v_vat := round(v_bal::numeric * v_rate / 10000)::bigint;
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
  return v_bal + v_vat - v_wh;
end $$;

/* ================= Security ================= */
alter table public.fee_change_notices enable row level security;
alter table public.collaboration_wind_downs enable row level security;
create policy fee_change_notices_read on public.fee_change_notices for select to authenticated using (public.is_admin(store_org_id) or public.is_platform_admin());
create policy collaboration_wind_downs_read on public.collaboration_wind_downs for select to authenticated using (public.is_admin(store_org_id) or public.is_platform_admin());
revoke all on public.fee_change_notices, public.collaboration_wind_downs from anon, authenticated;
grant select on public.fee_change_notices, public.collaboration_wind_downs to authenticated;

revoke execute on function public.fee_notice_on_proposal(), public.fee_notice_delivered_at(uuid), public.fee_term_start(uuid),
  public.record_fee_notice(uuid, text, text, text, text, timestamptz), public.admin_fee_notices(),
  public.plan_collaboration_wind_down(uuid, timestamptz, text), public.cancel_collaboration_wind_down(uuid),
  public.complete_collaboration_wind_down(uuid), public.record_reward_transfer(uuid, text, text, text, text, date, bigint)
  from public, anon, authenticated;
grant execute on function public.record_fee_notice(uuid, text, text, text, text, timestamptz), public.admin_fee_notices(),
  public.plan_collaboration_wind_down(uuid, timestamptz, text), public.cancel_collaboration_wind_down(uuid),
  public.complete_collaboration_wind_down(uuid), public.record_reward_transfer(uuid, text, text, text, text, date, bigint)
  to authenticated;

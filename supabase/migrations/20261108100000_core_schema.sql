-- LINKUP Phase 1 — core schema, append-only guards, RLS.
-- Money: bigint minor units. Rates: basis points (10000 = 100%).
-- All writes go through SECURITY DEFINER functions (next migration). Clients get SELECT via RLS only.

create table public.app_settings (
  key text primary key,
  value jsonb not null
);
insert into public.app_settings(key, value) values
  ('standard_fee_bps', '300'),
  ('founders_fee_bps', '200'),
  ('founders_open', 'true'),
  ('founders_months', '6'),
  ('referral_reward_bps', '1000'),
  ('referral_months', '12'),
  ('refund_hold_days', '14'),
  ('default_attribution_days', '30'),
  ('max_proposals_per_day', '50');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('store', 'creator', 'agency')),
  name text not null check (char_length(name) between 2 and 80),
  slug text not null unique,
  website_url text,
  default_commission_bps int not null default 1000 check (default_commission_bps between 0 and 5000),
  platform_fee_bps int check (platform_fee_bps between 0 and 2000), -- per-store override, null = settings
  founders_until timestamptz,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (user_id, org_id)
);
create index memberships_org_idx on public.memberships(org_id);

create table public.store_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  platform text not null default 'woocommerce' check (platform in ('woocommerce')),
  site_url text not null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'disconnected')),
  plugin_version text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, site_url)
);

-- Secrets live apart; no RLS policy => unreadable by clients. Only definer functions / service role.
create table public.store_connection_secrets (
  connection_id uuid primary key references public.store_connections(id) on delete cascade,
  secret text not null,
  rotated_at timestamptz not null default now()
);

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  from_org_id uuid not null references public.organizations(id),
  direction text not null check (direction in ('store_to_creator', 'creator_to_store')),
  invitee_name text check (char_length(invitee_name) <= 120),
  invitee_contact text check (char_length(invitee_contact) <= 200),
  target_site_url text,
  commission_bps int not null check (commission_bps between 100 and 5000),
  coupon_discount_pct int not null default 10 check (coupon_discount_pct between 0 and 50),
  attribution_days int not null default 30 check (attribution_days between 1 and 90),
  status text not null default 'sent' check (status in ('sent', 'opened', 'accepted', 'rejected', 'withdrawn')),
  source_proposal_id uuid references public.proposals(id),
  accepted_org_id uuid references public.organizations(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days'
);
create index proposals_from_idx on public.proposals(from_org_id, created_at);

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  store_org_id uuid not null references public.organizations(id),
  creator_org_id uuid not null references public.organizations(id),
  proposal_id uuid unique references public.proposals(id),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  created_at timestamptz not null default now(),
  check (store_org_id <> creator_org_id)
);
create unique index agreements_active_pair_uq on public.agreements(store_org_id, creator_org_id) where status = 'active';
create index agreements_creator_idx on public.agreements(creator_org_id);

create table public.agreement_versions (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id),
  version int not null check (version >= 1),
  commission_bps int not null check (commission_bps between 0 and 5000),
  coupon_discount_pct int not null check (coupon_discount_pct between 0 and 50),
  attribution_days int not null check (attribution_days between 1 and 90),
  refund_hold_days int not null check (refund_hold_days between 0 and 120),
  commission_base text not null default 'net_excl_tax_shipping' check (commission_base in ('net_excl_tax_shipping')),
  proposal_id uuid references public.proposals(id),
  effective_from timestamptz not null default now(),
  accepted_by_store_at timestamptz not null,
  accepted_by_creator_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (agreement_id, version)
);

create table public.partner_codes (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id),
  code text not null check (code ~ '^[A-Z0-9]{4,16}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index partner_codes_code_uq on public.partner_codes(lower(code));
create index partner_codes_agreement_idx on public.partner_codes(agreement_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.store_connections(id),
  store_org_id uuid not null references public.organizations(id),
  external_order_id text not null,
  currency char(3) not null,
  status text not null,
  total_minor bigint not null check (total_minor >= 0),
  base_minor bigint not null check (base_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  coupon_codes text[] not null default '{}',
  ref_code text,
  ref_at timestamptz,
  customer_email_hash text,
  order_created_at timestamptz not null,
  completed_at timestamptz,
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (connection_id, external_order_id)
);
create index orders_store_idx on public.orders(store_org_id, order_created_at);

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.store_connections(id),
  event_id text not null,
  external_order_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, event_id)
);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  external_refund_id text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  created_at timestamptz not null default now(),
  unique (order_id, external_refund_id)
);

create table public.attributions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  agreement_version_id uuid not null references public.agreement_versions(id),
  partner_code_id uuid not null references public.partner_codes(id),
  store_org_id uuid not null references public.organizations(id),
  creator_org_id uuid not null references public.organizations(id),
  method text not null check (method in ('coupon', 'link')),
  commission_bps int not null,
  platform_fee_bps int not null,
  self_referral_suspected boolean not null default false,
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index attributions_store_idx on public.attributions(store_org_id, created_at);
create index attributions_creator_idx on public.attributions(creator_org_id, created_at);

create table public.commission_ledger (
  id uuid primary key default gen_random_uuid(),
  attribution_id uuid not null references public.attributions(id),
  store_org_id uuid not null references public.organizations(id),
  party_role text not null check (party_role in ('creator', 'agency', 'platform')),
  party_org_id uuid references public.organizations(id),
  entry_type text not null check (entry_type in ('accrual', 'reversal', 'adjustment')),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null,
  state text not null default 'pending' check (state in ('pending', 'approved')),
  approved_at timestamptz,
  idempotency_key text not null unique,
  source_event_id uuid references public.order_events(id),
  created_at timestamptz not null default now(),
  check ((party_role = 'platform') = (party_org_id is null))
);
create index ledger_attr_idx on public.commission_ledger(attribution_id, party_role);
create index ledger_party_idx on public.commission_ledger(party_org_id, created_at);
create index ledger_store_idx on public.commission_ledger(store_org_id, created_at);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_org_id uuid not null references public.organizations(id),
  referred_org_id uuid not null unique references public.organizations(id),
  source text not null check (source in ('proposal', 'partner_page', 'import')),
  proposal_id uuid references public.proposals(id),
  reward_bps int not null check (reward_bps between 0 and 5000),
  reward_until timestamptz,
  created_at timestamptz not null default now(),
  check (referrer_org_id <> referred_org_id)
);

create table public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('invite_sent', 'invite_opened', 'proposal_accepted', 'proposal_rejected', 'store_connected', 'first_attributed_sale')),
  proposal_id uuid references public.proposals(id),
  org_id uuid references public.organizations(id),
  occurred_at timestamptz not null default now()
);
create index funnel_org_idx on public.funnel_events(org_id, occurred_at);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  org_id uuid references public.organizations(id),
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);

/* ---------------- Append-only guards ---------------- */
create function public.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';
end $$;

create trigger agreement_versions_append_only before update or delete on public.agreement_versions
  for each row execute function public.forbid_change();
create trigger refunds_append_only before update or delete on public.refunds
  for each row execute function public.forbid_change();
create trigger audit_append_only before update or delete on public.audit_events
  for each row execute function public.forbid_change();
create trigger referrals_append_only before delete on public.referrals
  for each row execute function public.forbid_change();

create function public.guard_order_events() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'append_only: delete on order_events' using errcode = '42501';
  end if;
  if new.connection_id <> old.connection_id or new.event_id <> old.event_id
     or new.payload is distinct from old.payload or new.occurred_at <> old.occurred_at
     or new.event_type <> old.event_type or new.external_order_id <> old.external_order_id then
    raise exception 'append_only: order_events payload is immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger order_events_guard before update or delete on public.order_events
  for each row execute function public.guard_order_events();

create function public.guard_ledger() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'append_only: delete on commission_ledger' using errcode = '42501';
  end if;
  -- Only allowed transition: pending -> approved, nothing else changes.
  if not (old.state = 'pending' and new.state = 'approved' and new.approved_at is not null
          and new.amount_minor = old.amount_minor and new.attribution_id = old.attribution_id
          and new.party_role = old.party_role and new.party_org_id is not distinct from old.party_org_id
          and new.entry_type = old.entry_type and new.currency = old.currency
          and new.store_org_id = old.store_org_id and new.idempotency_key = old.idempotency_key) then
    raise exception 'append_only: commission_ledger rows are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ledger_guard before update or delete on public.commission_ledger
  for each row execute function public.guard_ledger();

/* ---------------- Access helpers ---------------- */
create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create function public.is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'admin'));
$$;

/* ---------------- RLS (read-only for clients) ---------------- */
alter table public.app_settings enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.store_connections enable row level security;
alter table public.store_connection_secrets enable row level security;
alter table public.proposals enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_versions enable row level security;
alter table public.partner_codes enable row level security;
alter table public.orders enable row level security;
alter table public.order_events enable row level security;
alter table public.refunds enable row level security;
alter table public.attributions enable row level security;
alter table public.commission_ledger enable row level security;
alter table public.referrals enable row level security;
alter table public.funnel_events enable row level security;
alter table public.audit_events enable row level security;

create policy org_read on public.organizations for select to authenticated using (
  public.is_member(id)
  or exists (select 1 from public.agreements a
             where (a.store_org_id = organizations.id and public.is_member(a.creator_org_id))
                or (a.creator_org_id = organizations.id and public.is_member(a.store_org_id)))
);
create policy membership_read on public.memberships for select to authenticated using (user_id = auth.uid());
create policy connection_read on public.store_connections for select to authenticated using (public.is_member(org_id));
create policy proposal_read on public.proposals for select to authenticated using (
  public.is_member(from_org_id) or (accepted_org_id is not null and public.is_member(accepted_org_id))
);
create policy agreement_read on public.agreements for select to authenticated using (
  public.is_member(store_org_id) or public.is_member(creator_org_id)
);
create policy agreement_version_read on public.agreement_versions for select to authenticated using (
  exists (select 1 from public.agreements a where a.id = agreement_id
          and (public.is_member(a.store_org_id) or public.is_member(a.creator_org_id)))
);
create policy partner_code_read on public.partner_codes for select to authenticated using (
  exists (select 1 from public.agreements a where a.id = agreement_id
          and (public.is_member(a.store_org_id) or public.is_member(a.creator_org_id)))
);
create policy order_read on public.orders for select to authenticated using (public.is_member(store_org_id));
create policy order_event_read on public.order_events for select to authenticated using (
  exists (select 1 from public.store_connections c where c.id = connection_id and public.is_member(c.org_id))
);
create policy refund_read on public.refunds for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and public.is_member(o.store_org_id))
);
create policy attribution_read on public.attributions for select to authenticated using (
  public.is_member(store_org_id) or public.is_member(creator_org_id)
);
create policy ledger_read on public.commission_ledger for select to authenticated using (
  public.is_member(store_org_id) or (party_org_id is not null and public.is_member(party_org_id))
);
create policy referral_read on public.referrals for select to authenticated using (
  public.is_member(referrer_org_id) or public.is_member(referred_org_id)
);
create policy funnel_read on public.funnel_events for select to authenticated using (
  org_id is not null and public.is_member(org_id)
);
create policy audit_read on public.audit_events for select to authenticated using (
  org_id is not null and public.is_admin(org_id)
);

-- Explicit grants: clients can only SELECT (filtered by RLS). No direct writes.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.organizations, public.memberships, public.store_connections, public.proposals,
  public.agreements, public.agreement_versions, public.partner_codes, public.orders, public.order_events,
  public.refunds, public.attributions, public.commission_ledger, public.referrals, public.funnel_events,
  public.audit_events
  to authenticated;

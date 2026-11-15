-- Attribution follows the collaboration's status AT THE TIME OF THE ORDER, not at the time LINKUP receives it.
--
-- Before: an order placed while a collaboration was active, but received after it ended (late sync, plugin retry),
-- lost its creator attribution. Merchant Terms §6 promise late orders are handled by the sale date.
-- Now:
-- * Every status change of an agreement is recorded (append-only), with the time it happened.
-- * agreement_active_at(agreement, t) = was the agreement active at time t. With no recorded change after t
--   the current status applies — so agreements ended before this migration behave exactly as before.
-- * ingest_order_event uses it for both coupon and link lookups. Nothing else in the function changes;
--   the edit is applied in place and fails loudly if the expected text is not found exactly twice.
-- No change to existing orders, ledger, fees or agreements.

create table public.agreement_status_changes (
  id bigserial primary key,
  agreement_id uuid not null references public.agreements(id),
  from_status text not null,
  to_status text not null,
  changed_at timestamptz not null default now()
);
create index agreement_status_changes_idx on public.agreement_status_changes(agreement_id, changed_at);
alter table public.agreement_status_changes enable row level security;
revoke all on public.agreement_status_changes from anon, authenticated;
create trigger agreement_status_changes_append_only before update or delete on public.agreement_status_changes
  for each row execute function public.forbid_change();

create function public.log_agreement_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.agreement_status_changes(agreement_id, from_status, to_status) values (new.id, old.status, new.status);
  end if;
  return new;
end $$;
revoke all on function public.log_agreement_status() from public, anon, authenticated;
create trigger agreements_status_log after update of status on public.agreements
  for each row execute function public.log_agreement_status();

-- Status at time p_at: the "from" status of the first change after p_at, otherwise the current status.
-- A time in the future (clock skew) is treated as now.
create function public.agreement_active_at(p_agreement uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.from_status from public.agreement_status_changes c
                    where c.agreement_id = a.id and c.changed_at > least(coalesce(p_at, now()), now())
                    order by c.changed_at, c.id limit 1), a.status) = 'active'
    from public.agreements a where a.id = p_agreement;
$$;
revoke all on function public.agreement_active_at(uuid, timestamptz) from public, anon, authenticated;

-- In-place edit of ingest_order_event: the two attribution lookups.
do $$
declare v_src text; v_new text; v_old constant text := 'pc.active and a.status = ''active'' and a.store_org_id = v_conn.org_id';
        v_rep constant text := 'pc.active and public.agreement_active_at(a.id, v_order.order_created_at) and a.store_org_id = v_conn.org_id';
        n int;
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'ingest_order_event';
  n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  if n <> 2 then raise exception 'ingest_order_event: expected 2 attribution lookups, found %', n; end if;
  v_new := replace(v_src, v_old, v_rep);
  execute v_new;
end $$;

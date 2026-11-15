-- Rollback for 20261115100200_attribution_at_order_time.sql
-- Restores the previous attribution check (status at receive time). The change log table is kept (history),
-- only the trigger and function are removed.
do $$
declare v_src text; n int;
        v_new constant text := 'pc.active and public.agreement_active_at(a.id, v_order.order_created_at) and a.store_org_id = v_conn.org_id';
        v_old constant text := 'pc.active and a.status = ''active'' and a.store_org_id = v_conn.org_id';
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'ingest_order_event';
  n := (length(v_src) - length(replace(v_src, v_new, ''))) / length(v_new);
  if n <> 2 then raise exception 'expected 2 occurrences, found %', n; end if;
  execute replace(v_src, v_new, v_old);
end $$;
drop trigger if exists agreements_status_log on public.agreements;
drop function if exists public.agreement_active_at(uuid, timestamptz);
drop function if exists public.log_agreement_status();

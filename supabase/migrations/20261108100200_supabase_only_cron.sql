-- Supabase-only (skipped by local PGlite tests): nightly approval of matured commissions.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.schedule('linkup-approve-commissions', '17 2 * * *', $$select public.approve_matured_commissions()$$);

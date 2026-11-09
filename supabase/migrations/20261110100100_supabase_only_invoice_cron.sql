-- Supabase-only (skipped by local tests): monthly LINKUP payment requests for the previous month, 2nd of each month 03:23 UTC.
select cron.schedule('linkup-monthly-invoices', '23 3 2 * *',
  $$select public.run_invoice_generation((date_trunc('month', now()) - interval '1 month')::date)$$);

-- PENDING (not a migration; run only after approval, once the apps function and secrets are deployed).
-- Every 6 hours: health check, coupons and products for Shopify/Wix app connections.
-- Replace <CRON_SECRET> with the LINKUP_CRON_SECRET value (stored in Vault, never in git).
select vault.create_secret('<CRON_SECRET>', 'linkup_apps_cron_secret');
select cron.schedule('linkup-apps-sync', '17 */6 * * *', $$
  select net.http_post(
    url := 'https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/apps/cron/sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-LinkUp-Cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'linkup_apps_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
-- Undo: select cron.unschedule('linkup-apps-sync');

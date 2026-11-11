-- Rollback of 20261111102000_app_connections (only if no store uses a Shopify/Wix app connection yet).
-- Check first:  select count(*) from public.store_app_credentials;   -- expected 0 before rollback
-- Nothing is deleted: the two tables stay (empty, closed by RLS); only the functions are made uncallable.
-- If credentials exist, uninstall the app in the platform first (the uninstall webhook revokes the Vault tokens).
revoke execute on function public.start_app_install(uuid, text, text) from authenticated;
revoke execute on function public.complete_app_install(text, text, text, text, text, text, text), public.app_credentials(uuid),
  public.app_connection_by_shop(text, text), public.app_save_token(uuid, text), public.app_uninstalled(text, text),
  public.app_connections(text) from service_role;

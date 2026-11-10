-- Rollback for 20261111101300_wp_auto_connect.sql – removes ONLY the objects that migration created.
-- Safe while the feature is closed: drops the consent/request records created by this feature (none exist before it is used).
-- If consents were already recorded, export store_install_consents first (they are legal records).
drop function if exists public.disconnect_store(uuid);
drop function if exists public.wp_connect_finish(text, text, jsonb);
drop function if exists public.wp_connect_check(text);
drop function if exists public.start_wp_connect(uuid, text, text[], text, text);
drop function if exists public.wp_connect_available(uuid);
drop table if exists public.wp_connect_requests;
drop table if exists public.store_install_consents;
delete from public.app_settings where key in ('wp_auto_connect_open', 'install_consent_version');

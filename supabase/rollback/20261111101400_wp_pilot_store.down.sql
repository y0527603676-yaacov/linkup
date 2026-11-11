-- Rollback for 20261111101400_wp_pilot_store.sql: removes the pilot setting and admin function and restores
-- wp_connect_available exactly as defined in 20261111101300.
drop function if exists public.admin_set_wp_pilot_store(uuid);
delete from public.app_settings where key = 'wp_connect_pilot_org';
create or replace function public.wp_connect_available(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.setting_bool('wp_auto_connect_open') or public.is_platform_admin()
      or coalesce((select is_test from public.organizations where id = p_org), false);
$$;

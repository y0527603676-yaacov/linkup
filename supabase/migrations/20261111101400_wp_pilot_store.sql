-- One-store pilot for "connect with one approval".
-- A single real store (never a test account) can be allowed by a platform admin, while the feature stays closed for
-- every other store (wp_auto_connect_open stays false). Nothing is allowed by this migration: the pilot store is empty.
-- No change to sign-up, billing, agreements, rates or entitlements.

insert into public.app_settings(key, value) values ('wp_connect_pilot_org', 'null'::jsonb)
on conflict (key) do nothing;

create or replace function public.wp_connect_available(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.setting_bool('wp_auto_connect_open') or public.is_platform_admin()
      or coalesce((select is_test from public.organizations where id = p_org), false)
      or coalesce((select value #>> '{}' from public.app_settings where key = 'wp_connect_pilot_org') = p_org::text, false);
$$;
revoke all on function public.wp_connect_available(uuid) from public, anon;
grant execute on function public.wp_connect_available(uuid) to authenticated;

-- Platform admin: choose the single pilot store, or clear it (null). Replaces any previous pilot store.
create or replace function public.admin_set_wp_pilot_store(p_org uuid) returns json
language plpgsql security definer set search_path to '' as $$
declare v_prev text := (select value #>> '{}' from public.app_settings where key = 'wp_connect_pilot_org');
        v_name text;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_org is not null then
    select name into v_name from public.organizations where id = p_org and type = 'store' and not is_test;
    if v_name is null then raise exception 'not_a_store' using errcode = '22023'; end if;
  end if;
  update public.app_settings set value = coalesce(to_jsonb(p_org::text), 'null'::jsonb) where key = 'wp_connect_pilot_org';
  insert into public.audit_events(actor_user_id, org_id, action, target, details)
  values (auth.uid(), p_org, 'setting.wp_pilot_store', coalesce(p_org::text, 'none'), jsonb_build_object('previous', v_prev));
  return json_build_object('pilot_org', p_org, 'name', v_name);
end $$;
revoke all on function public.admin_set_wp_pilot_store(uuid) from public, anon;
grant execute on function public.admin_set_wp_pilot_store(uuid) to authenticated;

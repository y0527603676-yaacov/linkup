-- Rollback of 20261111102100_link_attribution. Nothing is deleted: app_coupons, store_link_options and the setting stay (unused).
-- Restores the previous resolve_partner_link (no discount link: /r/CODE goes to the store address with ?lku=).
create or replace function public.resolve_partner_link(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('code', c.code,
                           'url', coalesce((select sc.site_url from public.store_connections sc
                                            where sc.org_id = a.store_org_id and sc.status <> 'disconnected'
                                            order by sc.created_at desc limit 1), o.website_url))
  from public.partner_codes c
  join public.agreements a on a.id = c.agreement_id
  join public.organizations o on o.id = a.store_org_id
  where p_code ~ '^[A-Za-z0-9]{4,16}$' and lower(c.code) = lower(p_code) and c.active and a.status = 'active';
$$;
revoke execute on function public.app_coupon_mark(uuid, text, text, boolean), public.app_sync_failed(uuid, text) from service_role;
revoke execute on function public.set_link_options(uuid, boolean), public.link_options(uuid) from authenticated;
-- Faster switch without rollback: update public.app_settings set value = '0'::jsonb where key = 'shopify_discount_link';

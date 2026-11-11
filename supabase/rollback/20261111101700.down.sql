-- Rollback of 20261111101700_universal_connect. Run only after checking nothing uses the new kinds:
--   select platform, method, count(*) from public.store_connections group by 1, 2;   -- must show only woocommerce/plugin|api
--   select count(*) from public.sale_claims;                                          -- keep the table if > 0
create or replace function public.create_store_connection(p_org uuid, p_site_url text) returns json
language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_legal('store');
  return public.create_store_connection_core(p_org, p_site_url);
end $$;
revoke execute on function public.create_platform_connection(uuid, text, text), public.manual_report_order(uuid, text, date, bigint, bigint, text, text),
  public.manual_update_order(uuid, text, text, bigint), public.manual_orders(uuid), public.open_sale_claim(uuid, text, date, bigint, text),
  public.answer_sale_claim(uuid, text, text), public.sale_claims_for(uuid), public.my_partner_stores(uuid),
  public.store_tracking_modes(uuid[]), public.tracking_mode(uuid) from authenticated;
alter table public.store_connections drop constraint if exists store_connections_platform_check;
alter table public.store_connections add constraint store_connections_platform_check check (platform in ('woocommerce'));
alter table public.store_connections drop constraint if exists store_connections_method_check;
alter table public.store_connections add constraint store_connections_method_check check (method in ('plugin', 'api'));

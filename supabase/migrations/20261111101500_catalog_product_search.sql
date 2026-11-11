-- Opportunities search also matches product names ("search a store or a product").
-- Same definition as 20261111101000 (including test/real isolation) plus one search condition. Read-only function; no data change.
CREATE OR REPLACE FUNCTION public.catalog(p_search text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_limit integer DEFAULT 30)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(json_agg(x order by x.is_campaign desc, x.commission_bps desc, x.created_at desc), '[]') from (
    select o.id, o.kind, o.kind = 'campaign' as is_campaign, o.title, o.description, o.commission_bps,
           o.coupon_discount_pct, o.attribution_days, o.ends_at, o.auto_approve, o.created_at,
           s.id as store_org_id, s.name as store_name, s.website_url as store_url, s.logo_url as store_logo,
           (select count(*) from public.products p where p.store_org_id = s.id and p.status = 'active' and p.in_stock) as product_count,
           coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'image_url', p.image_url,
                                                       'price_minor', p.price_minor, 'currency', p.currency, 'url', p.permalink))
                       from (select * from public.products p
                              where p.store_org_id = s.id and p.status = 'active' and p.in_stock
                                and (cardinality(o.product_ids) = 0 or p.id = any(o.product_ids))
                              order by p.image_url is null, p.synced_at desc limit 4) p), '[]') as products
      from public.opportunities o join public.organizations s on s.id = o.store_org_id
     where auth.uid() is not null and o.status = 'live' and (o.ends_at is null or o.ends_at > now())
       and exists (select 1 from public.store_connections c where c.org_id = s.id and c.status = 'connected')
       and s.is_test = public.current_user_is_test()   -- test accounts see only test stores, real accounts only real ones
       and (p_kind is null or o.kind = p_kind)
       and (p_search is null or btrim(p_search) = '' or s.name ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%'
            or o.title ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%'
            or exists (select 1 from public.products p where p.store_org_id = s.id and p.status = 'active'
                         and (cardinality(o.product_ids) = 0 or p.id = any(o.product_ids))
                         and p.name ilike '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%'))
     order by o.kind = 'campaign' desc, o.commission_bps desc
     limit least(greatest(coalesce(p_limit, 30), 1), 100)) x;
$function$;

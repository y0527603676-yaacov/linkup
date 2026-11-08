-- Show the store the LINKUP fee that will actually apply, from settings (not hard-coded in the UI).
create or replace function public.get_public_proposal(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare p public.proposals; o public.organizations; v_status text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{24}$' then return null; end if;
  select * into p from public.proposals where token = p_token;
  if not found then return null; end if;
  select * into o from public.organizations where id = p.from_org_id;
  v_status := case when p.status in ('sent', 'opened') and p.expires_at < now() then 'expired' else p.status end;
  if p.status = 'sent' and v_status = 'sent' then
    update public.proposals set status = 'opened', opened_at = now() where id = p.id and status = 'sent';
    insert into public.funnel_events(event, proposal_id, org_id) values ('invite_opened', p.id, p.from_org_id);
    v_status := 'opened';
  end if;
  return json_build_object(
    'direction', p.direction, 'from_name', o.name, 'from_type', o.type, 'from_website', o.website_url,
    'invitee_name', p.invitee_name, 'target_site_url', p.target_site_url,
    'commission_bps', p.commission_bps, 'coupon_discount_pct', p.coupon_discount_pct,
    'attribution_days', p.attribution_days, 'status', v_status,
    'platform_fee_bps', case when public.setting_bool('founders_open') then public.setting_int('founders_fee_bps')
                             else public.setting_int('standard_fee_bps') end,
    'founders_months', case when public.setting_bool('founders_open') then public.setting_int('founders_months') end);
end $$;
revoke execute on function public.get_public_proposal(text) from public;
grant execute on function public.get_public_proposal(text) to anon, authenticated;

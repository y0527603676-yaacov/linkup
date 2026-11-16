-- Store commercial terms are accepted per STORE, not per person. A person who accepted them for one store
-- (e.g. a test store) is still asked again for another store they manage, so every store has its own record.
-- Read-only helper; nothing else changes.
create function public.legal_pending_org(p_org uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_admin(p_org) then return '[]'; end if;
  if (select type from public.organizations where id = p_org) <> 'store' then return '[]'; end if;
  return coalesce((select json_agg(json_build_object('doc_key', c.doc_key, 'version', c.version, 'audience', c.audience,
           'title_he', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'he'),
           'title_en', (select title from public.legal_documents where doc_key = c.doc_key and version = c.version and locale = 'en'),
           'reacceptance', exists (select 1 from public.legal_acceptances a where a.org_id = p_org and a.doc_key = c.doc_key))
           order by (select min(sort_order) from public.legal_documents where doc_key = c.doc_key))
      from public.legal_current() c
     where c.audience = 'store'
       and not exists (select 1 from public.legal_acceptances a where a.org_id = p_org and a.doc_key = c.doc_key and a.version >= c.requires_from)), '[]');
end $$;
revoke all on function public.legal_pending_org(uuid) from public, anon;
grant execute on function public.legal_pending_org(uuid) to authenticated;

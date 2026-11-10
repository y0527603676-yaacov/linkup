-- PUBLISH legal package v1.0 — run ONLY after written approval from Israeli counsel and the CPA,
-- and after the final text (if changed) was re-generated into legal_documents_v1_draft.sql as a NEW version.
-- Publishes the stored drafts exactly as they are (no text change). From this moment users must accept.
-- Set the effective date below before running.
begin;
\set effective_from '''2026-12-01 00:00:00+02'''
update public.legal_documents
   set status = 'published', published_at = now(), effective_from = :effective_from::timestamptz
 where version = 1 and status = 'draft'
   and doc_key in ('terms', 'store-terms', 'creator-terms', 'privacy', 'commissions', 'founding-partners', 'cookies', 'interface-notices');
insert into public.audit_events(action, target, details)
values ('legal.published', 'legal_package_v1', jsonb_build_object('version', 1, 'effective_from', :effective_from::timestamptz));
select doc_key, locale, status, effective_from from public.legal_documents where version = 1 order by sort_order, locale;
commit;

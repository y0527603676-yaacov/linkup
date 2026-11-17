-- Privacy Policy 1.1 (he + en): discloses the optional device alerts (Web Push) added in 20261116100200_web_push.
-- Version 2 is a copy of version 1 with three additions (data collected, the push services that carry the alert,
-- retention). Non-material, opt-in feature: no re-acceptance. Version 1 stays exactly as published (append-only).
create or replace function pg_temp.must_replace(p_body text, p_from text, p_to text) returns text
language plpgsql as $$
begin
  if position(p_from in p_body) = 0 then raise exception 'privacy 1.1: anchor not found: %', left(p_from, 60); end if;
  return replace(p_body, p_from, p_to);
end $$;

insert into public.legal_documents (doc_key, locale, version, title, body, audience, sort_order, requires_reacceptance,
                                    status, effective_from, published_at)
select d.doc_key, d.locale, 2, d.title,
       case d.locale
         when 'he' then
           pg_temp.must_replace(pg_temp.must_replace(pg_temp.must_replace(pg_temp.must_replace(d.body,
             'גרסה 1.0 |', 'גרסה 1.1 |'),
             'אירועי אבטחה ויומני פעילות.',
             'אירועי אבטחה ויומני פעילות. משתמש שהפעיל התראות במכשיר: גם מזהה מנוי להתראות (כתובת שירות ההתראות של הדפדפן ומפתחות ההצפנה שלה) וסוג הדפדפן.'),
             'בהיקף ההרשאות שהחנות אישרה.',
             'בהיקף ההרשאות שהחנות אישרה. התראות למכשיר (כשהמשתמש הפעיל אותן) נשלחות דרך שירות ההתראות של יצרן הדפדפן או המכשיר, כגון Google, Apple או Mozilla; תוכן ההתראה מוצפן בדרך.'),
             'יומני אבטחה וביקורת נשמרים לתקופה הנדרשת לבירור אירועים ומחלוקות.',
             'יומני אבטחה וביקורת נשמרים לתקופה הנדרשת לבירור אירועים ומחלוקות. מזהה מנוי להתראות נמחק בכיבוי ההתראות, כשהדפדפן מדווח שהמנוי אינו בתוקף, או במחיקת החשבון.')
         else
           pg_temp.must_replace(pg_temp.must_replace(pg_temp.must_replace(pg_temp.must_replace(d.body,
             'Version 1.0 |', 'Version 1.1 |'),
             'security events and audit logs.',
             'security events and audit logs. For a user who turned on device alerts: also an alert subscription identifier (the browser''s push service address and its encryption keys) and the browser type.'),
             'within the access each merchant approved.',
             'within the access each merchant approved. Device alerts (when a user turned them on) are delivered through the push service of the browser or device maker, such as Google, Apple or Mozilla; the alert content is encrypted in transit.'),
             'Security and audit logs are kept as long as needed to investigate incidents and disputes.',
             'Security and audit logs are kept as long as needed to investigate incidents and disputes. An alert subscription identifier is deleted when alerts are turned off, when the browser reports the subscription is no longer valid, or when the account is deleted.')
       end,
       d.audience, d.sort_order, false, 'published', now(), now()
  from public.legal_documents d
 where d.doc_key = 'privacy' and d.version = 1 and d.status = 'published'
on conflict (doc_key, locale, version) do nothing;

insert into public.audit_events(action, target, details)
select 'legal.published', 'privacy', jsonb_build_object('version', 2, 'label', '1.1', 'reason', 'device alerts (web push)')
 where exists (select 1 from public.legal_documents where doc_key = 'privacy' and version = 2);

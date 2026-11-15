-- Legal drafts brought in line with what LINKUP really does (WooCommerce AND Shopify, data processing for stores,
-- retention and deletion, consent-dependent attribution). DRAFTS ONLY: status stays 'draft', nothing is published,
-- no acceptance is created. Each edit must match exactly once, otherwise the whole migration stops.

create function pg_temp.legal_edit(p_key text, p_locale text, p_pattern text, p_new text) returns void language plpgsql as $$
declare v_old text; v_new text;
begin
  if not exists (select 1 from public.legal_documents) then return; end if;   -- empty database (local tests): nothing to edit
  select body into v_old from public.legal_documents where doc_key = p_key and locale = p_locale and status = 'draft';
  if v_old is null then raise exception 'draft not found: % %', p_key, p_locale; end if;
  if (select count(*) from regexp_matches(v_old, p_pattern, 'g')) <> 1 then raise exception 'pattern must match once: % % %', p_key, p_locale, left(p_pattern, 40); end if;
  v_new := regexp_replace(v_old, p_pattern, p_new);
  update public.legal_documents set body = v_new where doc_key = p_key and locale = p_locale and status = 'draft';
end $$;

-- General terms: both store platforms.
select pg_temp.legal_edit('terms', 'he', 'המערכת מסתמכת על נתונים המגיעים מחנות WooCommerce וממקורות חיצוניים\.',
  'המערכת מסתמכת על נתונים המגיעים מפלטפורמת החנות (WooCommerce או Shopify) וממקורות חיצוניים.');
select pg_temp.legal_edit('terms', 'en', 'The service relies on WooCommerce and third-party data',
  'The service relies on data from the merchant''s store platform (WooCommerce or Shopify) and third parties');

-- Store terms: platforms and access; founders period starts at the first successful connection (as implemented);
-- data processing for the store; disconnection and deletion.
select pg_temp.legal_edit('store-terms', 'he', '1\. החנות מפעילה את חנות WooCommerce שלה ומאשרת גישה טכנית בהיקף הנדרש\.',
  '1. החנות מפעילה את חנות ה-WooCommerce או ה-Shopify שלה ומאשרת גישה טכנית בהיקף הנדרש בלבד: תוסף או מפתח API ב-WooCommerce, או אפליקציית LINKUP ב-Shopify (קריאת הזמנות ומוצרים, יצירת קופוני שותפים וטעינת פיקסל ייחוס הפועל רק בהסכמת הלקוח לעוגיות).');
select pg_temp.legal_edit('store-terms', 'en', '1\. The merchant operates its WooCommerce store and authorizes necessary technical access,',
  '1. The merchant operates its WooCommerce or Shopify store and authorizes only the technical access needed: a plugin or API key on WooCommerce, or the LINKUP app on Shopify (reading orders and products, creating partner coupons and loading an attribution pixel that runs only with the customer''s cookie consent),');
select pg_temp.legal_edit('store-terms', 'he', 'ששת החודשים הקלנדריים הראשונים מתחילים ביצירת מפתח החיבור הראשון של החנות\.',
  'ששת החודשים הקלנדריים הראשונים מתחילים במועד שבו החנות חוברה בהצלחה לראשונה ל-LINKUP (קבלת נתונים מאומתת מהחנות).');
select pg_temp.legal_edit('store-terms', 'en', 'The first six calendar months begin when the merchant''s first connection key is created\.',
  'The first six calendar months begin when the merchant''s store is first successfully connected to LINKUP (verified data received from the store).');
select pg_temp.legal_edit('store-terms', 'he', '(סיום ההתקשרות לא מוחק זכויות, חובות, קיזוזים או תיקונים בגין פעילות קודמת\.)$',
  E'\\1\n12. עיבוד מידע מטעם החנות: לגבי נתוני הזמנות של לקוחות החנות, LINKUP פועלת כמעבד מידע מטעם החנות ולפי הוראותיה, לצורך ייחוס מכירות, חישוב עמלות והתחשבנות בלבד. LINKUP אינה קולטת שמות, כתובות, טלפונים, כתובות דוא"ל גלויות או פרטי תשלום של לקוחות. נקלט לכל היותר גיבוב SHA-256 של דוא"ל הקונה, לצורך זיהוי הפניה עצמית; הוא נמחק אוטומטית לאחר 120 יום, או מוקדם יותר לפי בקשת מחיקה. החנות אחראית להודיע ללקוחותיה על השימוש בשירות ולהשיג הסכמה לעוגיות כנדרש בדין. LINKUP תסייע במענה לבקשות פרטיות של לקוחות החנות בתוך זמן סביר.\n13. ניתוק ומחיקה: החנות רשאית לנתק את החיבור בכל עת (הסרת התוסף, ביטול מפתח ה-API או הסרת האפליקציה). עם הניתוק תיפסק קליטת נתונים חדשים והרשאות הגישה יבוטלו. לפי בקשת מחיקה של החנות יימחק המידע הקשור ללקוחות שאינו נדרש עוד; רישומי מכירות, עמלות והתחשבנות יישמרו לתקופה הנדרשת בדין. ניתוק אינו מבטל זכויות וחובות בגין מכירות שקדמו לו.');
select pg_temp.legal_edit('store-terms', 'en', '(Termination does not extinguish historical obligations, rights or adjustments\.)$',
  E'\\1\n12. Processing on the merchant''s behalf: for order data of the merchant''s customers, LINKUP acts as a processor on the merchant''s behalf and instructions, solely for sales attribution, commission calculation and reconciliation. LINKUP does not receive customer names, addresses, phone numbers, plaintext emails or payment details. At most a SHA-256 hash of the buyer''s email is received, to detect self-referral; it is deleted automatically after 120 days, or earlier upon a deletion request. The merchant is responsible for informing its customers about the service and obtaining cookie consent where the law requires it. LINKUP will reasonably assist with privacy requests from the merchant''s customers.\n13. Disconnection and deletion: the merchant may disconnect at any time (removing the plugin, revoking the API key or uninstalling the app). Disconnection stops new data and revokes access. Upon the merchant''s deletion request, customer-related data no longer needed is deleted; sales, commission and reconciliation records are kept for the period the law requires. Disconnection does not extinguish rights and obligations for earlier sales.');

-- Privacy policy: where order data comes from, automatic retention and deletion (now implemented).
select pg_temp.legal_edit('privacy', 'he', 'ואינו מובטח כאנונימי\.',
  'ואינו מובטח כאנונימי. הגיבוב נמחק אוטומטית לאחר 120 יום ממועד ההזמנה, או מוקדם יותר כשמתקבלת בקשת מחיקה מהחנות או מ-Shopify.');
select pg_temp.legal_edit('privacy', 'en', 'and is not necessarily anonymous\.',
  'and is not necessarily anonymous. The hash is deleted automatically 120 days after the order, or earlier when a deletion request is received from the merchant or from Shopify.');
select pg_temp.legal_edit('privacy', 'he', 'בכפוף להסדרים ולדין החל\.',
  'בכפוף להסדרים ולדין החל. נתוני הזמנות ומוצרים מתקבלים מפלטפורמות החנויות (WooCommerce ו-Shopify) בהיקף ההרשאות שהחנות אישרה.');
select pg_temp.legal_edit('privacy', 'en', 'under applicable legal safeguards and arrangements\.',
  'under applicable legal safeguards and arrangements. Order and product data come from the merchants'' store platforms (WooCommerce and Shopify) within the access each merchant approved.');
select pg_temp.legal_edit('privacy', 'he', '8\. המידע יישמר רק כל עוד נדרש.*?כמימוש קיים\.',
  '8. המידע יישמר רק כל עוד נדרש למטרות המפורטות. גיבוב דוא"ל הקונה נשמר עד 120 יום ממועד ההזמנה ואז נמחק אוטומטית. רישומי מכירות, עמלות, דרישות תשלום והתחשבנות נשמרים לתקופה הנדרשת לפי דיני המס והחשבונאות. יומני אבטחה וביקורת נשמרים לתקופה הנדרשת לבירור אירועים ומחלוקות. בקשת מחיקה מחנות Shopify או מלקוח שלה מבוצעת אוטומטית לגבי המידע הקשור ללקוח; נתונים שחובה לשמר לא יימחקו באופן הפוגע בחובה חוקית.');
select pg_temp.legal_edit('privacy', 'en', '8\. Data is kept only.*?claimed as implemented\.',
  '8. Data is kept only as long as needed for these purposes. The buyer email hash is kept for up to 120 days after the order and then deleted automatically. Sales, commission, payment-request and reconciliation records are kept for the period required by tax and accounting law. Security and audit logs are kept as long as needed to investigate incidents and disputes. Deletion requests from a Shopify merchant or its customer are carried out automatically for customer-related data; data that must legally be kept is not deleted in a way that breaches a legal duty.');

-- Cookies and attribution policy: rewritten to match the implementation and its limits.
update public.legal_documents set body = E'**גרסה 1.0 | תחולה: ממועד פרסום מאושר**\n\n1. LINKUP מזהה מכירות של שותפים בשלוש דרכים: קופון אישי של משפיען, קישור אישי, ונתוני ההזמנה שהחנות עצמה מעבירה. הקישור האישי מוסיף לכתובת קוד משפיען, זמן ביקור וחתימה דיגיטלית של LINKUP, וכן פרמטרי UTM. החתימה מונעת זיוף של קוד או זמן.\n2. ב-WooCommerce הייחוס מתבצע באמצעות תוסף LINKUP או חיבור API של החנות. ב-Shopify אפליקציית LINKUP מפעילה פיקסל ייחוס דרך הממשק הרשמי של Shopify; Shopify טוענת אותו רק כאשר הלקוח הסכים לעוגיות שיווק וניתוח, ובאזורים שבהם נדרשת הסכמה הוא לא פועל ללא הסכמה.\n3. כאשר יש הסכמה, נתוני הביקור נשמרים בדפדפן הלקוח עד 90 יום. חלון הייחוס נקבע בכל הסכם (ברירת מחדל 30 יום) ונאכף בשרת לפי זמן הביקור החתום.\n4. כללי ייחוס: קופון אישי תקף גובר על קישור; כל הזמנה משויכת למשפיען אחד לכל היותר; הזמנה כפולה אינה יוצרת עמלה כפולה; ביטולים והחזרים מעדכנים את העמלה אוטומטית.\n5. מגבלות: כאשר הלקוח דוחה עוגיות, חוסם סקריפטים או מוחק אותם, ייתכן שמכירה דרך קישור לא תשויך. LINKUP אינה מבטיחה ייחוס מלא. קופון אישי הוא הדרך היחידה לייחוס שאינה תלויה בעוגיות, והוספתו היא בחירה של החנות.\n6. החנות אחראית להציג ללקוחותיה הודעת פרטיות ועוגיות מדויקת, ולהשיג הסכמה כנדרש בדין. ב-Shopify מומלץ להפעיל את באנר העוגיות של Shopify.\n7. נתוני הזמנות עשויים לכלול גיבוב SHA-256 של דוא"ל הקונה, שאינו בהכרח אנונימי. הוא משמש רק לזיהוי הפניה עצמית ונמחק אוטומטית לאחר 120 יום.\n8. שאלות פרטיות אפשר לשלוח דרך טופס האתר או בדוא"ל.'
 where doc_key = 'cookies' and locale = 'he' and status = 'draft';
update public.legal_documents set body = E'**English - Version 1.0 | Effective upon approved publication**\n1. LINKUP identifies partner sales in three ways: a creator''s personal coupon, a personal link, and order data the store itself sends. The personal link adds a creator code, a visit time and a LINKUP digital signature to the address, plus UTM parameters. The signature prevents forging a code or a time.\n2. On WooCommerce, attribution works through the LINKUP plugin or the store''s API connection. On Shopify, the LINKUP app turns on an attribution pixel through Shopify''s official interface; Shopify loads it only when the customer consented to marketing and analytics cookies, and where consent is required it does not run without it.\n3. With consent, visit data is kept in the customer''s browser for up to 90 days. The attribution window is set in each agreement (default 30 days) and enforced on the server from the signed visit time.\n4. Attribution rules: a valid personal coupon overrides a link; each order is attributed to at most one creator; a duplicate order never creates a duplicate commission; cancellations and refunds update the commission automatically.\n5. Limits: when a customer declines, blocks or deletes cookies or scripts, a sale through a link may not be attributed. LINKUP does not guarantee full attribution. A personal coupon is the only attribution method that does not depend on cookies, and adding one is the store''s choice.\n6. The merchant must give its customers an accurate privacy and cookie notice and obtain consent where the law requires it. On Shopify, enabling Shopify''s cookie banner is recommended.\n7. Order data may include a SHA-256 hash of the buyer''s email, which is not necessarily anonymous. It is used only to detect self-referral and is deleted automatically after 120 days.\n8. Privacy questions can be sent through the site form or by email.'
 where doc_key = 'cookies' and locale = 'en' and status = 'draft';

do $$ begin
  if not exists (select 1 from public.legal_documents) then return; end if;
  if (select count(*) from public.legal_documents where doc_key = 'cookies' and status = 'draft' and body like '%Shopify%') <> 2 then
    raise exception 'cookies drafts not updated';
  end if;
  if exists (select 1 from public.legal_documents where status <> 'draft') then
    raise exception 'unexpected: a legal document is not a draft';
  end if;
end $$;

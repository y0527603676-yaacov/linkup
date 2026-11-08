# LINKUP — ארכיטקטורה

## החלטות מפתח (ADR מקוצר)
| # | החלטה | למה (פשטות / ויראליות / הכנסה) |
|---|---|---|
| 1 | **Modular monolith** אחד ב-Next.js (App Router) + TypeScript strict | צוות קטן, פריסה אחת, מהיר לשוק |
| 2 | **Supabase (PostgreSQL)**, פרויקט `linkup` נפרד. כל הלוגיקה הכספית בפונקציות SQL אטומיות (`supabase/migrations`) | טרנזקציה אחת לכל אירוע; אילוצים חזקים; מקור אמת יחיד |
| 3 | **כסף כמספר שלם ביחידות קטנות** (אגורות/סנטים) + קוד מטבע | אין שגיאות עיגול |
| 4 | **Ledger append-only** לעמלות | ביקורת מלאה, תיקון = רשומה נגדית |
| 5 | **תיבת דואר נכנס לאירועים** (`order_events` עם מפתח ייחודי) | Idempotency, אירועים כפולים/לא בסדר |
| 6 | **תוסף WordPress ב-PHP** שדוחף אירועים חתומים (HMAC-SHA256) + משיכת התאמה תקופתית | Webhook לא מובטח → reconciliation |
| 7 | **Jobs ברקע**: pg_cron ב-Supabase (אישור עמלות לילי) + Action Scheduler בתוסף | בלי תשתית נוספת |
| 8 | **אימות**: Supabase Auth — קישור או קוד במייל, בלי סיסמה | פחות שדות, מהיר לנייד |
| 11 | **הרשאות**: ללקוח רק SELECT דרך RLS; כל כתיבה דרך פונקציות SECURITY DEFINER שבודקות חברות בארגון. האתר לא מחזיק מפתח שירות | בידוד דיירים נאכף במסד עצמו |
| 12 | **קליטת WooCommerce**: Edge Function `woo` (חתימת HMAC לכל חנות) → `ingest_order_event` | הסוד לא יוצא מהשרת |
| 9 | **Adapter לפלטפורמות מסחר** (`CommercePlatform` interface) | Shopify בעתיד בלי לשנות את הדומיין |
| 10 | **i18n מהיום הראשון** (he ברירת מחדל, RTL; en מוכן) | ריבוי שפות בלי שכתוב |

## מבנה הריפו
```
linkup/
├─ apps/web/                 # Next.js — UI + API routes
│  └─ src/
│     ├─ app/                # מסכים (RTL, mobile-first)
│     ├─ domains/            # לוגיקה עסקית לפי דומיין (ללא תלות ב-UI)
│     │  ├─ attribution/     # מנוע ייחוס — פונקציות טהורות
│     │  ├─ ledger/          # חישוב עמלות ורשומות ledger
│     │  ├─ agreements/      # הצעות, הסכמים, גרסאות
│     │  ├─ integrations/    # adapters: woocommerce/ (shopify/ בעתיד)
│     │  ├─ growth/          # הזמנות, הפניות, פאנל ויראלי
│     │  └─ billing/         # עמלת פלטפורמה, חשבוניות
│     ├─ db/schema.ts        # סכמת Drizzle
│     └─ lib/                # money, auth, i18n, security helpers
├─ plugins/woocommerce/linkup-connector/   # תוסף PHP
├─ docs/                     # המסמכים האלה
└─ .github/workflows/ci.yml
```

## גבולות דומיינים
- **Integrations** מתרגם אירוע חיצוני → `NormalizedOrderEvent`. שום דומיין אחר לא מכיר WooCommerce.
- **Attribution** מקבל הזמנה מנורמלת + נקודות מגע (קופון/קליק) → מחליט מי מקבל ייחוס. פונקציה טהורה.
- **Ledger** מקבל ייחוס + גרסת הסכם → כותב רשומות. לא מעדכן, רק מוסיף.
- **Billing** קורא מה-ledger → מחשב עמלת פלטפורמה וחשבונית.
- **Growth** מנהל הזמנות ומקור הפניה; לא נוגע בכסף, רק מתייג `referral_id`.

## זרימת אירוע הזמנה (מיושם)
```
WooCommerce hook → Action Scheduler → תוסף חותם HMAC → Edge Function `woo`
 → אימות חתימה + timestamp (≤5 דק') → ingest_order_event (טרנזקציה אחת):
   inbox ייחודי → upsert הזמנה (אירוע ישן לא דורס חדש) → החזרים → ייחוס → יישור ledger למצב היעד
תוסף כל 15 דק': heartbeat + סנכרון קופונים + שליחה חוזרת של הזמנות שעודכנו (מזהי אירוע דטרמיניסטיים).
```

## סביבות
`development` (מקומי/Docker Postgres), `preview` (לכל PR), `production`. מסד נתונים נפרד לכל אחת. סודות רק במשתני סביבה של ספק האחסון.

## אחסון מומלץ (לא נפרס — דורש אישור)
Vercel (web) + Neon או Supabase (Postgres) — שניהם עם שכבה חינמית לפיתוח. עלות פיילוט משוערת: $0–45 לחודש.

## סיכונים טכניים
| סיכון | טיפול |
|---|---|
| Webhooks נופלים / כפולים | מפתח ייחודי + reconciliation שעתי |
| חנות מוחקת את התוסף | ניטור heartbeat; היסטוריה נשמרת |
| קופון דולף לאתרי קופונים | זיהוי שימוש חריג + אפשרות להחליף קופון |
| מטבעות מרובים | כל סכום עם מטבע; ללא המרה בשלב 1 |
| עיכוב עד ידיעה על החזר | עמלה "ממתינה" עד תום חלון ההחזרות (ברירת מחדל 14 יום) |

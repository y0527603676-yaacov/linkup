# LINKUP — ארכיטקטורה

## החלטות מפתח (ADR מקוצר)
| # | החלטה | למה (פשטות / ויראליות / הכנסה) |
|---|---|---|
| 1 | **Modular monolith** אחד ב-Next.js (App Router) + TypeScript strict | צוות קטן, פריסה אחת, מהיר לשוק |
| 2 | **PostgreSQL** + **Drizzle ORM** | אילוצים חזקים לכסף; טיפוסים מקצה לקצה |
| 3 | **כסף כמספר שלם ביחידות קטנות** (אגורות/סנטים) + קוד מטבע | אין שגיאות עיגול |
| 4 | **Ledger append-only** לעמלות | ביקורת מלאה, תיקון = רשומה נגדית |
| 5 | **תיבת דואר נכנס לאירועים** (`order_events` עם מפתח ייחודי) | Idempotency, אירועים כפולים/לא בסדר |
| 6 | **תוסף WordPress ב-PHP** שדוחף אירועים חתומים (HMAC-SHA256) + משיכת התאמה תקופתית | Webhook לא מובטח → reconciliation |
| 7 | **Jobs ברקע**: טבלת jobs ב-Postgres (pg-boss) | בלי Redis/תשתית נוספת בהתחלה |
| 8 | **אימות**: Magic link במייל + OTP ב-SMS (שלב 1: מייל בלבד) | פחות שדות, אין סיסמה, מהיר לנייד |
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

## זרימת אירוע הזמנה
```
WooCommerce hook → תוסף חותם HMAC → POST /api/webhooks/woocommerce
 → אימות חתימה + timestamp (≤5 דק') → INSERT order_events (ON CONFLICT DO NOTHING)
 → 200 מיד → job: עיבוד לפי סדר כרונולוגי לכל הזמנה
 → attribution → ledger entries
Cron כל שעה: משיכת הזמנות שעודכנו מ-WooCommerce REST → השוואה → אירועים חסרים.
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

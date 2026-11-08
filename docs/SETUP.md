# LINKUP — הקמה והפעלה

## מה כבר קיים
- Supabase: פרויקט `linkup` (מזהה `ycuvcpslvkgndytubycn`, אזור eu-central-1) — טבלאות, הרשאות, פונקציות, Edge Function `woo`, משימה לילית לאישור עמלות.
- משתני סביבה לאתר (ציבוריים, בטוחים לדפדפן):
```
NEXT_PUBLIC_SUPABASE_URL=https://ycuvcpslvkgndytubycn.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_l9jf_WeuH8ZAmSlQE8qfIw_mgwQ_QL9
```

## פריסה (Vercel)
- Root Directory: `apps/web` · Framework: Next.js · שני משתני הסביבה למעלה.

## אימות במייל (Supabase → Authentication → URL Configuration)
- Site URL: כתובת ה-Vercel.
- Redirect URLs: `https://<כתובת-vercel>/**`

## הגדרות עסקיות (טבלה `app_settings`)
standard_fee_bps=300 · founders_fee_bps=200 · founders_open=true · founders_months=6 · referral_reward_bps=1000 · referral_months=12 · refund_hold_days=14 · default_attribution_days=30.
שינוי ערך חל מכאן והלאה; עמלות שכבר נרשמו לא משתנות.

## גבייה ידנית (פיילוט)
בסוף חודש: `select public.platform_fee_report('2026-11-01','2026-12-01');` → סכום לכל חנות → בקשת תשלום ב-Grow.

## נתוני בדיקה
קיימת חנות פנימית "LINKUP TEST STORE (internal)" ששימשה לבדיקת ה-Edge Function החי. אינה לקוח.

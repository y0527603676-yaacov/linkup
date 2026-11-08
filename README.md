# LINKUP

SaaS שמחבר חנויות WooCommerce, משפיענים וסוכנויות — עמלה רק על מכירות מאומתות.

- `docs/` — אפיון, ארכיטקטורה, מודל נתונים, כללים עסקיים, אבטחה, תוכנית פיתוח ופיילוט
- `apps/web/` — Next.js + TypeScript + Drizzle (Postgres)
- `plugins/woocommerce/linkup-connector/` — תוסף WordPress

## הרצה מקומית
```bash
cd apps/web
cp .env.example .env.local
npm install
npm test
npm run dev
```

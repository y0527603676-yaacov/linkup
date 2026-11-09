# LINKUP — full build (branch `full-build`)

## What is in this build
- Hebrew + English (RTL/LTR), language by choice or browser; landing pages: `/`, `/stores`, `/creators`, `/founding-partners`.
- One account, several activities (store / creator); switcher in the app header.
- Store: connection (existing plugin), product & stock sync (plugin 0.3.0), standing offer in the catalogue,
  LINKUP LAUNCH campaigns (whole-order campaign rate, auto-enrolment of partners), partners & applications,
  direct invites, payments to creators (mark paid → creator confirms), monthly LINKUP payment requests, team & roles.
- Creator: catalogue with real products, instant/manual join, coupon + link per store, content maker
  (WhatsApp / post text, 1080×1920 story image), balances per store, payout confirmation.
- FOUNDING PARTNERS: personal invite links (`/join/CODE`), 40% of collected LINKUP fee for 90 days from the referred
  party's first effective sale (within 12 months), 20/20 split for two referrers, no reward on own deals or
  self-referral, reversals on refunds, wallet offset against invoices or transfer above ₪100.
- Next-action cards on every home screen; notifications; growth funnel events; pilot admin (`/app/admin`).

## Database migration plan (needs explicit approval before production)
1. Backup (Supabase dashboard → Database → Backups) — confirm a fresh daily backup exists.
2. Apply `20261110100000_growth_catalog_billing.sql` (additive; existing referrals are marked `legacy`;
   `create_organization` gains two optional parameters — existing calls keep working).
3. Apply `20261110100100_supabase_only_invoice_cron.sql` (monthly payment requests).
4. Deploy edge function `woo` (adds the `products` action; old plugin versions are unaffected).
5. Insert the platform admin: `insert into platform_admins(user_id) values ('<your auth user id>');`
6. Deploy the web app (merge `full-build` → `main`). Then upload plugin 0.3.0 to the pilot store.
Rollback: the web app and edge function can be reverted by redeploying the previous commit; the migration only adds
objects (no data rewritten except `referrals.program = 'legacy'`), so the previous app keeps working against it.

Verified locally: 75 DB tests (PGlite) + the migration applied on PostgreSQL 16 over a database with existing rows;
all app pages rendered with real data in both languages at phone width (no horizontal scroll, no JS errors).

## After the pilot (not in this build)
- Agency accounts and split rules UI; card billing automation (Grow API) and automatic tax documents.
- Quick connect without plugin (WooCommerce REST keys) — decision D7.
- Per-product-line campaign commission (D8 option b); Shopify and other platforms; more languages.
- Email notifications via Resend (in-app notifications exist; email sending activates once the Resend key is set).
- Final legal texts (terms, privacy) from the lawyer; accountant answer on creator documents.

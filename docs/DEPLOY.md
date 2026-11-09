# LINKUP — controlled production deployment (prepared, NOT executed)

## Verified before deployment
| Check | Result |
|---|---|
| DB tests (PGlite, real migrations) | 88 passed — incl. exact-amount money scenario (`tests/db/money.test.ts`) |
| Browser journeys (local PostgreSQL 16 + PostgREST, phone size) | 25/25: store, creator, combined user, store staff, partnership invite, viral invite, content maker, LINKUP LAUNCH, English |
| Migration on a copy of production data | applied cleanly; existing orders/ledger/referrals intact; Heleni dashboard OK; plugin 0.2.1 events (duplicate + new) processed with correct amounts |
| Rollback on the migrated copy | `supabase/rollback/…down.sql` restores the exact previous function set; orders & ledger kept; plugin events still processed |
| Production schema = repo | 6 applied migrations match the repo files |

## Compatibility
| Component | Rule |
|---|---|
| Plugin 0.2.1 (live at heleni-jewelry.com) | Works unchanged with the new DB and new edge function (same `sync` / `event` actions). No upgrade required. |
| Plugin 0.3.0 | Adds product sync. Install only after the edge function is deployed (before that its product calls are refused harmlessly). |
| Current site (main) + new DB | Works: `create_organization` keeps its 3 named parameters (2 new optional ones). |
| New site + old DB | Does NOT work → the database step must come first. |

## Production steps (in this order)
1. Verify backup: Supabase → Database → Backups → a daily backup from today exists (Pro plan: 7 days kept). Also save a fresh data export (read-only).
2. Apply migration `20261110100000_growth_catalog_billing`.
3. Apply `20261110100100_supabase_only_invoice_cron` (monthly payment requests, 2nd of month 03:23 UTC).
4. Smoke checks (read-only SQL): Heleni connection still `connected`; `org_dashboard` for Heleni returns; ledger sum unchanged.
5. Deploy edge function `woo` v2 (adds `products`). Smoke: next plugin sync (≤15 min) updates `last_sync_at`.
6. Add the platform admin row for your user.
7. Merge `full-build` → `main` (Vercel deploys the site). Smoke: `/`, `/stores`, `/creators`, login, `/app`.
8. (Optional, later) Install plugin 0.3.0 at the pilot store.

The active store is never touched: no plugin change is required, events keep flowing during steps 2–7
(an event that hits a moment of deployment gets 5xx and the plugin retries it).

## Rollback
- Site: Vercel → Deployments → previous deployment → "Promote to Production" (instant).
- Edge function: redeploy version 1 from `main`.
- Database: `supabase/rollback/20261110100000_growth_catalog_billing.down.sql` (one transaction, tested). Removes only
  data of the new features; orders, attributions, ledger, referrals and organizations are kept.
- Last resort: restore the daily backup (loses data since the backup).

## Not public yet
Terms and privacy pages are drafts, marked "under legal review" and excluded from search engines (noindex).

## Executed — 2026-11-09 (controlled technical deployment)
1. Backup: in-database snapshot schema `backup_20261109` (all 17 public tables incl. connection secrets; counts verified) + local data export. Supabase daily backup (Pro) not visible via tools — confirm in dashboard.
2. Migration `growth_catalog_billing` applied from the exact repo file (commit de77fb2, sha256 verified before execution).
3. Invoice cron NOT applied (no real bills until commercial approval). Invoices can only be generated manually by the platform admin.
4. Smoke: data unchanged (3 orgs, 3 orders, 4 ledger rows, 2 connections), Heleni dashboard OK, isolation OK (stranger sees 0 rows).
5. Edge function `woo` v2 deployed; unauthenticated call → 401 (auth active).
6. Platform admin: owner account.
7. `full-build` merged to `main`; Vercel production deployment succeeded; public pages 200 in he/en; terms page noindex.
Public sign-up: closed (`LINKUP_SIGNUPS_OPEN` not set) — existing accounts can log in.

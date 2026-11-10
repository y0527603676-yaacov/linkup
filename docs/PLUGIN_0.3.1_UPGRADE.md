# Heleni — plugin upgrade 0.2.1 → 0.3.1 (needs your separate approval)

## What changes
Only additions: product & stock sync (read-only towards the store — LINKUP never edits products).
Order reporting, coupons, the `?lku=` link cookie, the connection key and settings are byte-for-byte unchanged
(diff: 110 lines added, only the version number removed).

## Verified
- PHP syntax OK; 16/16 checks on a WordPress/WooCommerce stub harness (`plugins/woocommerce/tests-harness.php`):
  prices in minor units, out-of-stock, hidden/draft excluded, variations rolled up to parent, https images,
  one signed batch per request, 100 products per sync page, failed page retried, nothing sent when disconnected.
- Payloads accepted by the production-copy database: 6 products synced, 5 in stock, shown in the catalogue.
- Server side already live: edge function v2 accepts `products`; old 0.2.1 keeps working.

## Backup before installing
1. In WordPress: Plugins → note LINKUP Connector 0.2.1 is active.
2. Hosting backup / the store's backup plugin: take a fresh backup (files + database).
3. Rollback file ready: https://linkup-tawny.vercel.app/downloads/linkup-connector-0.2.1.zip

## Install (2 minutes)
Plugins → Add New → Upload Plugin → choose linkup-connector.zip (0.3.1) → Install → "Replace current with uploaded".
The connection key stays saved. Then LINKUP settings → "Sync now".

## Check after install
- LINKUP → Products shows the store's products within ~15 minutes (first full pass, 100 per sync).
- A new order with a coupon still appears in LINKUP as before.

## Rollback
Same upload flow with linkup-connector-0.2.1.zip → "Replace current with uploaded". Settings and key stay.
Products already synced remain in LINKUP (harmless); nothing in the store changes.

## 0.3.1 change
Product updates on save are sent fire-and-forget (non-blocking), so saving a product never waits for LINKUP.
Anything missed is caught by the 6-hourly full catalogue pass. Order reporting is unchanged.

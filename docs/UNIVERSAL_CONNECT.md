# Universal Connect – stage 1–3 (built, waiting for DB approval)

One connection layer for every platform; fees, attribution and the ledger are shared and unchanged.

| Kind | platform / method | Status |
|---|---|---|
| WooCommerce plugin / REST | woocommerce / plugin, api | live (unchanged) |
| Custom site, signed API | custom / signed_api | built + tested locally; uses the existing `woo` Edge Function (same HMAC, same ingestion) |
| Manual coupon mode | manual / manual | built + tested locally |
| Shopify | shopify / app | adapter prepared (order mapping + webhook HMAC), unit-tested; needs Partner account + dev store |
| Wix | wix / app | adapter prepared (order mapping + JWT RS256), unit-tested; needs developer account + test site |
| Referral tracking only | – | not built; will never create commissions |

Rules kept: unique order id per connection, duplicate events ignored, refunds/cancellations reverse commissions,
refund window unchanged, audit trail (order_events + audit_events), sale claims for missing/wrong sales,
no commission from a tracking event. A signature proves the sender, not the transaction.

Migration: `supabase/migrations/20261111101700_universal_connect.sql`, rollback `supabase/rollback/20261111101700.down.sql`.
Developer guide: `/developers`.

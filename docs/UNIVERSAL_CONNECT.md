# Universal Connect (built on full-build, waiting for DB approval)

One connection layer for every platform; fees, attribution and the ledger are shared and unchanged.

| Kind | platform / method | Status |
|---|---|---|
| WooCommerce plugin / REST | woocommerce / plugin, api | live (unchanged) |
| Custom site, signed API | custom / signed_api | built + tested locally; uses the existing `woo` Edge Function (same HMAC, same ingestion) |
| Manual sales reporting | – | removed (not part of the product) |
| Shopify | shopify / app | adapter prepared (order mapping + webhook HMAC), unit-tested; needs Partner account + dev store |
| Wix | wix / app | adapter prepared (order mapping + JWT RS256), unit-tested; needs developer account + test site |
| Referral tracking only | – | not built; will never create commissions |

Rules kept: unique order id per connection, duplicate events ignored, refunds/cancellations reverse commissions,
refund window unchanged, audit trail (order_events + audit_events), sale claims for missing/wrong sales,
no commission from a tracking event, no double commission when two connections of one store report the same sale, founders clock for API stores starts at the first real connection. A signature proves the sender, not the transaction.

Migration: `supabase/migrations/20261111101700_universal_connect.sql`, rollback `supabase/rollback/20261111101700.down.sql`.
Developer guide: `/developers`.

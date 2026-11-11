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

## Connection help and measurement (migration 20261111101800)
- Step-by-step WooCommerce guide (`/app/connect/guide`), one instruction per screen; wp-admin links only for verified stores.
- Help request (`/app/connect/help`): phone call, screen share, or remote control with explicit consent. No passwords or payment
  details; the phone number is erased when the request is closed. Platform admin sees and closes requests (admin → overview).
- Custom sites are never presented as the owner's technical task: primary action = ask for help; secondary = a ready
  message for whoever built the site.
- Funnel (admin → overview, 30 days): started, connected on their own / with the guide / with assistance, not connected,
  unsupported platforms, top failure reasons. Goal: 80% on their own (measured, not promised).

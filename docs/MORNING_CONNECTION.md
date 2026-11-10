# Connecting Morning (Green Invoice) for the LINKUP fee — verification and steps

Status: **not connected.** `BILLING_PROVIDER=simulated`, `auto_collection_enabled=false`. Branch `full-build`.

Sources: Morning's official OpenAPI reference ("morning API Documentation" v2.0.0, developers.morning.co —
read from a snapshot of `openapi.bundled.json`, since the docs site renders by script and could not be opened
directly here) and Morning's help centre pages (API key, saved cards, webhooks, clearing prices).

## Verified in Morning's documentation

| Need | Documented | How LINKUP uses it |
|---|---|---|
| Auth | OAuth 2.0 client credentials, `POST /idp/v1/oauth/token` → `accessToken` (1 hour). Separate keys per environment. | `morningClient` caches the token for 55 min. |
| Base URLs | Production `https://api.greeninvoice.co.il/api/v1` · Sandbox `https://sandbox.d.greeninvoice.co.il/api/v1` | `MORNING_ENV` (default sandbox). |
| Charge a saved card later | `POST /payments/tokens/{id}/charge` — charges and **returns the created document** (type 320 tax invoice-receipt: id, number, url, vatRate, transactionId). | One call = payment + its tax document. LINKUP decides the date (store's authorised timing). |
| Find saved cards | `POST /payments/tokens/search` (filter by Morning client id, last 4, status, expiry). | Linking a store to its saved card. |
| Payment ↔ document match | Charge response carries document id + transaction id. | Recorded on the payment request; a VAT-rate mismatch is not auto-recorded → exceptions queue. |
| Preventing double charges | No idempotency key. Error 1010 "request with identical data exists". `POST /documents/search` filters by description. | Charge description = `LINKUP-<request id>`; a retry first searches for it (`findCharge`) and records the earlier charge instead of charging again. One charge per request in the DB. |
| Webhooks | Set in the Morning UI. Events incl. `document/created`, `payment/received`. `x-webhook-signature` = HMAC-SHA256 (hex) of the raw body with the webhook secret; `x-webhook-delivery-id` unique. 15 failed deliveries → webhook disabled. | Signature checked in constant time; unsigned deliveries rejected; each delivery stored once. |
| Credit invoice | `POST /documents` type 330 with `linkedDocumentIds` + `linkType`. | Not called automatically (see refunds). |

## Not in the documented API (not assumed)

1. **Saving a card through the API / hosted "save card" page.** Documented only in the Morning UI: client record →
   "הוספת כרטיס אשראי" → email request to the client or manual entry (client consent required).
2. **Card refunds through the API.** Refunds are a Morning UI action ("חיוב וזיכוי … כולל הפקת חשבונית מתאימה").
3. **Offsets.** The automatic document covers the charged amount only; a request with a FOUNDING PARTNERS offset
   (fee + VAT documented in full, reward separately) is refused by the adapter and collected manually.
4. **Sandbox token host** is not stated in the reference (`MORNING_SANDBOX_IDP_URL` must be set from Morning).
5. Whether the payment-form (`/payments/form`) can also save the card for future charges.

Questions for Morning support: items 1, 2, 4, 5, and whether `/payments/tokens/{id}/charge` may be used for
merchant-initiated charges on a date the customer authorised in advance (terms of the Grow clearing agreement).

## Plans and costs (Morning site, prices excl. VAT, to confirm before buying)

- API keys: **Best and above**. Webhooks: **Extra** (per Morning's webhook article). Saved cards: Best and above.
- Clearing (via Grow): Best — 1.2 ₪ per transaction + 1.4%; Extra — 1.2 ₪ + 1.4% down to 0.95% by volume. ILS only.

## Server environment (only after approval)

`BILLING_PROVIDER=morning` · `MORNING_ENV=sandbox|production` · `MORNING_API_KEY_ID` · `MORNING_API_KEY_SECRET` ·
`MORNING_WEBHOOK_SECRET` · `MORNING_SANDBOX_IDP_URL` (sandbox only) · plus `BILLING_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.
Webhook URL: `https://<domain>/api/billing/webhook/morning`.

## Tests

`apps/web/tests/morning.test.ts` (11) against a mocked HTTP layer shaped like the documented API: token caching,
charge body and returned document, refusal of offset / amount / currency mismatches, declines, VAT-rate mismatch,
no card saving or refunds via API, lost-response reconciliation in the runner (no second charge), webhook signatures.

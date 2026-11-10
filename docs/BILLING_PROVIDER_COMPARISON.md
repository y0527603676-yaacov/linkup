# Collecting the LINKUP fee: provider comparison and double-charge protection (branch `full-build`)

Requirement: the store saves a card **inside LINKUP**, on the provider's secure page, once, with an explicit
authorisation. LINKUP then charges on the date the store chose, gets a tax document, and never charges twice.

## Morning: does it fit?

**Not as required, today.**
- Morning's documented API charges a saved card (`/payments/tokens/{id}/charge`, document included).
- Saving the card is documented only in the Morning UI. The owner opens the store's client record in Morning and sends an email request; the store enters the card from that email.
- No API or hosted "save card" page that LINKUP can open is documented. Whether `/payments/form` can also save a token is not stated.
- Morning's clearing is Grow.

## Alternatives (official documentation read; costs are not public for any of them except via Morning)

| | Grow (direct, Light API) | Cardcom (API v11) | PayPlus | Tranzila |
|---|---|---|---|---|
| Card saved on the provider's page from LINKUP | `createPaymentProcess` + `saveCardToken=1` (token returned **after a payment**; card-only save not stated) | LowProfile `Operation=CreateTokenOnly` (no charge) | payment link with `create_token`, `charge_method` J2 card check / J5 | hosted fields `tokenize=true`, `tran_mode` N = J2 validate |
| Later charge by LINKUP | `createTransactionWithToken` (server only) | `Transactions/Transaction` with token (from a third-party summary) | `Transactions/Charge` with `use_token` | not read |
| **Duplicate protection by the provider** | **Yes, documented**: `transactionUniqueIdentifier` (a repeated value is rejected whatever happened to the first) and `transactionGroupIdentifier` (rejected if a successful payment with that value exists) | not documented (`ReturnValue` echo only) | not documented | not documented |
| Result notification / status | `notifyUrl`; Get Transaction Info; Get Payment Process Info | WebHookUrl, 7 retries; `GetLpResult`; `GetTransactionInfoById` | IPN; View transaction | `notify_url` (IPN); signed `response_hash` |
| Refund | Refund Transaction endpoint (listed) | `RefundByTransactionId` (+ credit note, third-party summary) | Refund by transaction UID | not read |
| Tax documents | invoice fields + `invoiceNotifyUrl`; whether Grow issues the document itself is not stated. Can be paired with Morning's documented `POST /documents`. | built-in Documents model: `TaxInvoiceAndReceipt` in the same request | Invoice+ (allocation numbers stated) | "digitally signed tax invoice on payment" |
| API access | via Grow support | terminal + API name | API key + secret | handshake + keys |

**Recommendation: Grow directly** (Light API), subject to Grow confirming two points:
1. a card-only save (or J5) on its hosted page;
2. permission for merchant-initiated token charges.

Why Grow:
- It is the only provider whose documentation states provider-side duplicate rejection. That is the strongest protection against double charging.
- It is the same clearing company behind Morning, so Morning can remain the document system.
- The owner already uses it.

**Fallback: Cardcom.** It documents a card-only token save and documents issued in the same request. It does not document duplicate protection.

## Double-charge protection (migration `20261111100800_billing_unknown_outcome.sql`)

| Situation | Behaviour |
|---|---|
| Provider charged, LINKUP got no answer (timeout, network error, 5xx, unreadable reply) | Charge becomes **unknown**. No retry. Next run asks the provider (`findCharge`). Found → paid once + document. Not found → stays unknown in the exceptions queue; only the owner resolves it, with a reason. |
| Worker stopped mid-charge | Charges left "processing" for 15 min become unknown (same rules). |
| Webhook late or repeated | Stored once per delivery id. Applying it is idempotent: one payment request = at most one successful charge (unique index). A copy after payment → "duplicate". |
| Provider reports success after LINKUP saw a decline, or after the request was paid otherwise | Waiting retries are cancelled at once. An alert is raised for the owner (refund decision). No further charge until the alert is handled. |
| Retry after a communication failure | Only after a **definitive** decline, or after an unknown result is resolved as "not charged". Manual "paid" and "retry now" are refused while a result is unknown or an alert is open. |
| Charge ↔ document ↔ payment request | One success per request. The document is recorded once per number and linked to the request. With Morning the document comes back in the same call; a VAT-rate mismatch is not auto-recorded (→ "document missing"). |

Tests: `billing-unknown.test.ts` (6), `morning.test.ts` (13), settlement e2e (webhook duplicate).

Remaining limit: refunds have no "unknown" state yet. A refund that times out is shown as failed, and re-requesting it should be checked against the provider first. Refunds stay manual until a provider is chosen.

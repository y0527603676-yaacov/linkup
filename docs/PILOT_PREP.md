# Pilot preparation + accounting basis (branch `full-build`, not deployed)

Two new migrations, applied together in one transaction, in this order:

1. `supabase/migrations/20261111100000_pilot_prep.sql`: fee terms per store, payment-request VAT, verified delivery and due date, creator payment due date, legal documents and acceptances.
2. `supabase/migrations/20261111100100_accounting.sql`: implements the accounting document approved by the accountant (separate VAT on fee and on referral reward, offset as settlement, tax profiles, zero-rate for verified foreign stores, external accounting documents, immutable payment requests, commission-base breakdown).

Neither migration is applied to production. `invoicing_tax_approved` stays `false`, so real payment requests stay switched off until LINKUP explicitly approves real collection.

## Verified

- **DB tests (PGlite):** 117 passing, including `pilot-prep.test.ts` (17) and `accounting.test.ts` (12).
- **Production-data copy (local Postgres 16):** the copy rebuilds the production history, replays the four live events of test order #2483 exactly as received, and reaches a ledger identical to production (10 rows). After applying both migrations in a single transaction:
  - 0 ledger rows were changed or lost, and 0 orders were changed;
  - Heleni and the test store were locked to founders 2% until 2027-05-08, then 3% (source `backfill`);
  - replaying the events again adds nothing (idempotent);
  - no invoices, legal documents or tax profiles were created.
- **Local full stack (PostgREST + Next):**
  - `scripts/e2e-journeys.cjs`: 25 existing user paths still pass;
  - `scripts/e2e-pilot-prep.cjs`: 33 new checks pass (tax profile, verification, gate, preview, generation split, delivery → due date, counter-document, rate proposal and decline, legal centre, one-time acceptance, sign-up and connection checkboxes, he/en at phone width).

## Payment request record (per store, per month)

| Field | Meaning |
|---|---|
| `fees_minor` | LINKUP fee before VAT |
| `vat_bps` / `vat_minor` | VAT on the **full** fee. The rate is captured at issue: 0 only for a verified zero-rate foreign resident. |
| `reward_offset_minor` | FOUNDING PARTNERS reward used as settlement (wallet debited by this amount only) |
| `reward_vat_bps` / `reward_vat_minor` | VAT on the reward, by the store's **verified** classification: company or authorised dealer 18%, exempt dealer 0. Unverified → no offset; the reward stays in the wallet. |
| `credit_minor` | Total offset = reward + its VAT |
| `total_minor` | Balance to pay = fee + VAT − offset |
| `store_classification` | The classification at issue |
| `delivered_at`, `delivery_method`, `due_at` | `due_at` = verified delivery + 14 days, never presumed |

`accounting_documents` records the external tax documents from both sides (append-only). Each document is linked to a payment request or to a reward transfer.

## Decisions still open (see final report)

- Cash rewards to a private individual (not a business): which documentation route. Currently blocked.
- Referral rewards of a foreign-resident store or referrer: VAT treatment. Currently not settled; the reward stays in the wallet.
- Withholding tax on reward transfers: not built. Each transfer requires the referrer's document.
- What happens to a store that does not accept a future rate increase. Its current rate continues; nothing is terminated.

## Final pilot items (migration `20261111100300_pilot_final.sql`)

- **Rate-increase notices:** `fee_change_notices` records each event (created / sent / delivered / failed) with channel, recipient, reference and time. These records are append-only. A store can accept only after a documented delivery. The increase starts at the latest of: the stated date, delivery + 30 days, and the moment of acceptance. Without proven delivery, nothing applies and nothing pauses.
- **Orderly wind-down after a refusal:**
  - The plan, its completion and its cancellation are all explicit admin actions; nothing happens automatically.
  - Completing a plan ends existing collaborations for future attribution only. Recorded sales, commissions, rewards and coupons are not touched.
  - Planning is refused until counsel sets `wind_down_notice_days`.
- **Settlements awaiting accounting decisions:** while `reward_settlement_approved` is `false`, no offset is taken on payment requests and no cash reward transfer is possible. Rewards stay in the balance.
- **Legal text correction pending for v1.1:** see `docs/legal/NEXT_VERSION_CORRECTIONS.md` (Google Fonts sentence).

## Creator settlement (migration `20261111100500_creator_settlement.sql`)

Each store keeps its own payment provider. There is no split at sale time, and LINKUP never holds or moves creator money.

- **Balance:** outstanding = approved commission − payments the store reported (excluding withdrawn reports). A negative balance is a credit to the store and is never shown as money to pay.
- **Due date:** approval date of the oldest uncovered approved amount (first in, first out) + 14 days. Statuses: due soon, overdue.
- **Reporting a payment:**
  - Partial payments are allowed; a report can never exceed the outstanding amount.
  - Each form submission is idempotent, so a double click records one payment.
  - VAT paid on top is recorded separately.
  - The store can attach a proof (PDF or image, up to 2 MB).
- **Status flow:**
  - "Store reported a payment" → "Creator confirmed receipt", or "Reported not received" with a reason.
  - The store can answer a dispute. A disputed report can still be confirmed later.
  - A report made by mistake is withdrawn, never deleted.
- **Creator payment details:**
  - Readable only through audited functions; there is no table access.
  - A store sees them only while there is an outstanding balance in a real collaboration.
- **Statement / payment request:** the same data for both sides, labelled "not a tax document", printable, with a CSV export. The tax-document note depends on the creator's verified classification.
- **Reminders:** `creator_payment_reminders()` notifies both sides when a payment is due soon or overdue. It is idempotent and runs inside the billing worker.

## Automatic collection of the LINKUP fee (migration `20261111100600_billing_automation.sql` + `apps/web/src/lib/payments`)

- **Provider-neutral layer:** `PaymentProvider` (hosted card page → token, charge, refund, webhook) and `DocumentProvider` (tax invoice-receipt, credit note).
  - Simulated adapters are used for development.
  - The Morning adapter is a guarded stub that throws until it is connected.
- **Store:**
  - Saves a payment method once (token plus masked card) with an explicit authorisation. The authorisation wording is pending legal review.
  - Chooses when to charge: N days after verified delivery (0–14), or on the due date. The contractual due date stays delivery + 14 days.
- **Database rules:** schedule → claim (skip locked) → complete. Retries follow `collection_retry_days` (default [2, 5]); a final failure becomes an exception.
  - An open dispute blocks automatic charging of that request.
  - Manual "paid" cancels a waiting charge.
  - Removing the card cancels charges that have not started.
  - Refunds lead to a credit note.
  - Webhook events are stored once.
- **Master switch:** while `auto_collection_enabled` is false, nothing is scheduled or charged. `billing_provider` is `simulated`.
- **Worker:** `POST /api/billing/run`, which requires `BILLING_CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` in server env. Webhooks arrive at `/api/billing/webhook/<provider>`. The simulated card page appears only when `BILLING_SIMULATION=true`.
- **Owner:** finance dashboard (`finance_dashboard()`) and a single exceptions queue (`billing_exceptions()`) with suggested actions (retry charge, refund).

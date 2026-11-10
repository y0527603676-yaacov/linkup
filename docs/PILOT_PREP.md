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

# Legal package v1.0: how it is embedded

- **Source of truth:** `docs/legal/LINKUP_legal_package_2026-11-10.md`, a copy of the file as received. 8 documents in Hebrew and English.
- **Generator:** `scripts/legal/build_legal_seed.py`. It writes `supabase/seed/legal_documents_v1_draft.sql` verbatim, with a sha256 of the source. A test checks that the stored text is identical to the source.
- **Status:** all 16 rows are loaded as **drafts**. Drafts are not public; platform admins can preview them from the admin screen (`/legal/<key>?draft=1`).
- **Publication:** after counsel and CPA approval, run `supabase/seed/legal_documents_v1_publish.sql` after setting the effective date. A published version is immutable. A later change is saved as version 2 (`requires_reacceptance` only for a material change).

| key | document | who must accept | when |
|---|---|---|---|
| terms | General Terms of Use | everyone (accept) | sign-up / one-time screen |
| privacy | Privacy Policy | everyone (**acknowledge**, not consent) | sign-up / one-time screen |
| creator-terms | Creator Terms | creators | creating a creator activity |
| store-terms | Commercial Terms for Merchants | stores | connecting a store |
| commissions | Commissions, Payments and Reconciliation Policy | stores | connecting a store (linked from billing and collaborations) |
| founding-partners | FOUNDING PARTNERS Program Terms | informational (linked) | rewards screen |
| cookies | Cookies and Sales Attribution Policy | informational | footer notice once published |
| interface-notices | Interface Notices and Consent Copy | informational | source of the UI wording |

Each acceptance record holds:
- user;
- activity (`org_id` when given);
- role;
- document id;
- version;
- locale;
- type: signup / store_connection / existing_user / reacceptance;
- action: accept / acknowledge;
- time;
- `audit_event_id`.

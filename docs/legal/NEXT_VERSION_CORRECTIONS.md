# Corrections for the next legal version (not applied: approved text is never edited by developers)

| Document | Section | Issue | Suggested handling (for counsel) |
|---|---|---|---|
| Commissions, Payments and Reconciliation Policy; Creator Terms; Merchant Terms (he + en) | creator commission | The documents do not say whether the creator commission is before VAT. Owner decision 10.11.2026: it is before VAT, with VAT added by law by the creator's verified classification; withholding as required. The product UI already states this to new parties. | Add the definition in v1.1; decide how existing collaborations are confirmed (currently marked "awaiting decision", no VAT computed). |
| Privacy Policy (he + en) | 5 | "Google Fonts עשוי להיטען ממקור חיצוני" / "Google Fonts may load remotely" is inaccurate: fonts are served locally (`@fontsource/rubik`); no request goes to Google. | Remove the sentence or replace it with an accurate provider list in v1.1. |

Open legal rules the system is waiting for (not invented in code):
- **Wind-down notice period** (`wind_down_notice_days`): how much advance notice before ending existing collaborations after a store refuses a rate increase. Planning a wind-down is refused until counsel sets it.
- **Automatic-charge authorisation wording** for the store's saved card (currently shown with "pending legal review").

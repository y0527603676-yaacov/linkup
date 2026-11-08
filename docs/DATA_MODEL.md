# LINKUP — מודל נתונים

הקוד המלא: `apps/web/src/db/schema.ts`. כאן העקרונות והטבלאות.

## כללים
- מפתחות ראשיים `uuid`. כל טבלה עסקית עם `organization_id` (בידוד דיירים).
- כסף: `bigint` ביחידות קטנות + `currency char(3)`. אחוזים: `basis points` (300 = 3%).
- `created_at` בכל טבלה; `deleted_at` רק בטבלאות לא-כספיות.
- טבלאות כספיות (`commission_ledger`, `order_events`, `agreement_versions`, `payment_evidence`) — **ללא UPDATE/DELETE** (נאכף גם בהרשאות DB).

## טבלאות לפי דומיין

**זהות וארגונים**
- `users` — id, email (unique), phone, locale
- `organizations` — id, type (`store`|`creator`|`agency`|`platform`), name, slug (unique)
- `memberships` — user_id, organization_id, role (`owner`|`admin`|`member`) — unique(user, org)
- `creator_profiles` — organization_id (unique), handle, social links
- `agency_representations` — agency_org_id, creator_org_id, status (`pending`|`active`|`revoked`), default_split_bps, approved_at

**חיבור חנות**
- `store_connections` — organization_id, platform (`woocommerce`), site_url, status, webhook_secret_ref, last_heartbeat_at, last_reconciled_at

**הצעות והסכמים**
- `campaigns` — store_org_id, name, starts_at, ends_at
- `proposals` — id, from_org_id, to_org_id (nullable — מוזמן שעדיין לא רשום), invitee_contact, public_token (unique), terms (jsonb), status (`sent`|`opened`|`accepted`|`rejected`|`expired`), referral_id, source_proposal_id (שכפול)
- `agreements` — store_org_id, creator_org_id, campaign_id, status, current_version_id
- `agreement_versions` — agreement_id, version, commission_bps, attribution_window_days, commission_base (`net_excl_tax_shipping`), effective_from, accepted_by_store_at, accepted_by_creator_at — unique(agreement, version)
- `agency_splits` — agency_org_id, creator_org_id, campaign_id (nullable), split_bps, effective_from, approved_by_creator_at

**מעקב**
- `tracking_links` — agreement_id, code (unique), destination_url
- `clicks` — tracking_link_id, visitor_id_hash, clicked_at
- `coupons` — agreement_id, store_connection_id, code, external_id — unique(store_connection_id, lower(code))

**הזמנות**
- `orders` — store_connection_id, external_order_id, currency, status, net_amount_minor — unique(store_connection_id, external_order_id)
- `order_events` — store_connection_id, external_order_id, event_type, event_id (unique עם connection), occurred_at, payload, processed_at
- `refunds` — order_id, external_refund_id (unique), amount_minor
- `attributions` — order_id (unique per program), agreement_version_id, method (`coupon`|`click`), evidence (jsonb)

**כסף**
- `commission_ledger` — id, attribution_id, party_org_id, party_role (`creator`|`agency`|`platform`), entry_type (`accrual`|`reversal`|`adjustment`), amount_minor (חיובי/שלילי), currency, state (`pending`|`approved`), reverses_entry_id, idempotency_key (unique), created_at
- `settlements` / `settlement_items` — תקופה, חנות, משפיען, סכום מתוך ה-ledger
- `payment_evidence` — settlement_id, reported_by, method, reference, verification (`self_reported`|`verified`)
- `platform_invoices` / `platform_payments` — חיוב עמלת LINKUP לחנות

**צמיחה ומערכת**
- `referrals` — referrer_org_id, referred_org_id, source (`proposal`|`partner_page`|`import`), proposal_id
- `referral_rewards` — referral_id, platform_payment_id, amount_minor (רק מכסף שנגבה בפועל)
- `funnel_events` — event (`invite_sent`|`invite_opened`|...), proposal_id, org_id
- `notifications`, `audit_events` (actor, action, target, before/after)

## מעברי סטטוס
- Proposal: `sent → opened → accepted|rejected|expired`
- Ledger state: `pending → approved` (אחרי חלון החזרות). ביטול = רשומת `reversal`, לא שינוי.

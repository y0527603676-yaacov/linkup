import { sql } from "drizzle-orm";
import {
  bigint, boolean, char, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

/* See docs/DATA_MODEL.md. Money = bigint minor units; rates = basis points. */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "number" }).notNull();

export const orgType = pgEnum("org_type", ["store", "creator", "agency", "platform"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const proposalStatus = pgEnum("proposal_status", ["sent", "opened", "accepted", "rejected", "expired"]);
export const agreementStatus = pgEnum("agreement_status", ["active", "paused", "ended"]);
export const representationStatus = pgEnum("representation_status", ["pending", "active", "revoked"]);
export const connectionStatus = pgEnum("connection_status", ["pending", "connected", "unhealthy", "disconnected"]);
export const attributionMethod = pgEnum("attribution_method", ["coupon", "click"]);
export const partyRole = pgEnum("party_role", ["creator", "agency", "platform"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", ["accrual", "reversal", "adjustment"]);
export const ledgerState = pgEnum("ledger_state", ["pending", "approved"]);
export const verification = pgEnum("payment_verification", ["self_reported", "confirmed_by_recipient", "verified"]);
export const referralSource = pgEnum("referral_source", ["proposal", "partner_page", "import", "agency"]);

/* ---------- Identity & orgs ---------- */
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull(),
  phone: text("phone"),
  locale: text("locale").notNull().default("he"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const organizations = pgTable("organizations", {
  id: id(),
  type: orgType("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  defaultCommissionBps: integer("default_commission_bps"),
  platformFeeBps: integer("platform_fee_bps"),
  foundersRateUntil: timestamp("founders_rate_until", { withTimezone: true }),
  referredById: uuid("referred_by_referral_id"),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const memberships = pgTable("memberships", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  role: memberRole("role").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("memberships_user_org_uq").on(t.userId, t.organizationId)]);

export const creatorProfiles = pgTable("creator_profiles", {
  id: id(),
  organizationId: uuid("organization_id").notNull().unique().references(() => organizations.id),
  handle: text("handle"),
  socialLinks: jsonb("social_links").$type<Record<string, string>>().notNull().default({}),
  emailHash: text("email_hash"),
  createdAt: createdAt(),
});

export const agencyRepresentations = pgTable("agency_representations", {
  id: id(),
  agencyOrgId: uuid("agency_org_id").notNull().references(() => organizations.id),
  creatorOrgId: uuid("creator_org_id").notNull().references(() => organizations.id),
  status: representationStatus("status").notNull().default("pending"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("agency_rep_uq").on(t.agencyOrgId, t.creatorOrgId)]);

export const agencySplits = pgTable("agency_splits", {
  id: id(),
  agencyOrgId: uuid("agency_org_id").notNull().references(() => organizations.id),
  creatorOrgId: uuid("creator_org_id").references(() => organizations.id), // null = agency default
  campaignId: uuid("campaign_id"),
  splitBps: integer("split_bps").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  approvedByCreatorAt: timestamp("approved_by_creator_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/* ---------- Store integration ---------- */
export const storeConnections = pgTable("store_connections", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  platform: text("platform").notNull().default("woocommerce"),
  siteUrl: text("site_url").notNull(),
  status: connectionStatus("status").notNull().default("pending"),
  webhookSecretRef: text("webhook_secret_ref").notNull(), // reference to secret store, never plaintext in logs
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("store_conn_site_uq").on(t.organizationId, t.siteUrl)]);

/* ---------- Proposals & agreements ---------- */
export const campaigns = pgTable("campaigns", {
  id: id(),
  storeOrgId: uuid("store_org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const proposals = pgTable("proposals", {
  id: id(),
  fromOrgId: uuid("from_org_id").notNull().references(() => organizations.id),
  toOrgId: uuid("to_org_id").references(() => organizations.id),
  inviteeContact: text("invitee_contact"),
  publicToken: text("public_token").notNull().unique(),
  terms: jsonb("terms").$type<{ commissionBps: number; attributionWindowDays: number; campaignId?: string }>().notNull(),
  status: proposalStatus("status").notNull().default("sent"),
  sourceProposalId: uuid("source_proposal_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const agreements = pgTable("agreements", {
  id: id(),
  storeOrgId: uuid("store_org_id").notNull().references(() => organizations.id),
  creatorOrgId: uuid("creator_org_id").notNull().references(() => organizations.id),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  proposalId: uuid("proposal_id").references(() => proposals.id),
  status: agreementStatus("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const agreementVersions = pgTable("agreement_versions", {
  id: id(),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id),
  version: integer("version").notNull(),
  commissionBps: integer("commission_bps").notNull(),
  platformFeeBps: integer("platform_fee_bps").notNull(),
  attributionWindowDays: integer("attribution_window_days").notNull().default(30),
  commissionBase: text("commission_base").notNull().default("net_excl_tax_shipping"),
  refundHoldDays: integer("refund_hold_days").notNull().default(14),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  acceptedByStoreAt: timestamp("accepted_by_store_at", { withTimezone: true }),
  acceptedByCreatorAt: timestamp("accepted_by_creator_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("agreement_version_uq").on(t.agreementId, t.version)]);

/* ---------- Tracking ---------- */
export const trackingLinks = pgTable("tracking_links", {
  id: id(),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id),
  code: text("code").notNull().unique(),
  destinationUrl: text("destination_url").notNull(),
  createdAt: createdAt(),
});

export const clicks = pgTable("clicks", {
  id: id(),
  trackingLinkId: uuid("tracking_link_id").notNull().references(() => trackingLinks.id),
  visitorIdHash: text("visitor_id_hash").notNull(),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clicks_visitor_idx").on(t.visitorIdHash, t.clickedAt)]);

export const coupons = pgTable("coupons", {
  id: id(),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id),
  storeConnectionId: uuid("store_connection_id").notNull().references(() => storeConnections.id),
  code: text("code").notNull(),
  externalId: text("external_id"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("coupon_code_uq").on(t.storeConnectionId, sql`lower(${t.code})`)]);

/* ---------- Orders (inbox pattern) ---------- */
export const orderEvents = pgTable("order_events", {
  id: id(),
  storeConnectionId: uuid("store_connection_id").notNull().references(() => storeConnections.id),
  eventId: text("event_id").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("order_event_uq").on(t.storeConnectionId, t.eventId)]);

export const orders = pgTable("orders", {
  id: id(),
  storeConnectionId: uuid("store_connection_id").notNull().references(() => storeConnections.id),
  externalOrderId: text("external_order_id").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  status: text("status").notNull(),
  totalMinor: money("total_minor"),
  commissionBaseMinor: money("commission_base_minor"),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("orders_ext_uq").on(t.storeConnectionId, t.externalOrderId)]);

export const refunds = pgTable("refunds", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  externalRefundId: text("external_refund_id").notNull(),
  amountMinor: money("amount_minor"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("refund_ext_uq").on(t.orderId, t.externalRefundId)]);

export const attributions = pgTable("attributions", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  agreementVersionId: uuid("agreement_version_id").notNull().references(() => agreementVersions.id),
  method: attributionMethod("method").notNull(),
  evidence: jsonb("evidence").notNull(),
  selfReferralSuspected: boolean("self_referral_suspected").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("attribution_order_uq").on(t.orderId)]);

/* ---------- Money (append-only) ---------- */
export const commissionLedger = pgTable("commission_ledger", {
  id: id(),
  attributionId: uuid("attribution_id").notNull().references(() => attributions.id),
  partyOrgId: uuid("party_org_id").notNull().references(() => organizations.id),
  partyRole: partyRole("party_role").notNull(),
  entryType: ledgerEntryType("entry_type").notNull(),
  amountMinor: money("amount_minor"),
  currency: char("currency", { length: 3 }).notNull(),
  state: ledgerState("state").notNull().default("pending"),
  approvableAt: timestamp("approvable_at", { withTimezone: true }),
  reversesEntryId: uuid("reverses_entry_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: createdAt(),
}, (t) => [index("ledger_party_idx").on(t.partyOrgId, t.createdAt)]);

export const settlements = pgTable("settlements", {
  id: id(),
  storeOrgId: uuid("store_org_id").notNull().references(() => organizations.id),
  payeeOrgId: uuid("payee_org_id").notNull().references(() => organizations.id),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  amountMinor: money("amount_minor"),
  currency: char("currency", { length: 3 }).notNull(),
  createdAt: createdAt(),
});

export const settlementItems = pgTable("settlement_items", {
  id: id(),
  settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
  ledgerEntryId: uuid("ledger_entry_id").notNull().unique().references(() => commissionLedger.id),
});

export const paymentEvidence = pgTable("payment_evidence", {
  id: id(),
  settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
  reportedByUserId: uuid("reported_by_user_id").notNull().references(() => users.id),
  method: text("method").notNull(),
  reference: text("reference"),
  verification: verification("verification").notNull().default("self_reported"),
  createdAt: createdAt(),
});

export const platformInvoices = pgTable("platform_invoices", {
  id: id(),
  storeOrgId: uuid("store_org_id").notNull().references(() => organizations.id),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  amountMinor: money("amount_minor"),
  currency: char("currency", { length: 3 }).notNull(),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("invoice_period_uq").on(t.storeOrgId, t.periodStart, t.currency)]);

export const platformPayments = pgTable("platform_payments", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => platformInvoices.id),
  amountMinor: money("amount_minor"),
  provider: text("provider").notNull(),
  providerReference: text("provider_reference").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("payment_provider_ref_uq").on(t.provider, t.providerReference)]);

/* ---------- Growth ---------- */
export const referrals = pgTable("referrals", {
  id: id(),
  referrerOrgId: uuid("referrer_org_id").notNull().references(() => organizations.id),
  referredOrgId: uuid("referred_org_id").notNull().unique().references(() => organizations.id),
  source: referralSource("source").notNull(),
  proposalId: uuid("proposal_id").references(() => proposals.id),
  rewardBps: integer("reward_bps").notNull().default(1000),
  rewardUntil: timestamp("reward_until", { withTimezone: true }),
  createdAt: createdAt(),
});

export const referralRewards = pgTable("referral_rewards", {
  id: id(),
  referralId: uuid("referral_id").notNull().references(() => referrals.id),
  platformPaymentId: uuid("platform_payment_id").notNull().references(() => platformPayments.id),
  amountMinor: money("amount_minor"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("reward_payment_uq").on(t.referralId, t.platformPaymentId)]);

export const funnelEvents = pgTable("funnel_events", {
  id: id(),
  event: text("event").notNull(),
  proposalId: uuid("proposal_id").references(() => proposals.id),
  organizationId: uuid("organization_id").references(() => organizations.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- System ---------- */
export const notifications = pgTable("notifications", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  data: jsonb("data").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const auditEvents = pgTable("audit_events", {
  id: id(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  organizationId: uuid("organization_id").references(() => organizations.id),
  action: text("action").notNull(),
  target: text("target").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: createdAt(),
});

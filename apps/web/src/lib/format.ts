import type { Dict } from "@/i18n/he";

type Loc = "he" | "en";
const tag = (l: Loc) => (l === "he" ? "he-IL" : "en-IL");

export function money(minor: number | string | null | undefined, currency = "ILS", locale: Loc = "he"): string {
  return new Intl.NumberFormat(tag(locale), { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(minor ?? 0) / 100);
}
export const pct = (bps: number, locale: Loc = "he") =>
  `${(bps / 100).toLocaleString(tag(locale), { maximumFractionDigits: 2 })}%`;
export const date = (iso: string | null | undefined, locale: Loc = "he") =>
  iso ? new Date(iso).toLocaleDateString(tag(locale), { day: "numeric", month: "short", year: "numeric" }) : "—";
export const shortDate = (iso: string | null | undefined, locale: Loc = "he") =>
  iso ? new Date(iso).toLocaleDateString(tag(locale), { day: "numeric", month: "short" }) : "—";

const KNOWN = new Set(["https_required", "not_available", "test_isolation", "email_in_use", "too_many", "not_found", 
  "forbidden", "not_authenticated", "invalid_url", "invalid_name", "invalid_type", "proposal_closed", "proposal_expired",
  "wrong_org_type", "rate_limited", "not_found", "too_many_orgs", "unsupported_org_type", "not_a_store", "not_a_creator",
  "bad_code", "email", "send_failed", "invalid_email", "invalid_role", "last_owner", "invite_invalid", "invite_email_mismatch",
  "opportunity_closed", "self_deal", "already_decided", "invalid_dates", "too_many_campaigns", "store_not_connected",
  "nothing_to_pay", "creator_tax_undetermined", "vat_mismatch", "reason_required", "already_responded", "invalid_status", "below_minimum", "invoice_not_payable", "invoice_not_voidable", "store_rate_not_accepted", "invoice_not_disputable", "dispute_open", "invalid_amount", "too_many", "invalid_input", "not_withdrawable", "not_disputed", "charge_in_progress", "charge_outcome_unknown", "no_payment_method", "notice_not_delivered", "wind_down_rule_undecided", "wind_down_not_allowed", "wind_down_not_due", "accounting_decision_pending",
  "period_not_closed", "invalid_period", "setting_locked", "join_standing_first", "invalid_setting", "signups_closed", "legal_acceptance_required", "invoicing_not_approved", "invoice_not_deliverable", "notice_too_short", "note_required", "invalid_method", "tax_profile_required", "document_required", "zero_rate_not_allowed", "invoice_not_voidable",
]);

export function errorText(code: string | undefined | null, t: Dict): string | null {
  if (!code) return null;
  return t.errors[code] ?? t.errors.unknown!;
}

/** Map a Supabase/PostgREST error to our short code. */
export function errorCode(err: { message?: string } | null | undefined): string {
  const m = err?.message ?? "";
  return KNOWN.has(m) ? m : "unknown";
}

/** Only allow same-site relative redirects. */
export function safeNext(next: unknown, fallback = "/app"): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : fallback;
}

export const waLink = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

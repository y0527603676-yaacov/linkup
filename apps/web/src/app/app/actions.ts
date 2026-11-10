"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getOrigin, getSupabase } from "@/lib/supabase/server";
import { errorCode, safeNext } from "@/lib/format";
import { getLocale } from "@/i18n";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const pctToBps = (v: string, fallback: number) => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && v !== "" ? Math.round(n * 100) : fallback;
};
const back = (path: string, org: string, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ org, ...extra });
  return `${path}?${p.toString()}`;
};

/* ---------- Activities ---------- */
export async function createOrg(form: FormData) {
  const type = str(form, "type");
  const next = str(form, "next");
  const sb = await getSupabase();
  const ref = (await cookies()).get("lk_ref")?.value ?? null;
  const legal = form.getAll("legal").map(String).filter(Boolean);
  if (legal.length) {
    if (str(form, "agree") !== "1") redirect(`/app/new?error=legal_acceptance_required&type=${encodeURIComponent(type)}&next=${encodeURIComponent(next)}`);
    const { error: le } = await sb.rpc("accept_legal", { p_doc_keys: legal, p_type: "signup", p_org: null, p_locale: await getLocale() });
    if (le) redirect(`/app/new?error=${errorCode(le)}&type=${encodeURIComponent(type)}&next=${encodeURIComponent(next)}`);
  }
  const { data, error } = await sb.rpc("create_organization", {
    p_type: type, p_name: str(form, "name"), p_website_url: str(form, "website") || null,
    p_ref_code: ref, p_locale: await getLocale(),
  });
  if (error) redirect(`/app/new?error=${errorCode(error)}&type=${encodeURIComponent(type)}&next=${encodeURIComponent(next)}`);
  if (ref) (await cookies()).delete("lk_ref");
  if (next) redirect(safeNext(next));
  redirect(type === "store" ? `/app/connect?org=${data}` : `/app/catalog?org=${data}&welcome=1`);
}

export async function updateOrg(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("update_organization", {
    p_org: org, p_name: str(form, "name"), p_website_url: str(form, "website") || null,
    p_description: str(form, "description") || null, p_logo_url: str(form, "logo") || null, p_locale: str(form, "locale") || null,
  });
  redirect(back("/app/settings", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* ---------- Store connection ---------- */
export type ConnectState = { error?: string; key?: string; site?: string };
export async function connectStore(_prev: ConnectState, form: FormData): Promise<ConnectState> {
  const sb = await getSupabase();
  const legal = form.getAll("legal").map(String).filter(Boolean);
  if (legal.length) {
    if (str(form, "agree") !== "1") return { error: "legal_acceptance_required" };
    const { error: le } = await sb.rpc("accept_legal", { p_doc_keys: legal, p_type: "store_connection", p_org: str(form, "org"), p_locale: await getLocale() });
    if (le) return { error: errorCode(le) };
  }
  const { data, error } = await sb.rpc("create_store_connection", { p_org: str(form, "org"), p_site_url: str(form, "site") });
  if (error) return { error: errorCode(error) };
  const r = data as { connection_key: string; site_url: string };
  return { key: r.connection_key, site: r.site_url };
}

/* ---------- Store connection without a plugin (WooCommerce approves inside the store) ---------- */
export async function startWooApi(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const legal = form.getAll("legal").map(String).filter(Boolean);
  if (legal.length) {
    if (str(form, "agree") !== "1") redirect(back("/app/connect", org, { error: "legal_acceptance_required" }));
    const { error: le } = await sb.rpc("accept_legal", { p_doc_keys: legal, p_type: "store_connection", p_org: org, p_locale: await getLocale() });
    if (le) redirect(back("/app/connect", org, { error: errorCode(le) }));
  }
  const { data, error } = await sb.rpc("start_woo_api_connect", { p_org: org, p_site_url: str(form, "site") });
  if (error) redirect(back("/app/connect", org, { error: errorCode(error) }));
  const r = data as { state: string; site_url: string; callback_url: string };
  const u = new URL(`${r.site_url.replace(/\/+$/, "")}/wc-auth/v1/authorize`);
  u.searchParams.set("app_name", "LINKUP");
  u.searchParams.set("scope", "read_write");
  u.searchParams.set("user_id", r.state);
  u.searchParams.set("return_url", `${await getOrigin()}/app/connect/return?org=${org}&state=${r.state}`);
  u.searchParams.set("callback_url", r.callback_url);
  redirect(u.toString());
}

export async function syncWooApi(form: FormData) {
  const org = str(form, "org");
  const { error } = await (await getSupabase()).rpc("request_woo_api_sync", { p_org: org });
  redirect(back("/app/connect", org, error ? { error: errorCode(error) } : { ok: "sync" }));
}

/* ---------- Connect with one approval (WordPress installs the LINKUP Connector) ---------- */
export async function startWpConnect(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { getT } = await import("@/i18n");
  const { t } = await getT();
  const w = t.connect.wp;
  const legal = form.getAll("legal").map(String).filter(Boolean);
  if (legal.length) {
    if (str(form, "agree") !== "1") redirect(back("/app/connect", org, { error: "legal_acceptance_required" }));
    const { error: le } = await sb.rpc("accept_legal", { p_doc_keys: legal, p_type: "store_connection", p_org: org, p_locale: await getLocale() });
    if (le) redirect(back("/app/connect", org, { error: errorCode(le) }));
  }
  const items = form.getAll("consent").map(String).filter((k) => k in w.items);
  const mode = str(form, "mode") === "require" ? "require" : "notice";
  // The exact wording the owner saw and ticked is what gets recorded.
  const text = [`${w.consentTitle}:`, ...items.map((k, i) => `${i + 1}. ${w.items[k]}`),
    `${w.modeTitle} ${mode === "require" ? w.modeRequire : w.modeNotice}`].join("\n");
  const ua = (await (await import("next/headers")).headers()).get("user-agent");
  const { data, error } = await sb.rpc("start_wp_connect", { p_org: org, p_site_url: str(form, "site"), p_items: items, p_consent_text: text, p_user_agent: ua });
  if (error) redirect(back("/app/connect", org, { error: errorCode(error) }));
  const r = data as { state: string; site_url: string };
  const { wpAuthorizeUrl } = await import("@/lib/wp-connect");
  const ret = `${await getOrigin()}/app/connect/wp-return?org=${org}&state=${r.state}&mode=${mode}`;
  redirect(wpAuthorizeUrl(r.site_url, WP_APP_ID, ret, `${ret}&rejected=1`));
}

/** Fixed id that identifies LINKUP's application passwords in WordPress (shown to the owner as "LINKUP setup …"). */
const WP_APP_ID = "6f1c0d5e-3b7a-4c2e-9a41-0b9d2c7e5f11";

export async function disconnectStore(form: FormData) {
  const org = str(form, "org");
  const { error } = await (await getSupabase()).rpc("disconnect_store", { p_org: org });
  revalidatePath("/app/connect");
  redirect(back("/app/connect", org, error ? { error: errorCode(error) } : { ok: "disconnected" }));
}

/* ---------- Direct invites (proposals) ---------- */
export async function createInvite(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("create_proposal", {
    p_from_org: org,
    p_commission_bps: pctToBps(str(form, "commission"), 1000),
    p_invitee_name: str(form, "name") || null,
    p_invitee_contact: str(form, "contact") || null,
    p_coupon_discount_pct: form.has("discount") && str(form, "discount") !== "" ? Math.round(Number(str(form, "discount")) || 0) : null,
    p_attribution_days: null,
    p_target_site_url: str(form, "site") || null,
    p_source_proposal: str(form, "source") || null,
  });
  if (error) redirect(back("/app/invite", org, { error: errorCode(error) }));
  const r = data as { token: string };
  redirect(back("/app/invite/sent", org, { token: r.token, name: str(form, "name") }));
}

export async function acceptOffer(form: FormData) {
  const token = str(form, "token");
  let org = str(form, "org");
  const sb = await getSupabase();
  if (!org) {
    const legal = form.getAll("legal").map(String).filter(Boolean);
    if (legal.length) {
      if (str(form, "agree") !== "1") redirect(`/o/${token}?error=legal_acceptance_required`);
      const { error: le } = await sb.rpc("accept_legal", { p_doc_keys: legal, p_type: "signup", p_org: null, p_locale: await getLocale() });
      if (le) redirect(`/o/${token}?error=${errorCode(le)}`);
    }
    const { data, error } = await sb.rpc("create_organization", {
      p_type: str(form, "type"), p_name: str(form, "name"), p_website_url: str(form, "website") || null,
      p_ref_code: null, p_locale: await getLocale(),
    });
    if (error) redirect(`/o/${token}?error=${errorCode(error)}`);
    org = data as string;
  }
  const { error } = await sb.rpc("accept_proposal", { p_token: token, p_org: org });
  if (error) redirect(`/o/${token}?error=${errorCode(error)}`);
  redirect(`/app?org=${org}&accepted=1`);
}

/* ---------- Offer & LINKUP LAUNCH ---------- */
export async function saveOffer(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("save_standing_opportunity", {
    p_store: org, p_title: str(form, "title"), p_description: str(form, "description") || null,
    p_commission_bps: pctToBps(str(form, "commission"), 1000), p_coupon_pct: Math.round(Number(str(form, "discount")) || 0),
    p_auto_approve: form.get("auto") === "on", p_status: str(form, "status") === "paused" ? "paused" : "live",
    p_product_ids: form.getAll("products").map(String).filter(Boolean),
  });
  redirect(back("/app/offer", org, error ? { error: errorCode(error) } : { ok: "offer" }));
}

export async function createCampaign(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const tz = Number(str(form, "tz")) || 0; // browser offset in minutes, so dates mean local midnight
  const toIso = (d: string, endOfDay: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const base = Date.parse(`${d}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) + tz * 60_000;
    return new Date(Math.max(base, endOfDay ? 0 : Date.now() - 60_000)).toISOString();
  };
  const { error } = await sb.rpc("create_campaign", {
    p_store: org, p_title: str(form, "title"), p_description: str(form, "description") || null,
    p_commission_bps: pctToBps(str(form, "commission"), 1500),
    p_starts_at: toIso(str(form, "starts"), false), p_ends_at: toIso(str(form, "ends"), true),
    p_product_ids: form.getAll("products").map(String).filter(Boolean),
  });
  redirect(back("/app/offer", org, error ? { error: errorCode(error) } : { ok: "campaign" }));
}

export async function setOpportunityStatus(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("set_opportunity_status", { p_opportunity: str(form, "id"), p_status: str(form, "status") });
  redirect(back("/app/offer", org, error ? { error: errorCode(error) } : {}));
}

/* ---------- Catalogue ---------- */
export async function joinOpportunity(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("join_opportunity", { p_opportunity: str(form, "id"), p_creator: org, p_message: str(form, "message") || null });
  if (error) redirect(back("/app/catalog", org, { error: errorCode(error) }));
  const r = data as { status: string };
  redirect(r.status === "approved" ? back("/app/partnerships", org, { joined: "1" }) : back("/app/catalog", org, { ok: "pending" }));
}

export async function decideApplication(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("decide_application", { p_application: str(form, "id"), p_approve: str(form, "approve") === "1" });
  redirect(back("/app/partners", org, error ? { error: errorCode(error) } : {}));
}

/* ---------- Payments ---------- */
export async function respondPayout(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("respond_creator_payout", { p_payout: str(form, "id"), p_confirm: str(form, "confirm") === "1", p_reason: str(form, "reason") || null });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

export async function answerDispute(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("answer_payout_dispute", { p_payout: str(form, "id"), p_response: str(form, "response") });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

export async function withdrawPayout(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("withdraw_creator_payout", { p_payout: str(form, "id"), p_note: str(form, "note") });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* Store reports a payment it made to a creator (LINKUP moves no money). Idempotent per form render. */
export async function reportPayment(form: FormData) {
  const org = str(form, "org");
  const creator = str(form, "creator");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("report_creator_payment", {
    p_store: org, p_creator: creator, p_amount_minor: pctToBps(str(form, "amount"), -1), p_vat_minor: null,   // VAT: set by the server from the verified basis only
    p_method: str(form, "method") || "bank_transfer", p_paid_on: str(form, "paid_on") || null, p_reference: str(form, "reference") || null,
    p_idempotency_key: str(form, "key") || null, p_currency: "ILS",
    p_withholding_minor: pctToBps(str(form, "withholding") || "0", -1), p_withholding_ref: str(form, "withholding_ref") || null,
  });
  if (error) redirect(back("/app/money/pay", org, { creator, error: errorCode(error) }));
  const file = form.get("proof");
  if (file instanceof File && file.size > 0) {
    if (file.size > 2 * 1024 * 1024) redirect(back("/app/money", org, { error: "invalid_input" }));
    const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const { error: pe } = await sb.rpc("attach_payout_proof", { p_payout: (data as { payout_id: string }).payout_id, p_filename: file.name, p_mime: file.type, p_base64: b64 });
    if (pe) redirect(back("/app/money", org, { error: errorCode(pe) }));
  }
  redirect(back("/app/money", org, { ok: "reported" }));
}

export async function savePayoutDetails(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("save_payout_details", { p_org: org, p_method: str(form, "method"), p_holder: str(form, "holder") || null,
    p_bank: str(form, "bank") || null, p_branch: str(form, "branch") || null, p_account: str(form, "account") || null,
    p_phone: str(form, "phone") || null, p_link: str(form, "link") || null, p_note: null });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* ---------- LINKUP fee: payment method (simulated provider in development only) ---------- */
export async function saveSimulatedMethod(form: FormData) {
  const org = str(form, "org");
  if (process.env.BILLING_SIMULATION !== "true") redirect(back("/app/money", org, { error: "forbidden" }));
  const sb = await getSupabase();
  const card = str(form, "card");
  const token = `${card === "flaky" ? "sim_flaky" : card === "decline" ? "sim_decline" : "sim_ok"}_${crypto.randomUUID().slice(0, 8)}`;
  const timing = str(form, "timing") === "on_due_date" ? "on_due_date" : "days_after_delivery";
  const { error } = await sb.rpc("save_payment_method", { p_store: org, p_provider: "simulated", p_token_ref: token, p_brand: "visa",
    p_last4: card === "decline" ? "0002" : card === "flaky" ? "0341" : "4242", p_exp_month: 12, p_exp_year: 2030,
    p_charge_timing: timing, p_charge_days: timing === "on_due_date" ? null : Math.max(0, Math.min(14, Number(str(form, "days")) || 0)),
    p_authorization_version: str(form, "agree") === "1" ? "billing-auth-draft-1" : "" });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

export async function removePaymentMethod(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("remove_payment_method", { p_store: org });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* ---------- Team ---------- */
export async function inviteTeam(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("invite_team_member", { p_org: org, p_email: str(form, "email"), p_role: str(form, "role") });
  redirect(back("/app/team", org, error ? { error: errorCode(error) } : { token: (data as { token: string }).token }));
}

export async function teamAction(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const op = str(form, "op");
  const { error } =
    op === "revoke" ? await sb.rpc("revoke_team_invite", { p_invite: str(form, "id") })
    : op === "remove" ? await sb.rpc("remove_member", { p_org: org, p_user: str(form, "user") })
    : await sb.rpc("set_member_role", { p_org: org, p_user: str(form, "user"), p_role: str(form, "role") });
  redirect(back("/app/team", org, error ? { error: errorCode(error) } : {}));
}

export async function acceptTeamInvite(form: FormData) {
  const token = str(form, "token");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("accept_team_invite", { p_token: token });
  if (error) redirect(`/team/${token}?error=${errorCode(error)}`);
  redirect(`/app?org=${data}`);
}

/* ---------- Notifications & tracking ---------- */
export async function markRead(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  await sb.rpc("mark_notifications_read", { p_org: org });
  revalidatePath("/app", "layout");
  redirect(back("/app/notifications", org));
}

export async function trackShare(org: string, event: "creative_shared" | "referral_link_shared") {
  const sb = await getSupabase();
  await sb.rpc("track_event", { p_org: org, p_event: event });
}

/* ---------- Platform admin ---------- */
export async function adminAction(form: FormData) {
  const org = str(form, "org");
  const op = str(form, "op");
  const sb = await getSupabase();
  const { error } =
    op === "generate" ? await sb.rpc("generate_invoices", { p_period_start: str(form, "period") })
    : op === "paid" ? await sb.rpc("mark_invoice_paid", { p_invoice: str(form, "id"), p_reference: str(form, "reference") || null })
    : op === "void" ? await sb.rpc("void_invoice", { p_invoice: str(form, "id") })
    : op === "delivered" ? await sb.rpc("mark_invoice_delivered", { p_invoice: str(form, "id"), p_method: str(form, "method"), p_reference: str(form, "reference") || null, p_delivered_at: str(form, "at") ? new Date(str(form, "at")).toISOString() : null })
    : op === "rate" ? await sb.rpc("schedule_standard_rate_change", { p_new_bps: pctToBps(str(form, "pct"), -1), p_effective_from: new Date(str(form, "from")).toISOString(), p_note: str(form, "note") || null })
    : op === "individual" ? await sb.rpc("set_individual_fee", { p_store: str(form, "store"), p_fee_bps: pctToBps(str(form, "pct"), -1), p_effective_from: new Date(str(form, "from")).toISOString(), p_effective_until: str(form, "until") ? new Date(str(form, "until")).toISOString() : null, p_note: str(form, "note") })
    : op === "transfer" ? await sb.rpc("record_reward_transfer", { p_org: str(form, "target"), p_currency: "ILS", p_reference: str(form, "reference") || null,
        p_doc_type: str(form, "doc_type"), p_doc_number: str(form, "doc_number"), p_doc_date: str(form, "doc_date") || null,
        p_withholding_minor: pctToBps(str(form, "withholding") || "0", 0) })
    : op === "resolve" ? await sb.rpc("resolve_invoice_dispute", { p_dispute: str(form, "id"), p_resolution: str(form, "resolution") })
    : op === "contact" ? await sb.rpc("mark_contact_handled", { p_id: str(form, "id") })
    : op === "vatbasis" ? await sb.rpc("set_commission_vat_basis", { p_agreement: str(form, "id"), p_note: str(form, "note") })
    : op === "retry" ? await sb.rpc("retry_charge_now", { p_invoice: str(form, "id") })
    : op === "resolve_paid" || op === "resolve_failed" ? await sb.rpc("admin_resolve_charge", { p_charge: str(form, "id"),
        p_outcome: op === "resolve_paid" ? "succeeded" : "failed", p_provider_ref: str(form, "ref") || null, p_note: str(form, "note") })
    : op === "alert" ? await sb.rpc("handle_billing_alert", { p_alert: str(form, "id"), p_note: str(form, "note") })
    : op === "refund" ? await sb.rpc("request_refund", { p_charge: str(form, "id"), p_amount_minor: pctToBps(str(form, "amount"), -1), p_reason: str(form, "reason") })
    : op === "notice" ? await sb.rpc("record_fee_notice", { p_term: str(form, "term"), p_event: str(form, "event"), p_channel: str(form, "channel"),
        p_recipient: str(form, "recipient") || null, p_reference: str(form, "reference") || null, p_occurred_at: str(form, "at") ? new Date(str(form, "at")).toISOString() : null })
    : op === "wd_plan" ? await sb.rpc("plan_collaboration_wind_down", { p_term: str(form, "term"), p_end_at: new Date(str(form, "end")).toISOString(), p_note: str(form, "note") })
    : op === "wd_complete" ? await sb.rpc("complete_collaboration_wind_down", { p_plan: str(form, "id") })
    : op === "wd_cancel" ? await sb.rpc("cancel_collaboration_wind_down", { p_plan: str(form, "id") })
    : op === "doc" ? await sb.rpc("record_accounting_document", { p_issuer: str(form, "issuer"), p_doc_type: str(form, "doc_type"), p_number: str(form, "number"),
        p_issued_on: str(form, "date"), p_invoice: str(form, "invoice") || null, p_reward_payout: null,
        p_amount_minor: pctToBps(str(form, "amount"), -1), p_vat_minor: pctToBps(str(form, "vat") || "0", 0), p_software: null, p_note: null })
    : op === "test_add" ? await sb.rpc("admin_add_test_signup", { p_email: str(form, "email"), p_note: str(form, "note") || null })
    : op === "test_remove" ? await sb.rpc("admin_remove_test_signup", { p_email: str(form, "email") })
    : op === "verify" ? await sb.rpc("verify_tax_profile", { p_org: str(form, "target"), p_zero_rate: str(form, "zero") === "1" })
    : await sb.rpc("admin_set_setting", { p_key: str(form, "key"), p_value: str(form, "value") === "true" ? true : str(form, "value") === "false" ? false : Number(str(form, "value")) });
  redirect(back("/app/admin", org, error ? { error: errorCode(error) } : { ok: op }));
}

/* ---------- Fee terms (store admin answers a proposed increase) ---------- */
export async function respondFee(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("respond_fee_change", { p_term: str(form, "term"), p_accept: str(form, "accept") === "1" });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* ---------- Legal: one-time acceptance for existing users / re-acceptance ---------- */
export async function acceptPendingLegal(form: FormData) {
  const sb = await getSupabase();
  const next = safeNext(str(form, "next") || "/app");
  const ctxRaw = str(form, "ctx");
  const back = `/legal/accept?ctx=${encodeURIComponent(ctxRaw)}&next=${encodeURIComponent(next)}`;
  const general = form.getAll("legal").map(String).filter(Boolean);
  const store = form.getAll("legal_store").map(String).filter(Boolean);
  if ((general.length && str(form, "agree") !== "1") || (store.length && str(form, "agree_store") !== "1")) redirect(`${back}&error=legal_acceptance_required`);
  const ctx = (ctxRaw || "signup").split(",").filter((c) => ["signup", "store", "creator"].includes(c));
  const lists = await Promise.all(ctx.map((c) => sb.rpc("legal_pending", { p_context: c })));
  const re = new Set(lists.flatMap((r) => (r.data ?? []) as { doc_key: string; reacceptance: boolean }[]).filter((p) => p.reacceptance).map((p) => p.doc_key));
  const locale = await getLocale();
  const keys = [...general, ...store];
  for (const [list, type] of [[keys.filter((k) => !re.has(k)), "existing_user"], [keys.filter((k) => re.has(k)), "reacceptance"]] as const) {
    if (!list.length) continue;
    const { error } = await sb.rpc("accept_legal", { p_doc_keys: list, p_type: type, p_org: null, p_locale: locale });
    if (error) redirect(`${back}&error=${errorCode(error)}`);
  }
  redirect(next);
}

/* ---------- Payment-request dispute (store admin) ---------- */
export async function disputeInvoice(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("open_invoice_dispute", { p_invoice: str(form, "invoice"), p_disputed_minor: pctToBps(str(form, "amount"), -1),
    p_reason: str(form, "reason"), p_evidence: str(form, "evidence") || null });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

/* ---------- Website contact form ---------- */
export async function sendContact(form: FormData) {
  const sb = await getSupabase();
  const { error } = await sb.rpc("submit_contact_message", { p_name: str(form, "name"), p_email: str(form, "email"),
    p_topic: str(form, "topic"), p_message: str(form, "message") });
  redirect(error ? `/contact?error=${errorCode(error)}` : "/contact?sent=1");
}

/* ---------- Business tax profile (activity admin) ---------- */
export async function saveTaxProfile(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("save_tax_profile", {
    p_org: org, p_legal_name: str(form, "legal_name"), p_classification: str(form, "classification"), p_tax_id: str(form, "tax_id") || null,
    p_address: str(form, "address") || null, p_country: (str(form, "country") || "IL").toUpperCase(), p_no_il_presence: str(form, "no_il") === "1",
    p_evidence: str(form, "evidence") || null, p_payment_method: str(form, "payment_method") || null,
  });
  redirect(back("/app/settings", org, error ? { error: errorCode(error) } : { ok: "1" }));
}

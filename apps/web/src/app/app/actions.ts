"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase/server";
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
export async function recordPayout(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("record_creator_payout", {
    p_store: org, p_creator: str(form, "creator"), p_method: str(form, "method") || "bank_transfer",
    p_reference: str(form, "reference") || null, p_currency: str(form, "currency") || "ILS",
  });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : { ok: "paid" }));
}

export async function respondPayout(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { error } = await sb.rpc("respond_creator_payout", { p_payout: str(form, "id"), p_confirm: str(form, "confirm") === "1" });
  redirect(back("/app/money", org, error ? { error: errorCode(error) } : {}));
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
    : op === "doc" ? await sb.rpc("record_accounting_document", { p_issuer: str(form, "issuer"), p_doc_type: str(form, "doc_type"), p_number: str(form, "number"),
        p_issued_on: str(form, "date"), p_invoice: str(form, "invoice") || null, p_reward_payout: null,
        p_amount_minor: pctToBps(str(form, "amount"), -1), p_vat_minor: pctToBps(str(form, "vat") || "0", 0), p_software: null, p_note: null })
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

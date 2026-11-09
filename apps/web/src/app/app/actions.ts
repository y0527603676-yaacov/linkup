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
    : op === "transfer" ? await sb.rpc("record_reward_transfer", { p_org: str(form, "target"), p_currency: "ILS", p_reference: str(form, "reference") || null })
    : await sb.rpc("admin_set_setting", { p_key: str(form, "key"), p_value: str(form, "value") === "true" ? true : str(form, "value") === "false" ? false : Number(str(form, "value")) });
  redirect(back("/app/admin", org, error ? { error: errorCode(error) } : { ok: op }));
}

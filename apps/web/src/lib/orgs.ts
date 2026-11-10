import "server-only";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSupabase } from "./supabase/server";
import { getT } from "@/i18n";

export type Org = { id: string; type: "store" | "creator" | "agency"; name: string; role: string };

type MemberRow = { user_id: string; role: string; organizations: unknown };
const toOrgs = (rows: MemberRow[] | null, userId: string): Org[] =>
  (rows ?? []).filter((m) => m.user_id === userId).flatMap((m) => {
    const o = m.organizations as { id: string; type: Org["type"]; name: string } | null;
    return o ? [{ id: o.id, type: o.type, name: o.name, role: m.role }] : [];
  });

/** The user's activities. The identity check and the memberships read run in parallel (one round trip instead of two). */
export async function getMyOrgs(): Promise<Org[]> {
  const sb = await getSupabase();
  const [{ data: auth }, { data }] = await Promise.all([
    sb.auth.getUser(),
    sb.from("memberships").select("user_id, role, created_at, organizations(id, type, name)").order("created_at"),
  ]);
  if (!auth.user) return [];
  return toOrgs(data as MemberRow[] | null, auth.user.id);
}

export function pickOrg(orgs: Org[], wanted?: string | string[]): Org | undefined {
  const id = Array.isArray(wanted) ? wanted[0] : wanted;
  return orgs.find((o) => o.id === id) ?? orgs[0];
}

export type OrgStatus = {
  type: string; name: string; referral_code: string; is_admin: boolean; connected: boolean; connection_pending: boolean;
  products: number; standing_live: boolean; live_campaigns: number; partners: number; pending_applications: number;
  proposals_sent: number; sales: number; referrals: number; unread: number; open_invoices: number; payouts_to_confirm: number;
  approved_unpaid_minor: number;
};

/** Every /app page: signed-in user, their activities, the active one (?org=), its status and the dictionary. */
export async function loadApp(sp: Record<string, string | string[] | undefined>, need?: "store" | "creator") {
  const orgs = await getMyOrgs();
  if (!orgs.length) redirect("/app/new");
  // ?org= wins; otherwise the activity opened last (cookie set by the middleware), otherwise the first one.
  const org = pickOrg(orgs, sp.org ?? (await cookies()).get("lk_org")?.value)!;
  if (need && org.type !== need) redirect(`/app?org=${org.id}`);
  const sb = await getSupabase();
  // Status, admin flag and both possible legal contexts in one parallel round trip.
  const typeCtx = org.type === "creator" ? "creator" : "store";
  const [{ data: status }, { data: admin }, signupPend, typePend] = await Promise.all([
    sb.rpc("org_status", { p_org: org.id }),
    sb.rpc("is_platform_admin"),
    sb.rpc("legal_pending", { p_context: "signup" }),
    sb.rpc("legal_pending", { p_context: typeCtx }),
  ]);
  // Existing users accept newly published documents once (and again only after a material change).
  // Store commercial terms are asked at connection time; here only for stores that are already connected.
  const useType = org.type === "creator" || (status as OrgStatus | null)?.connected === true;
  const ctxs = ["signup", ...(useType ? [typeCtx] : [])];
  const pend = [signupPend, ...(useType ? [typePend] : [])];
  if (pend.some((r) => Array.isArray(r.data) && r.data.length > 0)) {
    redirect(`/legal/accept?ctx=${ctxs.join(",")}&next=${encodeURIComponent(`/app?org=${org.id}`)}`);
  }
  const { t, locale, dir } = await getT();
  return { sb, orgs, org, status: status as OrgStatus, isPlatformAdmin: admin === true, t, locale, dir };
}

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

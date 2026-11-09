import "server-only";
import { redirect } from "next/navigation";
import { getSupabase } from "./supabase/server";
import { getT } from "@/i18n";

export type Org = { id: string; type: "store" | "creator" | "agency"; name: string; role: string };

export async function getMyOrgs(): Promise<Org[]> {
  const sb = await getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return [];
  const { data } = await sb
    .from("memberships")
    .select("role, created_at, organizations(id, type, name)")
    .eq("user_id", auth.user.id)
    .order("created_at");
  return (data ?? []).flatMap((m) => {
    const o = m.organizations as unknown as { id: string; type: Org["type"]; name: string } | null;
    return o ? [{ id: o.id, type: o.type, name: o.name, role: m.role as string }] : [];
  });
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
  const org = pickOrg(orgs, sp.org)!;
  if (need && org.type !== need) redirect(`/app?org=${org.id}`);
  const sb = await getSupabase();
  const [{ data: status }, { data: admin }] = await Promise.all([
    sb.rpc("org_status", { p_org: org.id }),
    sb.rpc("is_platform_admin"),
  ]);
  const { t, locale, dir } = await getT();
  return { sb, orgs, org, status: status as OrgStatus, isPlatformAdmin: admin === true, t, locale, dir };
}

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

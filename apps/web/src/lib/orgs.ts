import "server-only";
import { getSupabase } from "./supabase/server";

export type Org = { id: string; type: "store" | "creator" | "agency"; name: string; role: string };

export async function getMyOrgs(): Promise<Org[]> {
  const sb = await getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return [];
  const { data } = await sb
    .from("memberships")
    .select("role, organizations(id, type, name)")
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

import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { errorCode } from "@/lib/format";
import { wpSetup } from "@/lib/wp-connect";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * WordPress sends the store owner back here after its own approval page (Application Passwords).
 * The temporary password arrives in this request only: it is used once, server-side, to install/activate/configure the
 * LINKUP Connector, then deleted in WordPress (wpSetup always revokes it). It is never stored or logged, and the owner is
 * redirected at once to a clean URL so it does not stay in the browser history either.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const org = q.get("org") ?? "";
  const state = q.get("state") ?? "";
  const done = (extra: Record<string, string>) =>
    NextResponse.redirect(new URL(`/app/connect?${new URLSearchParams({ org, ...extra })}`, req.nextUrl.origin), 303);

  const sb = await getSupabase();
  const { data: chk, error: ce } = await sb.rpc("wp_connect_check", { p_state: state });
  if (ce) return done({ error: errorCode(ce) });
  const c = chk as { org_id: string; site_url: string; completed: boolean; expired: boolean };
  if (c.completed) return done({ error: "invalid_state" });
  const finish = (outcome: string, details: Record<string, unknown>) =>
    sb.rpc("wp_connect_finish", { p_state: state, p_outcome: outcome, p_details: details });

  const password = q.get("password");
  if (q.get("rejected") || q.get("success") === "false" || !password) {
    await finish("rejected", {});
    return done({ wp: "rejected" });
  }
  if (c.expired) {
    await finish("expired", {});
    return done({ wp: "expired" });
  }
  // The approval must come from the site the owner named in LINKUP (same host), never another one.
  let host = "";
  try { host = new URL(q.get("site_url") ?? "").host; } catch { /* invalid */ }
  if (!host || host !== new URL(c.site_url).host) {
    await finish("site_mismatch", {});
    return done({ wp: "site_mismatch" });
  }

  const mode = q.get("mode") === "require" ? "require" : "notice";
  const r = await wpSetup({ site: c.site_url, user: q.get("user_login") ?? "", password }, fetch, async () => {
    const { data, error } = await sb.rpc("create_store_connection", { p_org: c.org_id, p_site_url: c.site_url });
    if (error) throw new Error(errorCode(error));
    return (data as { connection_key: string }).connection_key;
  }, mode);
  const { ok, code, step, installed, activated, configured, revoked, pluginVersion } = r;
  await finish(code, { ok, step, installed, activated, configured, revoked, plugin_version: pluginVersion ?? null, mode });
  return done(ok ? { wp: "connected", ...(revoked ? {} : { wpr: "0" }) } : { wp: code, ...(revoked ? {} : { wpr: "0" }) });
}

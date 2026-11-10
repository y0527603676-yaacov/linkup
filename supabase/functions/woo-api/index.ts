// LINKUP ↔ WooCommerce without a plugin. Deployed with verify_jwt = false: every route authenticates itself.
//   POST /woo-api/auth-callback  WooCommerce delivers API keys; one-time state (WooCommerce "user_id") required
//   POST /woo-api/webhook?c=ID    WooCommerce webhook; HMAC signature with the per-connection secret
//   POST /woo-api/sync            scheduler / "sync now"; x-linkup-cron token from Vault
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAuthCallback, handleWebhook, registerWebhooks, syncConnection, type Rpc } from "./core.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpc: Rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error: error ? { message: error.message } : null };
};
const BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1/woo-api`;
const MAX_BODY = 512 * 1024;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const later = (p: Promise<unknown>) => {
  // @ts-ignore EdgeRuntime exists in Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p.catch(() => {})); else p.catch(() => {});
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").pop();
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);

  if (route === "auth-callback") {
    const r = await handleAuthCallback(rpc, raw);
    if (r.connectionId) {   // answer WooCommerce at once; set up webhooks and the first sync in the background
      const id = r.connectionId;
      later((async () => {
        const { data } = await rpc("woo_api_credentials", { p_connection: id });
        if (data) { try { await registerWebhooks(rpc, fetch, data, `${BASE}/webhook`); } catch { /* sync reports it */ } }
        await syncConnection(rpc, fetch, id, `${BASE}/webhook`);
      })());
    }
    return json(r.body, r.status);
  }

  if (route === "webhook") {
    const r = await handleWebhook(rpc, url.searchParams.get("c") ?? "", req.headers, raw);
    return json(r.body, r.status);
  }

  if (route === "sync") {
    const ok = await rpc("woo_api_check_cron", { p_token: req.headers.get("x-linkup-cron") ?? "" });
    if (ok.data !== true) return json({ error: "unauthorized" }, 401);
    let only: string | null = null;
    try { only = (JSON.parse(raw || "{}") as { connection_id?: string }).connection_id ?? null; } catch { /* all */ }
    const ids = only ? [only] : (((await rpc("woo_api_connections")).data ?? []) as string[]);
    const results = [];
    for (const id of ids) results.push(await syncConnection(rpc, fetch, id, `${BASE}/webhook`));
    return json({ ok: true, results });
  }
  return json({ error: "not_found" }, 404);
});

// LINKUP ← WooCommerce plugin endpoint.
// Auth: per-store HMAC signature (no JWT).
// Body: {"action":"sync"} | {"action":"event","event":{...}} | {"action":"products","products":[...],"full_started_at"?}
import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeConnectionId, verifySignature } from "./hmac.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_BODY = 256 * 1024;
const PERMANENT_ERRORS = new Set(["invalid_event", "unknown_connection", "connection_disconnected"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const connectionId = normalizeConnectionId(req.headers.get("x-linkup-connection"));
  const ts = Number(req.headers.get("x-linkup-timestamp"));
  const sig = (req.headers.get("x-linkup-signature") ?? "").toLowerCase();
  if (!connectionId) return json({ error: "unauthorized" }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);

  const { data: secretRow, error: secretErr } = await supabase
    .from("store_connection_secrets").select("secret").eq("connection_id", connectionId).maybeSingle();
  if (secretErr) return json({ error: "unavailable" }, 503);
  if (!secretRow || !(await verifySignature(raw, sig, ts, secretRow.secret, Math.floor(Date.now() / 1000)))) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { action?: string; event?: unknown; plugin_version?: string; products?: unknown; full_started_at?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const call = body.action === "sync"
    ? supabase.rpc("plugin_sync", { p_connection: connectionId, p_plugin_version: String(body.plugin_version ?? "") })
    : body.action === "event"
    ? supabase.rpc("ingest_order_event", { p_connection: connectionId, p_event: body.event })
    : body.action === "products"
    ? supabase.rpc("plugin_sync_products", {
        p_connection: connectionId,
        p_products: Array.isArray(body.products) ? body.products : [],
        p_full_started_at: typeof body.full_started_at === "string" ? body.full_started_at : null,
      })
    : null;
  if (!call) return json({ error: "unknown_action" }, 400);

  const { data, error } = await call;
  if (error) {
    const code = PERMANENT_ERRORS.has(error.message) ? error.message : "temporary_error";
    // 422 = do not retry; 503 = plugin retries later.
    return json({ error: code }, code === "temporary_error" ? 503 : 422);
  }
  return json({ ok: true, result: data });
});

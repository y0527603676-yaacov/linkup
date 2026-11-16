// Sends Web Push for new sale notifications. Deployed with verify_jwt = false; the caller (DB trigger / 5-minute retry)
// proves itself with the x-linkup-cron token from Vault. The VAPID private key is read from Vault (service role only).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { buildMessage, type Pending } from "./core.ts";

const VAPID_PUBLIC_KEY = "BJHDYjvAeiXzTJnzwJxGn8us7PgG28TgmlO3j6mqz5fzTqATdUE23I-wINBnXBCfHX8PF8eQeiay4X_ERxVfS_Y";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ok = await supabase.rpc("push_check_cron", { p_token: req.headers.get("x-linkup-cron") ?? "" });
  if (ok.data !== true) return json({ error: "unauthorized" }, 401);
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? VAPID_PUBLIC_KEY;
  const priv = (await supabase.rpc("push_vapid_private")).data as string | null;
  if (!pub || !priv) return json({ error: "not_configured" }, 503);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:noreply@linkup.clearwise.me", pub, priv);

  const { data, error } = await supabase.rpc("push_pending", { p_limit: 50 });
  if (error) return json({ error: "pending_failed" }, 500);
  const items = (data ?? []) as Pending[];
  const done: string[] = [], okEp: string[] = [], gone: string[] = [], failed: string[] = [];
  for (const n of items) {
    const msg = buildMessage(n);
    let anyTransient = false, delivered = 0;
    for (const d of n.devices) {
      try {
        await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
          JSON.stringify(msg), { TTL: 86400, urgency: "high", topic: msg.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "") });
        okEp.push(d.endpoint); delivered++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (status === 404 || status === 410) gone.push(d.endpoint);
        else { failed.push(d.endpoint); anyTransient = true; }
      }
    }
    // Retry later only when every device failed transiently; otherwise the notification is delivered (or has no device).
    if (!anyTransient || delivered > 0) done.push(n.id);
  }
  if (failed.length) await supabase.rpc("push_failed", { p_endpoints: failed });
  await supabase.rpc("push_done", { p_notification_ids: done, p_ok: okEp, p_gone: gone });
  return json({ ok: true, notifications: items.length, sent: okEp.length, gone: gone.length, failed: failed.length });
});

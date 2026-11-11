// LINKUP ↔ Shopify / Wix apps. Deployed with verify_jwt = false: every route authenticates itself.
//   GET  /apps/shopify/callback   Shopify OAuth redirect (HMAC-verified query + one-time LINKUP state)
//   POST /apps/shopify/webhook    Shopify webhooks (X-Shopify-Hmac-Sha256), incl. mandatory privacy webhooks
//   GET  /apps/wix/callback       Wix install redirect (instanceId + one-time LINKUP state)
//   POST /apps/wix/webhook        Wix webhooks (JWT signed by Wix)
// Not active until the app credentials are set as function secrets (SHOPIFY_API_KEY / SHOPIFY_API_SECRET,
// WIX_APP_ID / WIX_APP_SECRET / WIX_PUBLIC_KEY) and the store-facing button is enabled.
import { createClient } from "npm:@supabase/supabase-js@2";
import { shopifyCallback, shopifyWebhook, wixCallback, wixWebhook, type Config, type Rpc } from "./core.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpc: Rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error: error ? { message: error.message } : null };
};
const cfg: Config = {
  shopifyKey: Deno.env.get("SHOPIFY_API_KEY"), shopifySecret: Deno.env.get("SHOPIFY_API_SECRET"),
  shopifyApiVersion: Deno.env.get("SHOPIFY_API_VERSION") ?? undefined,
  wixAppId: Deno.env.get("WIX_APP_ID"), wixSecret: Deno.env.get("WIX_APP_SECRET"), wixPublicKey: Deno.env.get("WIX_PUBLIC_KEY"),
  functionsBase: `${Deno.env.get("SUPABASE_URL")}/functions/v1/apps`,
  appBase: Deno.env.get("LINKUP_APP_URL") ?? "https://linkup-tawny.vercel.app",
};
const MAX_BODY = 512 * 1024;
const reply = (r: { status: number; body?: unknown; redirect?: string }) => r.redirect
  ? new Response(null, { status: 302, headers: { Location: r.redirect } })
  : new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "").split("/").slice(-2).join("/");
  if (req.method === "GET" && path === "shopify/callback") return reply(await shopifyCallback(rpc, fetch, cfg, url.searchParams));
  if (req.method === "GET" && path === "wix/callback") return reply(await wixCallback(rpc, fetch, cfg, url.searchParams));
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply({ status: 413, body: { error: "too_large" } });
    if (path === "shopify/webhook") return reply(await shopifyWebhook(rpc, cfg, req.headers, raw));
    if (path === "wix/webhook") return reply(await wixWebhook(rpc, cfg, raw));
  }
  return reply({ status: 404, body: { error: "not_found" } });
});

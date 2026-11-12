/** Controlled Shopify test: the app connection is offered only for these shops until a public launch is approved.
 *  The edge function enforces the same list (LINKUP_APPS_ALLOWED_SHOPS, default below). */
import { SUPABASE_URL } from "./supabase/env";

export const APP_TEST_SHOPS = ["linkup-test.myshopify.com"];
export const SHOPIFY_SCOPES = "read_orders,read_products,write_discounts,write_pixels,read_customer_events";
export const shopifyAppOffered = (shop?: string | null) =>
  process.env.LINKUP_SHOPIFY_APP === "1" || (!!shop && APP_TEST_SHOPS.includes(shop.toLowerCase()));

/** LINKUP's "apps" edge function. Uses the same project URL as the rest of the app (env var, else the project's
 *  public URL), so a missing NEXT_PUBLIC_SUPABASE_URL in a deployment can never produce a relative "undefined/..." path. */
export function appsFunctionBase(base: string = SUPABASE_URL): string {
  const u = new URL(base);
  if (u.protocol !== "https:" && !process.env.LINKUP_LOCAL_HTTP) throw new Error("apps_base_not_https");
  return `${u.origin}/functions/v1/apps`;
}
/** Start of the Shopify install: the edge function checks the shop and state, adds the Client ID, and sends the owner
 *  to Shopify's approval screen. */
export function shopifyInstallStart(shop: string, state: string, base?: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(shop) || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) throw new Error("invalid_install");
  return `${appsFunctionBase(base)}/shopify/install?${new URLSearchParams({ shop, state })}`;
}

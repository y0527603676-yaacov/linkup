/** Controlled Shopify test: the app connection is offered only for these shops until a public launch is approved.
 *  The edge function enforces the same list (LINKUP_APPS_ALLOWED_SHOPS, default below). */
export const APP_TEST_SHOPS = ["linkup-test.myshopify.com"];
export const SHOPIFY_SCOPES = "read_orders,read_products,write_discounts,write_pixels,read_customer_events";
export const shopifyAppOffered = (shop?: string | null) =>
  process.env.LINKUP_SHOPIFY_APP === "1" || (!!shop && APP_TEST_SHOPS.includes(shop.toLowerCase()));

# LINKUP on Shopify and Wix: status, link attribution, setup

Status (11.11.2026): built and tested against simulated Shopify/Wix APIs and a local database. **Not yet tested against a
real Shopify development store or a Wix test site.** Store-facing buttons stay off (`LINKUP_SHOPIFY_APP`,
`LINKUP_WIX_APP`). Nothing below is live in production.

## How a sale is attributed (same engine as WooCommerce)

Order data (amounts, status, cancellations, refunds) always comes from the platform: signed webhooks, or a read from
the platform API with LINKUP's app token. The browser never supplies amounts or status. One attribution per order; a
LINKUP coupon wins over a link; commissions only for paid orders; cancellations and refunds reverse them automatically.
The agreement's attribution window is enforced on the server (`ref_at` vs order date).

The personal link `/r/CODE` adds `lku=CODE&lkt=<visit time>` (plus UTM tags) to the store address.

### Shopify — four official paths, strongest first
| Path | Official mechanism | What it needs | Limits |
|---|---|---|---|
| 1. Discount link | Shopify shareable discount link `/discount/CODE?redirect=…` | App installed; the creator coupon gives a customer discount (>0%) and LINKUP confirmed it exists in the shop | Gives the customer the coupon discount (by design of the agreement). Switch: `app_settings.shopify_discount_link`. Shopify keeps the code in the cart/browser until removed, cookies cleared or the order is placed. |
| 2. Cart attribute | Theme app embed writes `linkup_ref` to the cart (Ajax Cart API); Shopify copies it to the order's `note_attributes` | Owner turns on the embed once (one-click link shown after connecting) | Express "Buy now" buttons that skip the cart may not carry cart attributes. Long-term storage only with marketing consent (Customer Privacy API); otherwise this browsing session only. |
| 3. Landing page | Order webhook `landing_site` | Nothing | Shopify records the landing page of the converting session only. |
| 4. Customer journey | Admin GraphQL `Order.customerJourneySummary` (last / first visit landing page, `ready` flag) | `read_orders` | Asked only for orders without a coupon or link data. When not `ready`, the next order event (e.g. paid) asks again. Community reports say it is sometimes empty. |

### Wix — official paths
| Path | Official mechanism | Limits |
|---|---|---|
| 1. Coupon | Partner coupon created in the Wix store (Coupons API); order `appliedDiscounts[].coupon.code` | Wix has no documented "link that applies a coupon"; the customer types the code. |
| 2. Personal link | Embedded script (app extension, consent category ADVERTISING) keeps the code; on Wix's standard **Purchase** analytics event (thank-you page, gives `orderId`) it sends `{instance, order, ref}` to LINKUP. LINKUP reads the order from the Wix eCommerce Orders API and ingests it with the ref. | Wix orders carry no landing page or UTM. The beacon is accepted only for orders created in the last 2 hours; first ref on an order wins. If the visitor declines marketing cookies, Wix doesn't load the script → no link credit (coupon still works). Ad blockers may block it. |

Not verified yet on real platforms: that Shopify fills `landing_site`/`customerJourneySummary` as documented for these
links; that the theme embed and the Wix embedded script run on live themes/sites; the exact Wix Purchase-event payload
(`orderId` format) and the legacy listener `wixDevelopersAnalytics` (a Wix CLI variant using `@wix/site` analytics is
included); the Wix coupon PATCH body for deactivation; Wix embedded scripts' plan/domain requirements.

## What's in the code
- `supabase/functions/apps/` — edge function `apps`: install callbacks, webhooks (incl. Shopify privacy webhooks),
  `wix/ref` beacon, `cron/sync` (health check by a real API call, coupons, products; failures recorded for admin).
  Retries with back-off on 429/5xx. Shopify returns 500 on temporary DB errors so Shopify re-sends.
- `integrations/shopify-app/` — `shopify.app.toml` template + theme app extension `linkup-ref` (app embed).
- `integrations/wix-app/embedded-script/` — self-managed embedded script (`{{endpoint}}`, `{{instance}}` parameters)
  and a Wix CLI variant.
- `apps/web/src/lib/partner-link.ts` + `/r/[code]` — where a personal link sends the visitor.
- Migrations (pending approval): `20261111102000_app_connections.sql`, `20261111102100_link_attribution.sql`;
  rollbacks in `supabase/rollback/20261111102000.down.sql`, `20261111102100.down.sql`.
- Tests: `tests/db/apps-flow.test.ts`, `tests/db/link-attribution.test.ts`, `tests/storefront/ref-scripts.cjs`
  (real Chromium, desktop/iPhone/iPad/Pixel).

## Owner's steps (in this order)
1. Shopify Partner account (free): https://www.shopify.com/partners → create a **development store** for testing.
2. In the Partner dashboard → Apps → Create app (manually). Copy *Client ID* and *Client secret*.
   App URL: `https://linkup-tawny.vercel.app/app/connect`. Allowed redirect URL:
   `https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/apps/shopify/callback`.
   Scopes: `read_orders, read_products, write_discounts`. Request access to **protected customer data** (orders include
   the buyer's e-mail; LINKUP stores only a hash) — level 1.
3. Approve migrations 2000 and 2100 (applied by me after approval), then I set the function secrets
   (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `LINKUP_CRON_SECRET`) and deploy the `apps` function (verify_jwt off).
4. Deploy the theme extension: requires the Shopify CLI on a computer (`npm i -g @shopify/cli`, then in
   `integrations/shopify-app`: `shopify app deploy`). I can guide this step by step.
5. Install on the development store from LINKUP (local flag on for your test store only) → place test orders: with the
   coupon, through the personal link, cancel, refund. Only after this passes may Shopify be offered to stores.
6. Wix: developer account https://dev.wix.com → create app → OAuth (Client ID/secret), Webhooks (eCommerce order
   events, App Removed) and public key, Embedded Script extension (type ADVERTISING, placement BODY_END, parameters
   `endpoint`, `instance`, paste `linkup-ref.html`), permissions: Read Orders, Manage Coupons, Read Products,
   Manage Embedded Scripts. Test on a Wix test site with a Business plan (needed to accept payments).
7. Scheduled sync: a Supabase cron calling `POST …/functions/v1/apps/cron/sync` with header `X-LinkUp-Cron` every
   6 hours (I prepare the SQL after approval).
8. Public App Store listing (Shopify review / Wix review) — later, only after the pilot works.

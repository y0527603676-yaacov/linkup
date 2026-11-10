=== LINKUP Connector ===
Contributors: linkup
Tags: affiliate, influencer, coupons, referral, woocommerce
Requires at least: 6.4
Tested up to: 6.8
Requires PHP: 7.4
WC requires at least: 8.0
Stable tag: 0.4.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connect your WooCommerce store to LINKUP: personal coupons and links for creators, 30-day referral tracking and secure sales reporting.

== Description ==

LINKUP connects online stores with creators who sell for them. This plugin is the store-side part of the connection:

* Keeps creators' personal coupons in your store (only coupons it created; your own coupons are never touched).
* Remembers, for 30 days, which creator's link brought a visitor (a first-party cookie on your own domain), so a purchase on a later visit is still credited to the right creator.
* Reports orders, refunds and cancellations to LINKUP with a signed request, so commissions are calculated once and corrected automatically.
* Sends your product catalogue (name, price, stock, image) so creators can choose what to promote. LINKUP never changes products, prices or orders.

== External service ==

This plugin sends data to the LINKUP service (https://linkup-tawny.vercel.app), operated by LINKUP, at the endpoint
https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/woo, only after a store manager connects it:

* Orders: order id, status, totals, tax, shipping, coupon codes used, the LINKUP referral code and its time, refunds, and a SHA-256 hash of the buyer's e-mail (used to detect self-referrals). No names, addresses, phone numbers or payment details are sent.
* Products: id, name, link, image, price, currency, stock and categories.

Terms: https://linkup-tawny.vercel.app/terms — Privacy: https://linkup-tawny.vercel.app/privacy

== Privacy ==

The plugin sets one first-party cookie, `linkup_ref`, when a visitor arrives through a LINKUP creator link. It holds the creator's code and the time of the visit, lasts 30 days and is used only to credit a sale to that creator. Stores should mention it in their cookie notice.

== Installation ==

Install and activate the plugin, then go to WooCommerce → LINKUP and paste the connection key from LINKUP.

== Changelog ==

= 0.4.0 =
* Remote setup routes for one-approval onboarding (store managers only; the key is never returned).

= 0.3.1 =
* Non-blocking product sync on save.

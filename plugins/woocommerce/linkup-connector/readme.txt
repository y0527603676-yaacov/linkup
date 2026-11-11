=== LINKUP Connector ===
Contributors: linkup
Tags: affiliate, influencer, coupons, referral, woocommerce
Requires at least: 6.4
Tested up to: 6.5
Requires PHP: 7.4
WC requires at least: 8.0
WC tested up to: 9.4
Stable tag: 0.4.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connect your WooCommerce store to LINKUP: personal coupons and links for creators, 30-day referral tracking and secure sales reporting.

== Description ==

LINKUP connects online stores with creators who sell for them on commission. This plugin is the store-side part of the connection:

* Keeps creators' personal coupons in your store. It only creates and updates coupons it created itself; your own coupons are never touched.
* Remembers, for 30 days, which creator's link brought a visitor (a first-party cookie on your own domain), so a purchase on a later visit is still credited to the right creator.
* Reports orders, refunds and cancellations to LINKUP with a signed request, so commissions are calculated once and corrected automatically.
* Sends your product catalogue (name, price, stock, image) so creators can choose what to promote.
* LINKUP never changes your products, prices or orders.

Works with the classic checkout and the block checkout, and with WooCommerce's High-Performance Order Storage.

A LINKUP account is required. The plugin does nothing until a store manager connects it.

== External service ==

This plugin relies on the LINKUP service (https://linkup-tawny.vercel.app), operated by LINKUP. Data is sent to https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/woo only after a store manager connects the store:

* Orders: order id, status, totals, tax, shipping, coupon codes used, the LINKUP referral code and its time, refunds, and a SHA-256 hash of the buyer's e-mail (used only to detect self-referrals). No names, addresses, phone numbers or payment details are sent.
* Products: id, name, link, image, price, currency, stock and categories.
* A periodic status check (plugin version), which also returns the partner coupons to keep in the store.

Terms of use: https://linkup-tawny.vercel.app/terms
Privacy policy: https://linkup-tawny.vercel.app/privacy

== Privacy ==

The plugin sets one first-party cookie, `linkup_ref`, only when a visitor arrives through a LINKUP creator link. It holds the creator's code and the time of the visit, lasts 30 days and is used only to credit a sale to that creator.

* If your site uses a consent banner that supports the WP Consent API, the cookie is set only after the visitor accepts marketing cookies.
* Without such a banner, the store chooses in LINKUP: set the cookie and mention it in the cookie notice, or never set it without consent.
* Personal coupons keep working either way.

Please mention the cookie in your privacy and cookie notice.

== Installation ==

The easiest way: in LINKUP, open "Connect your store", choose "Connect with one approval" and approve on your WordPress site. LINKUP installs, activates and connects the plugin. The temporary access used for this is deleted right away.

Manual installation:

1. Install and activate the plugin.
2. In LINKUP, create a connection key.
3. Paste it in WooCommerce → LINKUP.

== Frequently Asked Questions ==

= Does LINKUP keep access to my site? =

No. When you connect with one approval, LINKUP uses a temporary WordPress application password once and deletes it at the end of the setup, even if a step fails. You can verify this under Users → Profile → Application Passwords.

= What happens when I disconnect or remove the plugin? =

The plugin stops sending data. Partner coupons it created are set to draft (not deleted), and removing the plugin deletes its settings. Your sales and commission history in LINKUP is kept.

= Which data leaves my store? =

See "External service" above. No customer names, addresses, phone numbers or payment details.

== Changelog ==

= 0.4.1 =
* Visitor consent: respects the WP Consent API (marketing), or the store's own setting (notice / require).
* Block checkout (Store API) support for referrals.
* The plugin stops by itself when the store disconnects in LINKUP.
* Partner coupons go to draft on disconnect or uninstall.
* Uninstall removes the plugin's settings.
* Translatable interface (English, Hebrew included).

= 0.4.0 =
* Remote setup routes for one-approval onboarding (store managers only; the key is never returned).

= 0.3.1 =
* Non-blocking product sync on save.

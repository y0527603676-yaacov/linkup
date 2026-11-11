# One-approval WordPress setup – isolated end-to-end test

`wp-auto-connect.test.ts` runs the whole "connect with one approval" flow against a **real WordPress** (6.5.5)
running only on this machine. It never touches a real store, LINKUP production, or the internet.

## What is real and what is a stand-in
| Part | In the test |
|---|---|
| WordPress core, login, its approval page (`authorize-application.php`), Application Passwords, REST API, plugin installer (`POST /wp/v2/plugins`), activation, uninstall | **Real** |
| LINKUP Connector plugin (the same zip that is published) | **Real** |
| LINKUP database functions (consent record, connection key, sync, order ingest, attribution, disconnect) | **Real** (all migrations, PGlite) |
| `lib/wp-connect.ts` (the server code that installs/configures/revokes) | **Real** |
| WordPress.org directory entry | Stand-in (`site/mu-plugins/zz-test-directory.php`): returns the same zip from the local site. Toggle off to test "not listed yet". |
| WooCommerce | Stand-in (`site/woocommerce/woocommerce.php`): minimal orders and coupons with the hooks the plugin uses. Real WooCommerce cannot be downloaded in this sandbox. |
| LINKUP's `woo` Edge Function | Emulated inside the test with the same signature check and database calls (`site/mu-plugins/zz-test-linkup-net.php` routes the plugin's calls to it). |

## Setup (once)
1. WordPress 6.5.5 from npm `@wp-playground/wordpress-builds`, SQLite drop-in, `wp-config.php` with
   `WP_ENVIRONMENT_TYPE=local`, `FS_METHOD=direct`, `WP_HOME`/`WP_SITEURL` = `http://127.0.0.1:8090`.
2. `php site/scripts/install.php` – test users `storeadmin` (administrator) and `editor1` (editor), test-only passwords.
3. Copy `site/mu-plugins/*` to `wp-content/mu-plugins/` and `site/woocommerce/` to `wp-content/plugins/woocommerce/`, activate it.
4. Copy the plugin zip to `<site>/test-dl/linkup-connector.zip`.
5. Serve: `PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8090` (several workers: the installer downloads from the same server).

## Run
`php site/scripts/reset.php && npm run test:wp`

---

# Real WooCommerce store – pilot rehearsal (`wc-real.test.ts`)

Real WordPress 6.5.5 + **official WooCommerce 9.4.2 release** + MariaDB, HPOS order storage, Store API checkout (what the block
checkout uses), real coupons, cancellations and refunds. Everything on 127.0.0.1; nothing reaches a real store or LINKUP production.

| Part | In the test |
|---|---|
| WordPress, WooCommerce, MariaDB, checkout, coupons, refunds, uploads, application passwords | **Real** |
| LINKUP Connector plugin (release zip) and `lib/wp-connect.ts` | **Real** |
| LINKUP database functions | **Real** (all migrations, PGlite) |
| WordPress.org directory entry | Stand-in until the plugin is listed (`real-store/mu-plugins/zz-test-directory.php`) |
| LINKUP `woo` Edge Function | Emulated in the test (same signature check, same database calls) |

Setup (once):
1. `apt-get install mariadb-server`; start it; create database `wcreal` / user `wcreal` (test-only password in `real-store/wp-config.php`).
2. WordPress 6.5.5: unzip `@wp-playground/wordpress-builds` `src/wordpress/wp-6.5.zip` and overlay `public/wp-6.5` (static assets); remove the SQLite drop-in; use `real-store/wp-config.php`.
3. WooCommerce: `https://github.com/woocommerce/woocommerce/releases/download/9.4.2/woocommerce.zip` into `wp-content/plugins/`.
4. `php real-store/scripts/install.php && php real-store/scripts/setup-wc.php && php real-store/scripts/setup-shop.php && php real-store/scripts/hpos.php yes`
5. Copy `real-store/mu-plugins/*` to `wp-content/mu-plugins/`; copy the plugin zip to `<site>/test-dl/linkup-connector.zip`.
6. `PHP_CLI_SERVER_WORKERS=6 php -S 127.0.0.1:8096` from the site folder.

Run: `npm run test:wp` (runs both suites, one after another; each resets its site first).

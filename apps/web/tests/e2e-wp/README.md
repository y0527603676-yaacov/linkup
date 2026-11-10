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

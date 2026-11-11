<?php
/* ISOLATED TEST STORE – real WordPress 6.5.5 + real WooCommerce, local MariaDB. Not reachable from the internet. */
define('DB_NAME', 'wcreal'); define('DB_USER', 'wcreal'); define('DB_PASSWORD', 'wcreal-test-only'); define('DB_HOST', 'localhost:/run/mysqld/mysqld.sock');
define('DB_CHARSET', 'utf8mb4'); define('DB_COLLATE', '');
foreach (['AUTH_KEY','SECURE_AUTH_KEY','LOGGED_IN_KEY','NONCE_KEY','AUTH_SALT','SECURE_AUTH_SALT','LOGGED_IN_SALT','NONCE_SALT'] as $k) define($k, hash('sha256', $k . 'wcreal-local-test'));
$table_prefix = 'wp_';
define('WP_DEBUG', true); define('WP_DEBUG_LOG', '/var/tmp/wcreal/debug.log'); define('WP_DEBUG_DISPLAY', false);
define('WP_ENVIRONMENT_TYPE', 'local'); define('FS_METHOD', 'direct');
define('WP_HOME', 'http://127.0.0.1:8096'); define('WP_SITEURL', 'http://127.0.0.1:8096');
define('DISABLE_WP_CRON', false);
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';

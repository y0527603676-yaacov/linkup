<?php
/* Isolated test store installer: real WordPress + real WooCommerce. Test-only users and passwords. */
define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/'; $_SERVER['SERVER_NAME'] = '127.0.0.1';
require '/var/tmp/wcreal/site/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if (!is_blog_installed()) { wp_install('חנות בדיקה מבודדת', 'storeadmin', 'admin@store.test', false, '', 'Adm1n-Test-Only!'); echo "wp installed\n"; }
update_option('permalink_structure', '/%postname%/');
if (!get_user_by('login', 'editor1')) wp_insert_user(['user_login' => 'editor1', 'user_pass' => 'Ed1tor-Test-Only!', 'user_email' => 'ed@store.test', 'role' => 'editor']);
echo 'WP ' . get_bloginfo('version') . "\n";

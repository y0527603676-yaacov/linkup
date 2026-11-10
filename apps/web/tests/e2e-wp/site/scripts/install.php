<?php
define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST'] = '127.0.0.1:8090'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wpt/site/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if (!is_blog_installed()) {
  $r = wp_install('Test Store (isolated)', 'storeadmin', 'admin@store.test', true, '', 'Adm1n-Test-Only!');
  echo "installed user {$r['user_id']}\n";
} else { echo "already installed\n"; }
update_option('permalink_structure', '/%postname%/');
if (!get_user_by('login', 'editor1')) { wp_insert_user(['user_login' => 'editor1', 'user_pass' => 'Ed1tor-Test-Only!', 'user_email' => 'ed@store.test', 'role' => 'editor']); echo "editor created\n"; }
echo 'WP ' . get_bloginfo('version') . ' app-passwords available: ' . (wp_is_application_passwords_available() ? 'yes' : 'no') . "\n";

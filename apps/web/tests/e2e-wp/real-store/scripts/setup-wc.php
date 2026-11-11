<?php
/* Activates real WooCommerce and prepares a minimal shop (ILS, Israel, cash on delivery, 3 products). */
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wcreal/site/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
wp_set_current_user(get_user_by('login', 'storeadmin')->ID);
if (!is_plugin_active('woocommerce/woocommerce.php')) { $r = activate_plugin('woocommerce/woocommerce.php'); if (is_wp_error($r)) die($r->get_error_message()); echo "woocommerce activated\n"; }

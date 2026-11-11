<?php
/* Back to a clean store: LINKUP plugin removed with its settings, LINKUP passwords and coupons removed, test orders deleted. */
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wcreal/site/wp-load.php'; require_once ABSPATH . 'wp-admin/includes/plugin.php'; require_once ABSPATH . 'wp-admin/includes/file.php';
deactivate_plugins('linkup-connector/linkup-connector.php', true);
if (file_exists(WP_PLUGIN_DIR . '/linkup-connector')) delete_plugins(['linkup-connector/linkup-connector.php']);
foreach (['linkup_connection_key', 'linkup_last_sync', 'linkup_consent_mode', 'linkup_products_pass', 'linkup_test_directory'] as $o) delete_option($o);
foreach (['storeadmin', 'editor1'] as $l) WP_Application_Passwords::delete_all_application_passwords(get_user_by('login', $l)->ID);
foreach (get_posts(['post_type' => 'shop_coupon', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids']) as $id) wp_delete_post($id, true);
foreach (wc_get_orders(['limit' => -1, 'return' => 'ids', 'type' => 'shop_order']) as $id) { $o = wc_get_order($id); if ($o) $o->delete(true); }
if (function_exists('as_unschedule_all_actions')) { as_unschedule_all_actions('linkup_sync'); as_unschedule_all_actions('linkup_send_order'); }
foreach (wc_get_products(['limit' => -1]) as $pr) { $pr->set_stock_quantity(20); $pr->set_stock_status('instock'); $pr->save(); }   // fresh stock for test purchases
echo "reset: plugin present=" . (int) file_exists(WP_PLUGIN_DIR . '/linkup-connector') . " orders=" . count(wc_get_orders(['limit' => -1, 'return' => 'ids'])) . "\n";

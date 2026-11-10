<?php
define('WP_USE_THEMES', false); $_SERVER['HTTP_HOST']='127.0.0.1:8090';
require '/var/tmp/wpt/site/wp-load.php'; require_once ABSPATH.'wp-admin/includes/plugin.php'; require_once ABSPATH.'wp-admin/includes/file.php';
deactivate_plugins('linkup-connector/linkup-connector.php', true);
if (file_exists(WP_PLUGIN_DIR.'/linkup-connector')) delete_plugins(['linkup-connector/linkup-connector.php']);
foreach (['linkup_connection_key','linkup_last_sync','linkup_consent_mode','linkup_products_pass','wc_test_orders','wc_test_coupons','linkup_test_directory'] as $o) delete_option($o);
foreach (['storeadmin','editor1'] as $l) WP_Application_Passwords::delete_all_application_passwords(get_user_by('login',$l)->ID);
foreach (get_posts(['post_type'=>'shop_coupon','post_status'=>'any','numberposts'=>-1,'fields'=>'ids']) as $id) wp_delete_post($id, true);
echo "reset: plugin present=", (int) file_exists(WP_PLUGIN_DIR.'/linkup-connector'), "\n";

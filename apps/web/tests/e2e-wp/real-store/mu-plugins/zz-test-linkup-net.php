<?php
/* ISOLATED TEST STORE ONLY.
 * 1) The plugin's signed calls to LINKUP's endpoint go to a local emulator of the "woo" Edge Function (127.0.0.1:8092):
 *    same signature check, same database functions. This sandbox cannot reach LINKUP production, and must not.
 * 2) /linkup-test/v1/state – read-only view of what the plugin did (for assertions), plus test switches. */
add_filter('pre_http_request', function ($pre, $args, $url) {
    if (strpos($url, 'supabase.co/functions/v1/woo') === false) return $pre;
    return wp_remote_request('http://127.0.0.1:8092/functions/v1/woo', $args);
}, 10, 3);
add_action('rest_api_init', function () {
    register_rest_route('linkup-test/v1', '/state', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($req) {
        if (isset($req['consent_mode'])) update_option('linkup_consent_mode', $req['consent_mode'], false);
        if (isset($req['directory'])) update_option('linkup_test_directory', $req['directory'] ? 'on' : 'off');
        if (!empty($req['run_sync']) && function_exists('linkup_sync')) linkup_sync();
        if (!function_exists('is_plugin_active')) require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $u = get_user_by('login', $req['user'] ?: 'storeadmin');
        $linkup_pw = $u ? array_filter(WP_Application_Passwords::get_user_application_passwords($u->ID), fn($p) => str_starts_with($p['name'], 'LINKUP')) : [];
        $coupons = array_map(fn($id) => ['code' => get_the_title($id), 'status' => get_post_status($id), 'amount' => get_post_meta($id, 'coupon_amount', true),
            'type' => get_post_meta($id, 'discount_type', true), 'managed' => get_post_meta($id, '_linkup_managed', true)],
            get_posts(['post_type' => 'shop_coupon', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids']));
        return ['key_saved' => (bool) get_option('linkup_connection_key'), 'consent_mode' => get_option('linkup_consent_mode', null),
                'plugin_installed' => file_exists(WP_PLUGIN_DIR . '/linkup-connector/linkup-connector.php'),
                'plugin_active' => is_plugin_active('linkup-connector/linkup-connector.php'),
                'app_passwords' => count($linkup_pw), 'coupons' => $coupons,
                'wc_version' => defined('WC_VERSION') ? WC_VERSION : null, 'hpos' => get_option('woocommerce_custom_orders_table_enabled'),
                'options_left' => array_values(array_filter(['linkup_connection_key', 'linkup_last_sync', 'linkup_consent_mode', 'linkup_products_pass'], fn($o) => get_option($o, null) !== null))];
    }]);
});

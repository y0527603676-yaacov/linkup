<?php
/* ISOLATED TEST ENVIRONMENT ONLY.
 * Routes the plugin's signed calls for LINKUP's endpoint to a local emulator of the "woo" Edge Function
 * (same signature check, same database functions) at 127.0.0.1:8092 – this sandbox has no internet. */
add_filter('pre_http_request', function ($pre, $args, $url) {
    if (strpos($url, 'supabase.co/functions/v1/woo') === false) return $pre;
    $args['headers']['X-Test-Original-Url'] = $url;
    return wp_remote_request('http://127.0.0.1:8092/functions/v1/woo', $args);
}, 10, 3);
add_action('rest_api_init', function () {
    // Test shopper checkout: creates an order in the WooCommerce stand-in and fires WooCommerce's real hooks.
    register_rest_route('linkup-test/v1', '/checkout', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($req) {
        $o = linkup_test_create_order((array) ($req['coupons'] ?? []));
        do_action('woocommerce_checkout_order_created', $o);   // plugin stores the referral from the visitor's cookie
        do_action('woocommerce_new_order', $o->get_id());       // plugin reports the order at the end of the request
        return ['order_id' => $o->get_id(), 'meta_ref' => $o->get_meta('_linkup_ref')];
    }]);
    register_rest_route('linkup-test/v1', '/state', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($req) {
        if (isset($req['consent_mode'])) update_option('linkup_consent_mode', $req['consent_mode'], false);
        if (isset($req['directory'])) update_option('linkup_test_directory', $req['directory'] ? 'on' : 'off');
        if (!empty($req['run_sync']) && function_exists('linkup_sync')) linkup_sync();
        if (!function_exists('is_plugin_active')) require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $u = get_user_by('login', $req['user'] ?: 'storeadmin');
        return ['key_saved' => (bool) get_option('linkup_connection_key'), 'consent_mode' => get_option('linkup_consent_mode', null),
                'plugin_installed' => file_exists(WP_PLUGIN_DIR . '/linkup-connector/linkup-connector.php'),
                'plugin_active' => is_plugin_active('linkup-connector/linkup-connector.php'),
                'last_sync' => get_option('linkup_last_sync', null), 'coupons' => function_exists('linkup_test_coupons') ? linkup_test_coupons() : [],
                'app_passwords' => $u ? count(WP_Application_Passwords::get_user_application_passwords($u->ID)) : null,
                'options_left' => array_values(array_filter(['linkup_connection_key', 'linkup_last_sync', 'linkup_consent_mode', 'linkup_products_pass'], fn($o) => get_option($o, null) !== null))];
    }]);
});

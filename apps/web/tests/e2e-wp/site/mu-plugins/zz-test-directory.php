<?php
/* ISOLATED TEST ENVIRONMENT ONLY. Stands in for the WordPress.org directory entry of "linkup-connector".
 * Toggle with the option linkup_test_directory (default on). */
add_filter('plugins_api', function ($res, $action, $args) {
    if ($action !== 'plugin_information' || ($args->slug ?? '') !== 'linkup-connector') return $res;
    if (get_option('linkup_test_directory', 'on') !== 'on') return new WP_Error('plugins_api_failed', 'Plugin not found in directory');
    return (object) ['name' => 'LINKUP Connector', 'slug' => 'linkup-connector', 'version' => '0.4.1',
        'download_link' => home_url('/test-dl/linkup-connector.zip'), 'language_packs' => []];
}, 10, 3);
add_filter('http_request_host_is_external', fn($ok, $host) => $host === '127.0.0.1' ? true : $ok, 10, 2);

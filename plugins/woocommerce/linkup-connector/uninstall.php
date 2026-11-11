<?php
/**
 * Removing the plugin from WordPress: delete its own settings. Partner coupons it created are set to draft
 * (kept, so the store can review or re-enable them; never deleted), and records kept by LINKUP for commissions
 * and accounting are not affected.
 */
defined('WP_UNINSTALL_PLUGIN') || exit;
$linkup_coupon_ids = get_posts(array('post_type' => 'shop_coupon', 'post_status' => 'publish', 'numberposts' => 500, 'fields' => 'ids',
                                     'meta_key' => '_linkup_managed', 'meta_value' => '1')); // phpcs:ignore WordPress.DB.SlowDBQuery -- runs once, bounded
foreach ($linkup_coupon_ids as $linkup_id) {
    wp_update_post(array('ID' => $linkup_id, 'post_status' => 'draft'));
}
foreach (array('linkup_connection_key', 'linkup_last_sync', 'linkup_products_pass', 'linkup_consent_mode') as $linkup_opt) {
    delete_option($linkup_opt);
}
if (function_exists('as_unschedule_all_actions')) {
    as_unschedule_all_actions('linkup_sync');
}

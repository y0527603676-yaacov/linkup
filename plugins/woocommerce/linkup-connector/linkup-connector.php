<?php
/**
 * Plugin Name: LINKUP Connector
 * Description: Connects your WooCommerce store to LINKUP: personal coupons for creators, 30-day referral tracking and secure sales reporting.
 * Version: 0.4.1
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * WC requires at least: 8.0
 * WC tested up to: 9.4
 * Requires Plugins: woocommerce
 * Author: LINKUP
 * License: GPLv2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: linkup-connector
 */

defined('ABSPATH') || exit;

define('LINKUP_VERSION', '0.4.1');
define('LINKUP_ENDPOINT', 'https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/woo');
define('LINKUP_OPT_KEY', 'linkup_connection_key');
define('LINKUP_OPT_LAST', 'linkup_last_sync');
define('LINKUP_COOKIE', 'linkup_ref');
define('LINKUP_COOKIE_DAYS', 30);

/* HPOS compatibility — only WooCommerce CRUD APIs are used. */
add_action('before_woocommerce_init', static function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
    }
});

/** Parse "lk_<32 hex>_<64 hex>" → [connection_id, secret] or null. */
function linkup_credentials() {
    $key = trim((string) get_option(LINKUP_OPT_KEY, ''));
    if (!preg_match('/^lk_([0-9a-f]{32})_([0-9a-f]{64})$/', $key, $m)) {
        return null;
    }
    return array($m[1], $m[2]);
}

/** Signature = hex(HMAC-SHA256(secret, "{timestamp}.{body}")) — verified by the LINKUP Edge Function. */
function linkup_sign($body, $ts, $secret) {
    return hash_hmac('sha256', $ts . '.' . $body, $secret);
}

/** Signed POST to LINKUP. Returns [http_code, decoded_body]. */
function linkup_post(array $payload) {
    $cred = linkup_credentials();
    if (!$cred) {
        return array(0, null);
    }
    $body = wp_json_encode($payload);
    $ts = time();
    $res = wp_remote_post(LINKUP_ENDPOINT, array(
        'timeout' => 15,
        'headers' => array(
            'Content-Type'        => 'application/json',
            'X-Linkup-Connection' => $cred[0],
            'X-Linkup-Timestamp'  => (string) $ts,
            'X-Linkup-Signature'  => linkup_sign($body, $ts, $cred[1]),
        ),
        'body'    => $body,
    ));
    if (is_wp_error($res)) {
        return array(0, null);
    }
    return array((int) wp_remote_retrieve_response_code($res), json_decode(wp_remote_retrieve_body($res), true));
}

/* ------------------------------------------------------------------
 * 1. Referral link capture: ?lku=CODE → first-party cookie "CODE|timestamp"
 *    Visitor consent: if the site uses the WP Consent API (most consent banners support it), the cookie is set
 *    only after consent for "marketing". Without it, the store's setting decides (default: set; "require" = never
 *    without the Consent API). Coupons keep working either way.
 * ------------------------------------------------------------------ */
function linkup_may_track() {
    if (function_exists('wp_has_consent')) {
        $ok = (bool) wp_has_consent('marketing');
    } else {
        $ok = get_option('linkup_consent_mode', 'notice') !== 'require';
    }
    return (bool) apply_filters('linkup_may_track', $ok);
}

add_action('init', static function () {
    // A public referral link (?lku=CODE) opened by any visitor: there is no form and no state change, so no nonce applies.
    // The value is reduced to 4–16 letters/digits before use.
    // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    $raw = isset($_GET['lku']) ? sanitize_text_field(wp_unslash($_GET['lku'])) : '';
    if ($raw === '' || !linkup_may_track()) {
        return;
    }
    $code = preg_replace('/[^A-Za-z0-9]/', '', $raw);
    if (strlen($code) < 4 || strlen($code) > 16) {
        return;
    }
    $value = $code . '|' . time();
    setcookie(LINKUP_COOKIE, $value, array(
        'expires'  => time() + LINKUP_COOKIE_DAYS * DAY_IN_SECONDS,
        'path'     => '/',
        'secure'   => is_ssl(),
        'httponly' => true,
        'samesite' => 'Lax',
    ));
    $_COOKIE[LINKUP_COOKIE] = $value;
});

/** Stores the referral on the order at checkout — classic checkout and the block (Store API) checkout. */
function linkup_attach_ref($order) {
    if (!$order || empty($_COOKIE[LINKUP_COOKIE]) || $order->get_meta('_linkup_ref')) {
        return;
    }
    $raw = sanitize_text_field(wp_unslash($_COOKIE[LINKUP_COOKIE]));
    if (preg_match('/^[A-Za-z0-9]{4,16}\|[0-9]{9,11}$/', $raw)) {
        $order->update_meta_data('_linkup_ref', $raw);
        $order->save();
    }
}
add_action('woocommerce_checkout_order_created', 'linkup_attach_ref');
add_action('woocommerce_store_api_checkout_order_processed', 'linkup_attach_ref');

/* ------------------------------------------------------------------
 * 2. Order events — deterministic event ids (order + modification time),
 *    queued in Action Scheduler, retried with backoff.
 * ------------------------------------------------------------------ */
function linkup_to_minor($v) {
    return (int) round(((float) $v) * 100);
}

function linkup_order_payload($order) {
    $refunds = array();
    foreach ($order->get_refunds() as $refund) {
        $refunds[] = array('id' => (string) $refund->get_id(), 'amount' => linkup_to_minor($refund->get_amount()));
    }
    $modified = $order->get_date_modified() ? $order->get_date_modified()->getTimestamp() : time();
    $email = strtolower(trim((string) $order->get_billing_email()));
    return array(
        'event_id'    => 'o' . $order->get_id() . '-m' . $modified . '-r' . count($refunds) . '-' . $order->get_status(),
        'type'        => 'order.upserted',
        'occurred_at' => gmdate('c', $modified),
        'order'       => array(
            'id'           => (string) $order->get_id(),
            'status'       => $order->get_status(),
            'currency'     => strtoupper($order->get_currency()),
            'total'        => linkup_to_minor($order->get_total()),
            'tax'          => linkup_to_minor($order->get_cart_tax()),
            'shipping'     => linkup_to_minor($order->get_shipping_total()),
            'shipping_tax' => linkup_to_minor($order->get_shipping_tax()),
            'coupons'      => array_values($order->get_coupon_codes()),
            'ref'          => (string) $order->get_meta('_linkup_ref'),
            'email_hash'   => $email !== '' ? hash('sha256', $email) : '',
            'created_at'   => $order->get_date_created() ? $order->get_date_created()->format('c') : gmdate('c'),
            'refunds'      => $refunds,
        ),
    );
}

/* Orders changed during this request are sent directly at the end of the request
   (no dependency on background cron). Action Scheduler is used only to retry failures. */
$GLOBALS['linkup_pending_orders'] = array();

function linkup_queue_order($order_id) {
    if (!linkup_credentials()) {
        return;
    }
    $GLOBALS['linkup_pending_orders'][(int) $order_id] = true;
}

add_action('woocommerce_new_order', 'linkup_queue_order');
add_action('woocommerce_update_order', 'linkup_queue_order');
add_action('woocommerce_order_status_changed', 'linkup_queue_order');
add_action('woocommerce_order_refunded', 'linkup_queue_order');

add_action('shutdown', static function () {
    if (empty($GLOBALS['linkup_pending_orders'])) {
        return;
    }
    $ids = array_keys($GLOBALS['linkup_pending_orders']);
    $GLOBALS['linkup_pending_orders'] = array();
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request(); // let the browser continue while we report to LINKUP
    }
    foreach (array_slice($ids, 0, 20) as $id) {
        linkup_send_order_now($id, 0);
    }
});

/** Send one order to LINKUP now. Returns true on success. Schedules a retry on temporary failure. */
function linkup_send_order_now($order_id, $attempt = 0) {
    $order = wc_get_order($order_id);
    if (!$order || $order->get_type() !== 'shop_order') {
        return false;
    }
    list($code) = linkup_post(array('action' => 'event', 'event' => linkup_order_payload($order)));
    if ($code >= 200 && $code < 300) {
        return true;
    }
    if ($code === 422 || $code === 401) {
        return false; // permanent: invalid data or wrong key
    }
    if ($attempt < 5 && function_exists('as_schedule_single_action')) {
        as_schedule_single_action(time() + (60 * pow(2, $attempt)), 'linkup_send_order', array((int) $order_id, $attempt + 1), 'linkup');
    }
    return false;
}

add_action('linkup_send_order', static function ($order_id, $attempt = 0) {
    linkup_send_order_now($order_id, $attempt);
}, 10, 2);

/* ------------------------------------------------------------------
 * 3. Sync every 15 minutes: heartbeat, partner coupons, reconciliation of
 *    orders modified since the last sync (covers lost events).
 * ------------------------------------------------------------------ */
add_action('init', static function () {
    if (linkup_credentials() && function_exists('as_has_scheduled_action') && !as_has_scheduled_action('linkup_sync')) {
        as_schedule_recurring_action(time() + 60, 15 * MINUTE_IN_SECONDS, 'linkup_sync', array(), 'linkup');
    }
});

function linkup_sync() {
    list($code, $res) = linkup_post(array('action' => 'sync', 'plugin_version' => LINKUP_VERSION));
    if ($code === 422 && isset($res['error']) && $res['error'] === 'connection_disconnected') {
        linkup_forget_connection();   // the store disconnected in LINKUP: stop sending anything
        return false;
    }
    if ($code !== 200 || empty($res['ok'])) {
        update_option(LINKUP_OPT_LAST, array('ok' => false, 'code' => $code, 'at' => time()), false);
        return false;
    }
    $created = 0;
    foreach ((array) $res['result']['coupons'] as $c) {
        $created += linkup_apply_coupon((string) $c['code'], (int) $c['discount_pct'], !empty($c['active'])) ? 1 : 0;
    }
    // Reconciliation: resend recently modified orders (deterministic ids → server de-duplicates).
    $last = get_option(LINKUP_OPT_LAST, array());
    $since = !empty($last['ok']) ? (int) $last['at'] - 300 : time() - 2 * DAY_IN_SECONDS;
    $orders = wc_get_orders(array('type' => 'shop_order', 'date_modified' => '>' . $since, 'limit' => 50, 'return' => 'ids'));
    foreach ($orders as $id) {
        linkup_send_order_now($id, 0); // deterministic event ids → server ignores duplicates
    }
    linkup_products_full_pass_step();
    update_option(LINKUP_OPT_LAST, array('ok' => true, 'code' => 200, 'at' => time(), 'coupons' => count((array) $res['result']['coupons'])), false);
    return true;
}
add_action('linkup_sync', 'linkup_sync');

/* ------------------------------------------------------------------
 * 3b. Products & stock (catalogue for creators). Read-only towards the store:
 *     LINKUP never changes products. Changed products are sent at the end of the
 *     request; a full pass (100 per sync) runs every 6 hours to catch everything else.
 * ------------------------------------------------------------------ */
function linkup_product_payload($product) {
    if (!$product || $product->get_type() === 'variation') {
        return null;
    }
    $image = '';
    $img_id = $product->get_image_id();
    if ($img_id) {
        $image = (string) wp_get_attachment_image_url($img_id, 'large');
        $image = set_url_scheme($image, 'https');
    }
    $cats = array();
    foreach ((array) wc_get_product_terms($product->get_id(), 'product_cat', array('fields' => 'names')) as $n) {
        $cats[] = (string) $n;
    }
    $price = $product->get_price();
    return array(
        'id'        => (string) $product->get_id(),
        'name'      => wp_strip_all_tags($product->get_name()),
        'url'       => (string) get_permalink($product->get_id()),
        'image'     => $image,
        'price'     => $price === '' ? null : linkup_to_minor($price),
        'currency'  => get_woocommerce_currency(),
        'in_stock'  => $product->is_in_stock(),
        'stock_qty' => $product->managing_stock() ? (int) $product->get_stock_quantity() : null,
        'categories'=> array_slice($cats, 0, 10),
        'status'    => $product->get_status() === 'publish' && $product->get_catalog_visibility() !== 'hidden' ? 'publish' : 'hidden',
    );
}

/**
 * Fire-and-forget signed POST for product updates: the admin's "save product" never waits for LINKUP.
 * Anything lost here is picked up by the periodic full catalogue pass. (Order events keep using linkup_post.)
 */
function linkup_post_nowait(array $payload) {
    $cred = linkup_credentials();
    if (!$cred) {
        return false;
    }
    $body = wp_json_encode($payload);
    $ts = time();
    wp_remote_post(LINKUP_ENDPOINT, array(
        'timeout'  => 0.01,
        'blocking' => false,
        'headers'  => array(
            'Content-Type'        => 'application/json',
            'X-Linkup-Connection' => $cred[0],
            'X-Linkup-Timestamp'  => (string) $ts,
            'X-Linkup-Signature'  => linkup_sign($body, $ts, $cred[1]),
        ),
        'body'     => $body,
    ));
    return true;
}

function linkup_send_products(array $ids, $full_started_at = null, $nowait = false) {
    $items = array();
    foreach (array_unique(array_map('intval', $ids)) as $id) {
        $p = linkup_product_payload(wc_get_product($id));
        if ($p) {
            $items[] = $p;
        }
    }
    if (!$items && !$full_started_at) {
        return true;
    }
    $payload = array('action' => 'products', 'products' => $items);
    if ($full_started_at) {
        $payload['full_started_at'] = gmdate('c', (int) $full_started_at - 600); // tolerate clock skew
    }
    if ($nowait) {
        return linkup_post_nowait($payload);
    }
    list($code) = linkup_post($payload);
    return $code === 200;
}

$GLOBALS['linkup_product_queue'] = array();
function linkup_queue_product($id) {
    $product = wc_get_product($id);
    if ($product && $product->get_type() === 'variation') {
        $id = $product->get_parent_id();
    }
    if ($id) {
        $GLOBALS['linkup_product_queue'][(int) $id] = true;
    }
}
add_action('woocommerce_update_product', 'linkup_queue_product');
add_action('woocommerce_new_product', 'linkup_queue_product');
add_action('woocommerce_product_set_stock', static function ($product) { linkup_queue_product($product->get_id()); });
add_action('woocommerce_variation_set_stock', static function ($product) { linkup_queue_product($product->get_id()); });
add_action('woocommerce_product_set_stock_status', 'linkup_queue_product');
add_action('trashed_post', static function ($post_id) {
    if (get_post_type($post_id) === 'product') {
        linkup_queue_product($post_id);
    }
});
add_action('shutdown', static function () {
    $ids = array_keys($GLOBALS['linkup_product_queue']);
    if ($ids && linkup_credentials()) {
        foreach (array_chunk($ids, 50) as $chunk) {
            linkup_send_products($chunk, null, true);
        }
    }
}, 20);

/** One page of the periodic full pass. State: started_at, page. */
function linkup_products_full_pass_step() {
    $state = get_option('linkup_products_pass', array());
    $now = time();
    if (empty($state['started_at'])) {
        $last_done = isset($state['done_at']) ? (int) $state['done_at'] : 0;
        if ($now - $last_done < 6 * HOUR_IN_SECONDS) {
            return;
        }
        $state = array('started_at' => $now, 'page' => 1);
    }
    $ids = wc_get_products(array('status' => array('publish', 'private', 'draft'), 'type' => array('simple', 'variable', 'grouped', 'external'),
                                 'limit' => 100, 'page' => (int) $state['page'], 'return' => 'ids', 'orderby' => 'ID', 'order' => 'ASC'));
    $last = count($ids) < 100;
    if (!linkup_send_products($ids, $last ? $state['started_at'] : null)) {
        return; // retry the same page next sync
    }
    if ($last) {
        update_option('linkup_products_pass', array('done_at' => $now), false);
    } else {
        $state['page'] = (int) $state['page'] + 1;
        update_option('linkup_products_pass', $state, false);
    }
}

/** Create or update a LINKUP-managed coupon. Never touches coupons the store created itself. */
function linkup_apply_coupon($code, $pct, $active) {
    if (!preg_match('/^[A-Z0-9]{4,16}$/', $code)) {
        return false;
    }
    $id = wc_get_coupon_id_by_code($code);
    $coupon = new WC_Coupon($id ? $id : 0);
    if ($id && $coupon->get_meta('_linkup_managed') !== '1') {
        return false;
    }
    $changed = !$id;
    if (!$id) {
        $coupon->set_code($code);
        $coupon->set_discount_type('percent');
        $coupon->set_description('LINKUP partner coupon');
        $coupon->update_meta_data('_linkup_managed', '1');
    }
    if ((int) $coupon->get_amount() !== $pct) {
        $coupon->set_amount($pct);
        $changed = true;
    }
    $want = $active ? 'publish' : 'draft';
    if ($coupon->get_status() !== $want) {
        $coupon->set_status($want);
        $changed = true;
    }
    if ($changed) {
        $coupon->save();
    }
    return !$id;
}

/* ------------------------------------------------------------------
 * 4. Settings page: one field (connection key) + "sync now".
 * ------------------------------------------------------------------ */
add_action('admin_menu', static function () {
    add_submenu_page('woocommerce', 'LINKUP', 'LINKUP', 'manage_woocommerce', 'linkup', 'linkup_settings_page');
});

function linkup_settings_page() {
    if (!current_user_can('manage_woocommerce')) {
        return;
    }
    $notice = '';
    if (isset($_POST['linkup_nonce']) && wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['linkup_nonce'])), 'linkup_save')) {
        $key = isset($_POST['linkup_key']) ? trim(sanitize_text_field(wp_unslash($_POST['linkup_key']))) : '';
        if (isset($_POST['linkup_disconnect'])) {
            linkup_forget_connection();
            $notice = __('Disconnected. LINKUP partner coupons were set to draft; your history in LINKUP is kept.', 'linkup-connector');
        } elseif ($key !== '') {
            if (preg_match('/^lk_[0-9a-f]{32}_[0-9a-f]{64}$/', $key)) {
                update_option(LINKUP_OPT_KEY, $key, false);
                $notice = linkup_sync()
                    ? __('Connected! Your store is in sync with LINKUP.', 'linkup-connector')
                    : __('The key was saved, but the connection failed. Make sure you copied the whole key.', 'linkup-connector');
            } else {
                $notice = __('Invalid key. Copy it again from LINKUP.', 'linkup-connector');
            }
        }
        if (isset($_POST['linkup_sync_now']) && $key === '') {
            $notice = linkup_sync() ? __('Synced.', 'linkup-connector') : __('Sync failed.', 'linkup-connector');
        }
    }
    $connected = (bool) linkup_credentials();
    $last = get_option(LINKUP_OPT_LAST, array());
    $status = $connected
        ? (!empty($last['ok']) ? __('Connected ✓', 'linkup-connector') : __('Key saved – waiting for the first sync', 'linkup-connector'))
        : __('Not connected', 'linkup-connector');
    ?>
    <div class="wrap" style="max-width:640px">
        <h1>LINKUP</h1>
        <?php if ($notice) : ?><div class="notice notice-info"><p><?php echo esc_html($notice); ?></p></div><?php endif; ?>
        <p><?php esc_html_e('Status:', 'linkup-connector'); ?> <strong><?php echo esc_html($status); ?></strong>
        <?php if (!empty($last['at'])) : ?> · <?php esc_html_e('Last sync:', 'linkup-connector'); ?> <?php echo esc_html(wp_date('d/m/Y H:i', (int) $last['at'])); ?><?php endif; ?></p>
        <form method="post">
            <?php wp_nonce_field('linkup_save', 'linkup_nonce'); ?>
            <p><label for="linkup_key"><strong><?php esc_html_e('Connection key', 'linkup-connector'); ?></strong> <?php esc_html_e('(copy it from LINKUP)', 'linkup-connector'); ?></label></p>
            <p><input type="password" id="linkup_key" name="linkup_key" class="large-text" autocomplete="off"
                      placeholder="<?php echo esc_attr($connected ? __('•••••• (saved). To replace it, paste a new key', 'linkup-connector') : 'lk_...'); ?>"></p>
            <p><button class="button button-primary"><?php esc_html_e('Save and connect', 'linkup-connector'); ?></button>
            <?php if ($connected) : ?> <button class="button" name="linkup_sync_now" value="1"><?php esc_html_e('Sync now', 'linkup-connector'); ?></button>
            <button class="button-link-delete" name="linkup_disconnect" value="1" onclick="return confirm(<?php echo esc_attr(wp_json_encode(__('Disconnect this store from LINKUP?', 'linkup-connector'))); ?>)"><?php esc_html_e('Disconnect', 'linkup-connector'); ?></button><?php endif; ?></p>
        </form>
        <p class="description"><?php esc_html_e('When a visitor arrives through a LINKUP creator link, this plugin sets the first-party cookie "linkup_ref" (creator code and visit time, 30 days) to credit the sale. Mention it in your cookie notice. If your consent banner supports the WP Consent API, the cookie is set only after marketing consent.', 'linkup-connector'); ?></p>
    </div>
    <?php
}

/* ------------------------------------------------------------------
 * 6. Remote setup for "one approval" onboarding (no manual install, no key copying).
 *    LINKUP authenticates as the approving store manager (WordPress application password, revoked by LINKUP
 *    right after setup), installs this plugin from WordPress.org, then calls these routes to save the key.
 *    Only users who can manage WooCommerce may call them; the key itself is never returned.
 * ------------------------------------------------------------------ */
/** Partner coupons created by LINKUP go back to draft (kept, not deleted) – no active discount stays behind untracked. */
function linkup_pause_managed_coupons() {
    // Runs only on disconnect; coupons are few and the query is bounded.
    $ids = get_posts(array('post_type' => 'shop_coupon', 'post_status' => 'publish', 'numberposts' => 500, 'fields' => 'ids',
                           'meta_key' => '_linkup_managed', 'meta_value' => '1')); // phpcs:ignore WordPress.DB.SlowDBQuery
    foreach ($ids as $id) {
        wp_update_post(array('ID' => $id, 'post_status' => 'draft'));
    }
    return count($ids);
}

function linkup_forget_connection() {
    linkup_pause_managed_coupons();
    delete_option(LINKUP_OPT_KEY);
    update_option(LINKUP_OPT_LAST, array('ok' => false, 'code' => 'disconnected', 'at' => time()), false);
    if (function_exists('as_unschedule_all_actions')) {
        as_unschedule_all_actions('linkup_sync');
    }
}

function linkup_rest_can_manage() {
    return current_user_can('manage_woocommerce');
}

function linkup_rest_status() {
    $last = get_option(LINKUP_OPT_LAST, array());
    return array('version' => LINKUP_VERSION, 'connected' => (bool) linkup_credentials(),
                 'consent_api' => function_exists('wp_has_consent'), 'consent_mode' => get_option('linkup_consent_mode', 'notice'),
                 'last_ok' => !empty($last['ok']), 'last_at' => isset($last['at']) ? (int) $last['at'] : null);
}

function linkup_rest_connect($request) {
    $key = trim((string) $request->get_param('key'));
    if (!preg_match('/^lk_[0-9a-f]{32}_[0-9a-f]{64}$/', $key)) {
        return new WP_Error('linkup_invalid_key', 'Invalid connection key', array('status' => 400));
    }
    $mode = (string) $request->get_param('consent_mode');
    if (in_array($mode, array('notice', 'require'), true)) {
        update_option('linkup_consent_mode', $mode, false);
    }
    update_option(LINKUP_OPT_KEY, $key, false);
    $synced = linkup_sync();
    return array_merge(linkup_rest_status(), array('synced' => (bool) $synced));
}

add_action('rest_api_init', static function () {
    register_rest_route('linkup/v1', '/status', array(
        'methods' => 'GET', 'callback' => 'linkup_rest_status', 'permission_callback' => 'linkup_rest_can_manage'));
    register_rest_route('linkup/v1', '/connect', array(
        'methods' => 'POST', 'callback' => 'linkup_rest_connect', 'permission_callback' => 'linkup_rest_can_manage',
        'args' => array('key' => array('required' => true, 'type' => 'string'),
                        'consent_mode' => array('type' => 'string', 'enum' => array('notice', 'require')))));
});

register_deactivation_hook(__FILE__, static function () {
    if (function_exists('as_unschedule_all_actions')) {
        as_unschedule_all_actions('linkup_sync');
    }
});

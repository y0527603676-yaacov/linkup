<?php
/**
 * Plugin Name: LINKUP Connector
 * Description: מחבר את חנות ה-WooCommerce ל-LINKUP — קופונים לשותפים, מעקב הפניות ודיווח מכירות מאובטח.
 * Version: 0.2.1
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * WC requires at least: 8.0
 * Text Domain: linkup-connector
 */

defined('ABSPATH') || exit;

define('LINKUP_VERSION', '0.2.1');
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
 * ------------------------------------------------------------------ */
add_action('init', static function () {
    if (empty($_GET['lku'])) {
        return;
    }
    $code = preg_replace('/[^A-Za-z0-9]/', '', (string) wp_unslash($_GET['lku']));
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

add_action('woocommerce_checkout_order_created', static function ($order) {
    if (!empty($_COOKIE[LINKUP_COOKIE])) {
        $raw = sanitize_text_field(wp_unslash($_COOKIE[LINKUP_COOKIE]));
        if (preg_match('/^[A-Za-z0-9]{4,16}\|[0-9]{9,11}$/', $raw)) {
            $order->update_meta_data('_linkup_ref', $raw);
            $order->save();
        }
    }
});

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
    update_option(LINKUP_OPT_LAST, array('ok' => true, 'code' => 200, 'at' => time(), 'coupons' => count((array) $res['result']['coupons'])), false);
    return true;
}
add_action('linkup_sync', 'linkup_sync');

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
            delete_option(LINKUP_OPT_KEY);
            delete_option(LINKUP_OPT_LAST);
            if (function_exists('as_unschedule_all_actions')) {
                as_unschedule_all_actions('linkup_sync');
            }
            $notice = 'החיבור נותק. הקופונים הקיימים וההיסטוריה ב-LINKUP נשמרו.';
        } elseif ($key !== '') {
            if (preg_match('/^lk_[0-9a-f]{32}_[0-9a-f]{64}$/', $key)) {
                update_option(LINKUP_OPT_KEY, $key, false);
                $notice = linkup_sync() ? 'מחובר! החנות מסונכרנת עם LINKUP.' : 'המפתח נשמר, אבל החיבור נכשל. ודאו שהעתקתם את המפתח המלא.';
            } else {
                $notice = 'מפתח לא תקין. העתיקו אותו שוב מ-LINKUP.';
            }
        }
        if (isset($_POST['linkup_sync_now']) && $key === '') {
            $notice = linkup_sync() ? 'סונכרן בהצלחה.' : 'הסנכרון נכשל.';
        }
    }
    $connected = (bool) linkup_credentials();
    $last = get_option(LINKUP_OPT_LAST, array());
    ?>
    <div class="wrap" dir="rtl" style="max-width:640px">
        <h1>LINKUP</h1>
        <?php if ($notice) : ?><div class="notice notice-info"><p><?php echo esc_html($notice); ?></p></div><?php endif; ?>
        <p>מצב: <strong><?php echo $connected ? (!empty($last['ok']) ? 'מחובר ✓' : 'מפתח שמור — ממתין לסנכרון') : 'לא מחובר'; ?></strong>
        <?php if (!empty($last['at'])) : ?> · סנכרון אחרון: <?php echo esc_html(wp_date('d/m/Y H:i', (int) $last['at'])); ?><?php endif; ?></p>
        <form method="post">
            <?php wp_nonce_field('linkup_save', 'linkup_nonce'); ?>
            <p><label for="linkup_key"><strong>מפתח חיבור</strong> (מעתיקים מ-LINKUP)</label></p>
            <p><input type="password" id="linkup_key" name="linkup_key" class="large-text" autocomplete="off"
                      placeholder="<?php echo $connected ? '•••••• (שמור). להחלפה — הדביקו מפתח חדש' : 'lk_...'; ?>"></p>
            <p><button class="button button-primary">שמירה וחיבור</button>
            <?php if ($connected) : ?> <button class="button" name="linkup_sync_now" value="1">סנכרון עכשיו</button>
            <button class="button-link-delete" name="linkup_disconnect" value="1" onclick="return confirm('לנתק את החנות מ-LINKUP?')">ניתוק</button><?php endif; ?></p>
        </form>
    </div>
    <?php
}

register_deactivation_hook(__FILE__, static function () {
    if (function_exists('as_unschedule_all_actions')) {
        as_unschedule_all_actions('linkup_sync');
    }
});

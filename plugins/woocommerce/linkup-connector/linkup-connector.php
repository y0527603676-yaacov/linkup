<?php
/**
 * Plugin Name: LINKUP Connector
 * Description: Connects a WooCommerce store to LINKUP — partner coupons, referral tracking and signed order events.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * WC requires at least: 8.0
 * Text Domain: linkup-connector
 */

defined('ABSPATH') || exit;

const LINKUP_OPT = 'linkup_connector_settings';
const LINKUP_COOKIE = 'linkup_ref';
const LINKUP_COOKIE_DAYS = 30;

/* HPOS (custom order tables) compatibility — we only use WC CRUD APIs. */
add_action('before_woocommerce_init', static function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
    }
});

function linkup_settings(): array {
    $s = get_option(LINKUP_OPT, []);
    return is_array($s) ? $s : [];
}

/** Signature = hex(HMAC-SHA256(secret, "{timestamp}.{body}")) — must match apps/web signature.ts */
function linkup_sign(string $body, int $ts, string $secret): string {
    return hash_hmac('sha256', $ts . '.' . $body, $secret);
}

/* ---- Referral click capture: ?lku=CODE → first-party cookie ---- */
add_action('init', static function () {
    if (empty($_GET['lku'])) {
        return;
    }
    $code = preg_replace('/[^A-Za-z0-9_-]/', '', (string) wp_unslash($_GET['lku']));
    if ($code === '' || strlen($code) > 64) {
        return;
    }
    setcookie(LINKUP_COOKIE, $code . '|' . time(), [
        'expires'  => time() + LINKUP_COOKIE_DAYS * DAY_IN_SECONDS,
        'path'     => '/',
        'secure'   => is_ssl(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
});

/* Persist the referral on the order itself (HPOS-safe meta API). */
add_action('woocommerce_checkout_order_created', static function ($order) {
    if (!empty($_COOKIE[LINKUP_COOKIE])) {
        $raw = sanitize_text_field(wp_unslash($_COOKIE[LINKUP_COOKIE]));
        $order->update_meta_data('_linkup_ref', $raw);
        $order->save();
    }
});

/* ---- Order events → LINKUP (async via Action Scheduler; retried) ---- */
function linkup_queue_order_event(int $order_id, string $type, array $extra = []): void {
    if (!function_exists('as_enqueue_async_action')) {
        return;
    }
    as_enqueue_async_action('linkup_send_order_event', [[
        'order_id' => $order_id,
        'type'     => $type,
        'event_id' => wp_generate_uuid4(),
        'at'       => time(),
        'extra'    => $extra,
    ]], 'linkup');
}

add_action('woocommerce_new_order', static fn ($id) => linkup_queue_order_event((int) $id, 'order.upserted'));
add_action('woocommerce_order_status_changed', static fn ($id) => linkup_queue_order_event((int) $id, 'order.upserted'));
add_action('woocommerce_order_refunded', static fn ($id, $refund_id) => linkup_queue_order_event((int) $id, 'order.refunded', ['refund_id' => (int) $refund_id]), 10, 2);

add_action('linkup_send_order_event', static function (array $job) {
    $s = linkup_settings();
    if (empty($s['endpoint']) || empty($s['secret']) || empty($s['connection_id'])) {
        return;
    }
    $order = wc_get_order($job['order_id']);
    if (!$order) {
        return;
    }
    $to_minor = static fn ($v) => (int) round(((float) $v) * 100);
    $payload = [
        'event_id'    => $job['event_id'],
        'type'        => $job['type'],
        'occurred_at' => gmdate('c', (int) $job['at']),
        'order'       => [
            'id'            => (string) $order->get_id(),
            'status'        => $order->get_status(),
            'currency'      => $order->get_currency(),
            'total'         => $to_minor($order->get_total()),
            'tax'           => $to_minor($order->get_cart_tax()),
            'shipping'      => $to_minor($order->get_shipping_total()),
            'shipping_tax'  => $to_minor($order->get_shipping_tax()),
            'coupons'       => array_values($order->get_coupon_codes()),
            'ref'           => (string) $order->get_meta('_linkup_ref'),
            'email_hash'    => hash('sha256', strtolower(trim((string) $order->get_billing_email()))),
            'created_at'    => $order->get_date_created() ? $order->get_date_created()->format('c') : null,
        ],
        'extra'       => $job['extra'],
    ];
    if ($job['type'] === 'order.refunded' && !empty($job['extra']['refund_id'])) {
        $refund = wc_get_order($job['extra']['refund_id']);
        if ($refund) {
            $payload['refund'] = ['id' => (string) $refund->get_id(), 'amount' => $to_minor($refund->get_amount())];
        }
    }
    $body = wp_json_encode($payload);
    $ts = time();
    $res = wp_remote_post($s['endpoint'], [
        'timeout' => 10,
        'headers' => [
            'Content-Type'          => 'application/json',
            'X-Linkup-Connection'   => $s['connection_id'],
            'X-Linkup-Timestamp'    => (string) $ts,
            'X-Linkup-Signature'    => linkup_sign($body, $ts, $s['secret']),
        ],
        'body'    => $body,
    ]);
    $code = is_wp_error($res) ? 0 : (int) wp_remote_retrieve_response_code($res);
    if ($code < 200 || $code >= 300) {
        // Throwing makes Action Scheduler mark it failed; LINKUP's hourly reconciliation covers gaps.
        throw new \RuntimeException('LINKUP delivery failed: HTTP ' . $code);
    }
});

/* Phase 1 adds: connect flow (one-time code), signed REST endpoints for coupon create/disable,
   heartbeat, reconciliation listing, admin settings page, and safe disconnect. */

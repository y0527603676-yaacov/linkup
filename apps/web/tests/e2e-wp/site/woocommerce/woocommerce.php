<?php
/**
 * Plugin Name: WooCommerce
 * Description: ISOLATED TEST STAND-IN ONLY – minimal order storage and the hooks the LINKUP plugin uses (real WooCommerce cannot be downloaded in this sandbox).
 * Version: 9.0.0
 */
register_activation_hook(__FILE__, function () { get_role('administrator')->add_cap('manage_woocommerce'); });
class Linkup_Test_Order {
    public $d;
    function __construct(array $d) { $this->d = $d; }
    function get_meta($k) { return $this->d['meta'][$k] ?? ''; }
    function update_meta_data($k, $v) { $this->d['meta'][$k] = $v; }
    function save() { $all = get_option('wc_test_orders', []); $all[$this->d['id']] = $this->d; update_option('wc_test_orders', $all, false); }
    function get_refunds() { return []; } function get_id() { return $this->d['id']; } function get_status() { return 'processing'; } function get_type() { return 'shop_order'; }
    function get_currency() { return 'ILS'; } function get_total() { return '118.00'; } function get_cart_tax() { return '18.00'; }
    function get_shipping_total() { return '0'; } function get_shipping_tax() { return '0'; } function get_coupon_codes() { return $this->d['coupons']; }
    function get_billing_email() { return 'buyer@example.test'; }
    function get_date_created() { return new DateTime('@' . $this->d['created']); } function get_date_modified() { return new DateTime('@' . $this->d['created']); }
}
function linkup_test_create_order(array $coupons) {
    $all = get_option('wc_test_orders', []); $id = 1000 + count($all) + 1;
    $o = new Linkup_Test_Order(['id' => $id, 'coupons' => $coupons, 'created' => time(), 'meta' => []]); $o->save(); return $o;
}
function wc_get_order($id) { $all = get_option('wc_test_orders', []); return isset($all[$id]) ? new Linkup_Test_Order($all[$id]) : false; }
function wc_get_orders($a) { return []; }
function wc_get_products($a) { return []; }
function get_woocommerce_currency() { return 'ILS'; }
/* Coupons (stand-in): stored like WooCommerce does – posts of type shop_coupon with post meta. */
add_action('init', function () { register_post_type('shop_coupon', ['public' => false]); });
function wc_get_coupon_id_by_code($code) { $p = get_posts(['post_type' => 'shop_coupon', 'title' => $code, 'post_status' => 'any', 'numberposts' => 1, 'fields' => 'ids']); return $p ? $p[0] : 0; }
class WC_Coupon {
    public $id; public $d;
    function __construct($id = 0) {
        $this->id = $id; $p = $id ? get_post($id) : null;
        $this->d = $p ? ['code' => $p->post_title, 'status' => $p->post_status, 'desc' => $p->post_excerpt, 'amount' => (int) get_post_meta($id, 'coupon_amount', true),
                         'type' => get_post_meta($id, 'discount_type', true), 'meta' => ['_linkup_managed' => get_post_meta($id, '_linkup_managed', true)]]
                      : ['code' => '', 'type' => '', 'amount' => 0, 'status' => 'draft', 'meta' => [], 'desc' => ''];
    }
    function get_meta($k) { return $this->d['meta'][$k] ?? ''; } function update_meta_data($k, $v) { $this->d['meta'][$k] = $v; }
    function set_code($c) { $this->d['code'] = $c; } function set_discount_type($t) { $this->d['type'] = $t; } function set_description($t) { $this->d['desc'] = $t; }
    function get_amount() { return $this->d['amount']; } function set_amount($a) { $this->d['amount'] = $a; }
    function get_status() { return $this->d['status']; } function set_status($s) { $this->d['status'] = $s; }
    function save() {
        $post = ['post_type' => 'shop_coupon', 'post_title' => $this->d['code'], 'post_status' => $this->d['status'], 'post_excerpt' => $this->d['desc']];
        if ($this->id) { $post['ID'] = $this->id; wp_update_post($post); } else { $this->id = wp_insert_post($post); }
        update_post_meta($this->id, 'coupon_amount', $this->d['amount']); update_post_meta($this->id, 'discount_type', $this->d['type']);
        foreach ($this->d['meta'] as $k => $v) update_post_meta($this->id, $k, $v);
        return $this->id;
    }
}
function linkup_test_coupons() {
    return array_map(fn($id) => (new WC_Coupon($id))->d, get_posts(['post_type' => 'shop_coupon', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids']));
}

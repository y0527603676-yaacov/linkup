<?php
// Stub harness for LINKUP Connector 0.3.0 — runs the real plugin code against fake WordPress/WooCommerce.
define('ABSPATH', '/tmp/');
define('HOUR_IN_SECONDS', 3600);
$GLOBALS['hooks'] = []; $GLOBALS['opts'] = ['linkup_connection_key' => 'lk_' . str_repeat('a', 32) . '_' . str_repeat('b', 64)];
$GLOBALS['sent'] = []; $GLOBALS['http_code'] = 200;
function add_action($h, $cb, $p = 10) { $GLOBALS['hooks'][$h][] = $cb; }
function add_filter($h, $cb, $p = 10) { $GLOBALS['hooks'][$h][] = $cb; }
function do_hook($h, ...$a) { foreach ($GLOBALS['hooks'][$h] ?? [] as $cb) $cb(...$a); }
function register_deactivation_hook($f, $cb) {}
function register_rest_route($ns, $route, $args) { $GLOBALS['routes']["$ns$route"] = $args; }
function current_user_can($cap) { return ($GLOBALS['caps'] ?? []) && in_array($cap, $GLOBALS['caps'], true); }
class WP_Error { function __construct(public $code = '', public $message = '', public $data = []) {} }
class WP_REST_Request { function __construct(private $p = []) {} function get_param($k) { return $this->p[$k] ?? null; } }
function get_option($k, $d = false) { return $GLOBALS['opts'][$k] ?? $d; }
function update_option($k, $v, $a = null) { $GLOBALS['opts'][$k] = $v; return true; }
function delete_option($k) { unset($GLOBALS['opts'][$k]); }
function wp_json_encode($v) { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
function wp_remote_post($url, $args) { $GLOBALS['sent'][] = ['url' => $url, 'args' => $args]; return ['code' => $GLOBALS['http_code'], 'body' => $GLOBALS['http_body_override'] ?? '{"ok":true,"result":{"coupons":[]}}']; }
if (!defined('DAY_IN_SECONDS')) define('DAY_IN_SECONDS', 86400);
if (!defined('MINUTE_IN_SECONDS')) define('MINUTE_IN_SECONDS', 60);
function wc_get_orders($a) { return []; }
function linkup_send_order_now_stub() {}
function wp_remote_retrieve_response_code($r) { return $r['code']; }
function wp_remote_retrieve_body($r) { return $r['body']; }
function is_wp_error($r) { return false; }
function wp_strip_all_tags($s) { return trim(strip_tags($s)); }
function get_permalink($id) { return "https://heleni-jewelry.com/product/p$id/"; }
function wp_get_attachment_image_url($id, $size) { return "http://heleni-jewelry.com/wp-content/uploads/img$id.jpg"; }
function set_url_scheme($u, $s) { return preg_replace('#^http://#', 'https://', $u); }
function get_woocommerce_currency() { return 'ILS'; }
function wc_get_product_terms($id, $tax, $a) { return ['טבעות']; }
function get_post_type($id) { return 'product'; }
function load_plugin_textdomain(...$a) { return true; } function plugin_basename($f) { return 'linkup-connector/linkup-connector.php'; } function __($t, $d = null) { return $t; }
$GLOBALS['coupon_posts'] = [];
function get_posts($a) { return array_keys(array_filter($GLOBALS['coupon_posts'], fn($c) => $c['status'] === ($a['post_status'] ?? 'publish') && ($c['meta']['_linkup_managed'] ?? '') === '1')); }
function wp_update_post($a) { $GLOBALS['coupon_posts'][$a['ID']]['status'] = $a['post_status']; return $a['ID']; }
function as_has_scheduled_action(...$a) { return false; }
function as_schedule_recurring_action(...$a) {} function as_schedule_single_action(...$a) {} function as_unschedule_all_actions(...$a) {}
class FakeProduct {
  function __construct(public $id, public $type = 'simple', public $price = '199', public $stock = true, public $qty = 5, public $status = 'publish', public $vis = 'visible', public $img = 1, public $parent = 0) {}
  function get_id() { return $this->id; } function get_type() { return $this->type; } function get_name() { return "<b>מוצר {$this->id}</b>"; }
  function get_image_id() { return $this->img; } function get_price() { return $this->price; } function is_in_stock() { return $this->stock; }
  function managing_stock() { return $this->qty !== null; } function get_stock_quantity() { return $this->qty; }
  function get_status() { return $this->status; } function get_catalog_visibility() { return $this->vis; } function get_parent_id() { return $this->parent; }
}
$GLOBALS['catalog'] = [];
for ($i = 1; $i <= 250; $i++) $GLOBALS['catalog'][$i] = new FakeProduct($i, 'simple', (string)(100 + $i) . '.90', $i % 10 !== 0, $i % 10 === 0 ? 0 : 7);
$GLOBALS['catalog'][3] = new FakeProduct(3, 'variable', '', true, null, 'publish', 'visible', 0);
$GLOBALS['catalog'][4] = new FakeProduct(4, 'simple', '89', true, 2, 'draft');
$GLOBALS['catalog'][5] = new FakeProduct(5, 'simple', '89', true, 2, 'publish', 'hidden');
$GLOBALS['catalog'][900] = new FakeProduct(900, 'variation', '50', true, 1, 'publish', 'visible', 1, 6);
function wc_get_product($id) { return $GLOBALS['catalog'][$id] ?? null; }
function wc_get_products($a) { $ids = array_keys(array_filter($GLOBALS['catalog'], fn($p) => $p->type !== 'variation')); sort($ids); return array_slice($ids, ($a['page'] - 1) * $a['limit'], $a['limit']); }
require __DIR__ . '/linkup-connector/linkup-connector.php';

$fail = 0; $ok = function ($c, $m) use (&$fail) { echo ($c ? "PASS " : "FAIL ") . $m . "\n"; if (!$c) $fail++; };
// 1. payloads
$p1 = linkup_product_payload(wc_get_product(1));
$ok($p1['price'] === 10190 && $p1['currency'] === 'ILS' && $p1['in_stock'] === true && $p1['stock_qty'] === 7, 'simple product: price 101.90 → 10190 minor, stock 7');
$ok(str_starts_with($p1['image'], 'https://'), 'image forced to https');
$ok($p1['name'] === 'מוצר 1', 'HTML stripped from name');
$ok(linkup_product_payload(wc_get_product(10))['in_stock'] === false, 'out-of-stock product reported as not in stock');
$ok(linkup_product_payload(wc_get_product(3))['price'] === null && linkup_product_payload(wc_get_product(3))['image'] === '', 'variable product without price/image handled');
$ok(linkup_product_payload(wc_get_product(4))['status'] === 'hidden' && linkup_product_payload(wc_get_product(5))['status'] === 'hidden', 'draft and hidden products not published to the catalogue');
$ok(linkup_product_payload(wc_get_product(900)) === null, 'variations are not sent on their own');
// 2. change queue → sent at shutdown, signed, batched
$GLOBALS['sent'] = [];
do_hook('woocommerce_update_product', 1); do_hook('woocommerce_update_product', 1); do_hook('woocommerce_variation_set_stock', wc_get_product(900));
do_hook('shutdown');
$prod_posts = array_values(array_filter($GLOBALS['sent'], fn($s) => json_decode($s['args']['body'], true)['action'] === 'products'));
$b = json_decode($prod_posts[0]['args']['body'], true);
$ok(count($prod_posts) === 1 && count($b['products']) === 2, 'one batched request at shutdown (product 1 once + parent of variation)');
$ok($prod_posts[0]['args']['blocking'] === false && $prod_posts[0]['args']['timeout'] < 1, 'product save does not wait for LINKUP (non-blocking request)');
$h = $prod_posts[0]['args']['headers'];
$ok($h['X-Linkup-Signature'] === hash_hmac('sha256', $h['X-Linkup-Timestamp'] . '.' . $prod_posts[0]['args']['body'], str_repeat('b', 64)), 'request signed exactly like order events (HMAC)');
$ok($h['X-Linkup-Connection'] === str_repeat('a', 32) && $prod_posts[0]['url'] === LINKUP_ENDPOINT, 'same endpoint and connection id as v0.2.1');
// 3. full pass: 100 per sync, last page carries full_started_at, failure retries same page
$GLOBALS['sent'] = []; unset($GLOBALS['opts']['linkup_products_pass']);
// order events are untouched: still blocking with retry semantics
$ok(strpos(file_get_contents(__DIR__ . '/linkup-connector/linkup-connector.php'), "'timeout' => 15,") !== false, 'order reporting request unchanged (blocking, 15s, retried on failure)');
linkup_products_full_pass_step(); linkup_products_full_pass_step();
$GLOBALS['http_code'] = 503; linkup_products_full_pass_step(); $ok(get_option('linkup_products_pass')['page'] === 3, 'failed page is retried (does not advance)');
$GLOBALS['http_code'] = 200; linkup_products_full_pass_step();
$bodies = array_map(fn($s) => json_decode($s['args']['body'], true), $GLOBALS['sent']);
$ok(count($bodies) === 4 && count($bodies[0]['products']) <= 100, 'catalogue sent in pages of up to 100');
$ok(!isset($bodies[0]['full_started_at']) && isset($bodies[3]['full_started_at']), 'only the final page closes the full pass');
$ok(isset(get_option('linkup_products_pass')['done_at']), 'pass recorded as done');
$n = count($GLOBALS['sent']); linkup_products_full_pass_step(); $ok(count($GLOBALS['sent']) === $n, 'next full pass waits 6 hours');
// 4. no credentials → nothing sent
$GLOBALS['sent'] = []; $GLOBALS['opts']['linkup_connection_key'] = ''; do_hook('woocommerce_update_product', 2); do_hook('shutdown');
$ok(count($GLOBALS['sent']) === 0, 'disconnected store sends nothing');
// 5. remote setup routes (one-approval onboarding)
do_hook('rest_api_init');
$r = $GLOBALS['routes'];
$ok(isset($r['linkup/v1/connect'], $r['linkup/v1/status']) && $r['linkup/v1/connect']['methods'] === 'POST', 'REST routes registered');
$GLOBALS['caps'] = ['read']; $ok(call_user_func($r['linkup/v1/connect']['permission_callback']) === false, 'a non-manager cannot call the setup route');
$GLOBALS['caps'] = ['manage_woocommerce']; $ok(call_user_func($r['linkup/v1/connect']['permission_callback']) === true, 'a WooCommerce manager can');
$bad = linkup_rest_connect(new WP_REST_Request(['key' => 'lk_nope'])); $ok($bad instanceof WP_Error && $bad->data['status'] === 400, 'malformed key rejected, nothing saved');
$GLOBALS['sent'] = []; $GLOBALS['http_code'] = 200;
$res = linkup_rest_connect(new WP_REST_Request(['key' => 'lk_' . str_repeat('c', 32) . '_' . str_repeat('d', 64)]));
$ok($res['connected'] === true && get_option('linkup_connection_key') === 'lk_' . str_repeat('c', 32) . '_' . str_repeat('d', 64), 'valid key saved and connection started');
$ok(!array_key_exists('key', $res) && strpos(json_encode($res), str_repeat('d', 64)) === false, 'the secret is never returned');
$ok(linkup_rest_status()['version'] === '0.4.1', 'status reports the plugin version');
// 6. visitor consent for the 30-day referral cookie
if (!function_exists('apply_filters')) { function apply_filters($h, $v) { return $v; } }
if (!function_exists('wp_unslash')) { function wp_unslash($v) { return $v; } }
if (!function_exists('is_ssl')) { function is_ssl() { return true; } }
if (!function_exists('sanitize_text_field')) { function sanitize_text_field($v) { return trim((string) $v); } }
$visit = function () { unset($_COOKIE['linkup_ref']); $_GET['lku'] = 'AB12CD'; @do_hook('init'); return $_COOKIE['linkup_ref'] ?? null; };
unset($GLOBALS['opts']['linkup_consent_mode']);
$ok(preg_match('/^AB12CD\|\d{10}$/', (string) $visit()) === 1, 'no consent tool: default "notice" mode sets the cookie');
$GLOBALS['opts']['linkup_consent_mode'] = 'require';
$ok($visit() === null, '"require" mode without a consent tool: no cookie (coupons still work)');
eval('function wp_has_consent($c) { return !empty($GLOBALS["consent"][$c]); }');
$GLOBALS['consent'] = ['marketing' => false];
$ok($visit() === null, 'WP Consent API present and visitor declined marketing: no cookie');
$GLOBALS['consent'] = ['marketing' => true];
$ok(preg_match('/^AB12CD\|/', (string) $visit()) === 1, 'WP Consent API present and visitor agreed: cookie set');
unset($_GET['lku']);
// 7. referral saved on the order for classic AND block checkout
$ok(!empty($GLOBALS['hooks']['woocommerce_checkout_order_created']) && !empty($GLOBALS['hooks']['woocommerce_store_api_checkout_order_processed']), 'both checkout types store the referral');
$o = new class { public $m = []; public $saved = 0; function get_meta($k) { return $this->m[$k] ?? ''; } function update_meta_data($k, $v) { $this->m[$k] = $v; } function save() { $this->saved++; } };
$_COOKIE['linkup_ref'] = 'AB12CD|' . (time() - 7 * 86400);
linkup_attach_ref($o);
$ok($o->m['_linkup_ref'] === $_COOKIE['linkup_ref'], 'a referral from 7 days ago is written to the order');
$_COOKIE['linkup_ref'] = 'ZZ99ZZ|' . time(); linkup_attach_ref($o);
$ok(str_starts_with($o->m['_linkup_ref'], 'AB12CD|') && $o->saved === 1, 'an order keeps its first referral (no double write from the second checkout hook)');
// 8. disconnected in LINKUP → the plugin stops by itself
$GLOBALS['opts']['linkup_connection_key'] = 'lk_' . str_repeat('c', 32) . '_' . str_repeat('d', 64);
$GLOBALS['coupon_posts'] = [11 => ['status' => 'publish', 'meta' => ['_linkup_managed' => '1']], 12 => ['status' => 'publish', 'meta' => []]];
$GLOBALS['http_body_override'] = '{"error":"connection_disconnected"}'; $GLOBALS['http_code'] = 422;
$ok(linkup_sync() === false && empty($GLOBALS['opts']['linkup_connection_key']), 'disconnect in LINKUP clears the key; nothing more is sent');
$ok($GLOBALS['coupon_posts'][11]['status'] === 'draft' && $GLOBALS['coupon_posts'][12]['status'] === 'publish', 'disconnect pauses only LINKUP partner coupons (store coupons untouched)');
unset($GLOBALS['http_body_override']); $GLOBALS['http_code'] = 200;
$GLOBALS['opts']['linkup_connection_key'] = '';
// export a realistic batch for the DB test
$batch = []; foreach ([1, 2, 3, 10, 11, 12, 4, 5] as $id) { $batch[] = linkup_product_payload(wc_get_product($id)); }
file_put_contents(sys_get_temp_dir() . '/linkup-products.json', wp_json_encode($batch));
echo $fail ? "$fail FAILED\n" : "ALL PASSED\n";

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
function get_option($k, $d = false) { return $GLOBALS['opts'][$k] ?? $d; }
function update_option($k, $v, $a = null) { $GLOBALS['opts'][$k] = $v; return true; }
function delete_option($k) { unset($GLOBALS['opts'][$k]); }
function wp_json_encode($v) { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
function wp_remote_post($url, $args) { $GLOBALS['sent'][] = ['url' => $url, 'args' => $args]; return ['code' => $GLOBALS['http_code'], 'body' => '{"ok":true}']; }
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
require '__DIR__ . '/linkup-connector/linkup-connector.php'';

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
$h = $prod_posts[0]['args']['headers'];
$ok($h['X-Linkup-Signature'] === hash_hmac('sha256', $h['X-Linkup-Timestamp'] . '.' . $prod_posts[0]['args']['body'], str_repeat('b', 64)), 'request signed exactly like order events (HMAC)');
$ok($h['X-Linkup-Connection'] === str_repeat('a', 32) && $prod_posts[0]['url'] === LINKUP_ENDPOINT, 'same endpoint and connection id as v0.2.1');
// 3. full pass: 100 per sync, last page carries full_started_at, failure retries same page
$GLOBALS['sent'] = []; unset($GLOBALS['opts']['linkup_products_pass']);
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
// export a realistic batch for the DB test
$batch = []; foreach ([1, 2, 3, 10, 11, 12, 4, 5] as $id) { $batch[] = linkup_product_payload(wc_get_product($id)); }
file_put_contents(sys_get_temp_dir() . '/linkup-products.json', wp_json_encode($batch));
echo $fail ? "$fail FAILED\n" : "ALL PASSED\n";

<?php
/* What the store owner does in WooCommerce admin, performed with WooCommerce's own functions (same hooks):
 *   php owner-action.php complete <order_id> | cancel <order_id> | refund <order_id> <amount> */
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wcreal/site/wp-load.php';
wp_set_current_user(get_user_by('login', 'storeadmin')->ID);
[$_, $action, $id] = $argv; $o = wc_get_order((int) $id);
if (!$o) { fwrite(STDERR, "no order\n"); exit(1); }
if ($action === 'complete') $o->update_status('completed');
elseif ($action === 'cancel') $o->update_status('cancelled');
elseif ($action === 'show') { echo json_encode(['id' => $o->get_id(), 'status' => $o->get_status(), 'total' => $o->get_total(), 'discount' => $o->get_discount_total(), 'coupons' => $o->get_coupon_codes(), 'ref' => $o->get_meta('_linkup_ref')]), "\n"; exit; }
elseif ($action === 'refund') { $r = wc_create_refund(['order_id' => $o->get_id(), 'amount' => $argv[3], 'reason' => 'test refund']); if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); } }
echo json_encode(['id' => $o->get_id(), 'status' => wc_get_order($o->get_id())->get_status()]), "\n";

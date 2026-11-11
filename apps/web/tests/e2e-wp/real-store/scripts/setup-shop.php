<?php
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wcreal/site/wp-load.php';
wp_set_current_user(get_user_by('login', 'storeadmin')->ID);
if (class_exists('WC_Install')) { WC_Install::install(); }
update_option('woocommerce_currency', 'ILS'); update_option('woocommerce_default_country', 'IL'); update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_onboarding_profile', ['skipped' => true]); update_option('woocommerce_coming_soon', 'no'); update_option('woocommerce_store_pages_only', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes'); update_option('woocommerce_enable_coupons', 'yes');
$cod = get_option('woocommerce_cod_settings', []); $cod['enabled'] = 'yes'; update_option('woocommerce_cod_settings', $cod);
if (!wc_get_products(['limit' => 1, 'return' => 'ids'])) {
  foreach ([['טבעת כסף', '199'], ['שרשרת זהב', '450'], ['צמיד חרוזים', '89']] as [$n, $p]) {
    $pr = new WC_Product_Simple(); $pr->set_name($n); $pr->set_regular_price($p); $pr->set_manage_stock(true); $pr->set_stock_quantity(20); $pr->set_status('publish'); $pr->save();
  }
}
echo "WooCommerce " . WC()->version . " | HPOS: " . (get_option('woocommerce_custom_orders_table_enabled') === 'yes' ? 'on' : 'off') . " | products: " . count(wc_get_products(['limit' => -1, 'return' => 'ids'])) . " | cod: " . get_option('woocommerce_cod_settings')['enabled'] . "\n";
if (!WC_Shipping_Zones::get_zones()) {
  $z = new WC_Shipping_Zone(); $z->set_zone_name('ישראל'); $z->add_location('IL', 'country'); $z->save();
  $iid = $z->add_shipping_method('flat_rate'); $s = get_option("woocommerce_flat_rate_{$iid}_settings", []); $s['cost'] = '30'; $s['tax_status'] = 'none'; update_option("woocommerce_flat_rate_{$iid}_settings", $s);
  echo "shipping zone IL flat 30\n";
}

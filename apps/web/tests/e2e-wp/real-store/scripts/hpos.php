<?php
$_SERVER['HTTP_HOST'] = '127.0.0.1:8096'; $_SERVER['REQUEST_URI'] = '/';
require '/var/tmp/wcreal/site/wp-load.php';
use Automattic\WooCommerce\Internal\DataStores\Orders\DataSynchronizer;
use Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController;
$sync = wc_get_container()->get(DataSynchronizer::class);
if (!$sync->check_orders_table_exists()) $sync->create_database_tables();
update_option(CustomOrdersTableController::CUSTOM_ORDERS_TABLE_USAGE_ENABLED_OPTION, $argv[1] ?? 'yes');
echo "HPOS tables: " . ($sync->check_orders_table_exists() ? 'yes' : 'no') . " | enabled: " . get_option(CustomOrdersTableController::CUSTOM_ORDERS_TABLE_USAGE_ENABLED_OPTION) . "\n";

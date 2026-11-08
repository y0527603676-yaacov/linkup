#!/usr/bin/env bash
# Packages the WooCommerce plugin into apps/web/public/downloads for the "connect store" screen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/public/downloads"
mkdir -p "$OUT"
rm -f "$OUT/linkup-connector.zip"
cd "$ROOT/plugins/woocommerce"
zip -qr "$OUT/linkup-connector.zip" linkup-connector -x '*.DS_Store'
echo "built $OUT/linkup-connector.zip"

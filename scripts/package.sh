#!/bin/sh
# Builds the Chrome Web Store upload. The store assigns its own extension ID,
# so the development `key` is stripped from the packaged manifest.
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/tcg-order-printer-$VERSION.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R background.js core.js content.js content.css pdf-bridge.js popup.html popup.css popup.js setup.html setup.css setup.js icons "$STAGE"/
node -e "const m=require('./manifest.json'); delete m.key; require('fs').writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + '\n')" "$STAGE/manifest.json"
mkdir -p dist && rm -f "$OUT"
(cd "$STAGE" && zip -qr -X - .) > "$OUT"
echo "$OUT"

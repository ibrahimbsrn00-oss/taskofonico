#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_CONFIG_PATH="$ROOT_DIR/src-tauri/tauri.conf.json"
APP_NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).productName)" "$TAURI_CONFIG_PATH")"
APP_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$TAURI_CONFIG_PATH")"
ARCH="$(uname -m)"
TARGET_TRIPLE="${TAURI_TARGET_TRIPLE:-}"
TARGET_SUBDIR="${TARGET_TRIPLE:+$TARGET_TRIPLE/}release"
APP_BUNDLE_PATH="$ROOT_DIR/src-tauri/target/${TARGET_SUBDIR}/bundle/macos/${APP_NAME}.app"
DMG_DIR="$ROOT_DIR/src-tauri/target/${TARGET_SUBDIR}/bundle/dmg"
STAGING_DIR="$ROOT_DIR/src-tauri/target/${TARGET_SUBDIR}/bundle/manual-dmg-staging"
OUTPUT_DMG_PATH="$DMG_DIR/${APP_NAME}_${APP_VERSION}_${ARCH}.dmg"

cd "$ROOT_DIR"

if [[ "${SKIP_APP_BUILD:-0}" != "1" ]]; then
  echo "Building macOS .app bundle..."
  BUILD_ARGS=(build --bundles app --no-sign)
  if [[ -n "$TARGET_TRIPLE" ]]; then
    BUILD_ARGS+=(--target "$TARGET_TRIPLE")
  fi
  npx tauri "${BUILD_ARGS[@]}"
else
  echo "Skipping app build and packaging existing bundle..."
fi

if [[ ! -d "$APP_BUNDLE_PATH" ]]; then
  echo "Expected app bundle was not found at: $APP_BUNDLE_PATH" >&2
  exit 1
fi

echo "Preparing DMG staging directory..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

mkdir -p "$DMG_DIR"
rm -f "$OUTPUT_DMG_PATH"

echo "Creating DMG at $OUTPUT_DMG_PATH..."
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$OUTPUT_DMG_PATH"

echo "Manual DMG created successfully:"
echo "$OUTPUT_DMG_PATH"

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
OUTPUT_DIR="$ROOT_DIR/src-tauri/target/${TARGET_SUBDIR}/bundle/installer"
STAGING_ROOT="$OUTPUT_DIR/staging"
PACKAGE_DIR="$STAGING_ROOT/Taskofonico Installer"
OUTPUT_ZIP_PATH="$OUTPUT_DIR/Taskofonico_Installer_${APP_VERSION}_${ARCH}.zip"
INSTALLER_SCRIPT_PATH="$ROOT_DIR/scripts/Install Taskofonico.command"

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

rm -rf "$STAGING_ROOT"
mkdir -p "$PACKAGE_DIR"

ditto "$APP_BUNDLE_PATH" "$PACKAGE_DIR/${APP_NAME}.app"
cp "$INSTALLER_SCRIPT_PATH" "$PACKAGE_DIR/Install Taskofonico.command"
chmod +x "$PACKAGE_DIR/Install Taskofonico.command"

cat > "$PACKAGE_DIR/README.txt" <<'EOF'
1. Arsivi cikar.
2. "Install Taskofonico.command" dosyasina sag tiklayip Open sec.
3. Gerekirse macOS onay penceresinde Open de.
4. Installer uygulamayi Applications klasorune kopyalar ve acar.
EOF

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_ZIP_PATH"

echo "Creating installer zip at $OUTPUT_ZIP_PATH..."
(
  cd "$STAGING_ROOT"
  COPYFILE_DISABLE=1 zip -rqX "$OUTPUT_ZIP_PATH" "Taskofonico Installer"
)

echo "Installer zip created successfully:"
echo "$OUTPUT_ZIP_PATH"

#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="ibrahimbsrn00-oss"
REPO_NAME="taskofonico"
APP_NAME="Taskofonico.app"
RELEASE_API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
ARCH="$(uname -m)"
OS_NAME="$(uname -s)"
TMP_DIR="$(mktemp -d)"
TARGET_DIR="/Applications"
TARGET_APP_PATH="${TARGET_DIR}/${APP_NAME}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "HATA: $1" >&2
  exit 1
}

if [[ "$OS_NAME" != "Darwin" ]]; then
  fail "Bu installer yalnizca macOS icin hazirlandi."
fi

if [[ "$ARCH" != "arm64" ]]; then
  fail "Bu installer su an sadece Apple Silicon (arm64) icin hazir."
fi

echo "Taskofonico son surumu aranıyor..."
release_json="$(curl -fsSL "$RELEASE_API_URL")" || fail "GitHub release bilgisi alinamadi."

download_url="$(printf '%s' "$release_json" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
target = "Taskofonico_aarch64.app.tar.gz"
for asset in payload.get("assets", []):
    if asset.get("name") == target:
        print(asset.get("browser_download_url", ""))
        break
')" || true

release_name="$(printf '%s' "$release_json" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
print(payload.get("name") or payload.get("tag_name") or "latest")
')" || echo "latest"

[[ -n "$download_url" ]] || fail "Uygulama paketi release asset'lari icinde bulunamadi."

archive_path="$TMP_DIR/taskofonico.tar.gz"
extract_dir="$TMP_DIR/extracted"
mkdir -p "$extract_dir"

echo "Indiriliyor: $release_name"
curl -fL "$download_url" -o "$archive_path" || fail "Uygulama arsivi indirilemedi."

echo "Arsiv aciliyor..."
tar -xzf "$archive_path" -C "$extract_dir" || fail "Uygulama arsivi acilamadi."

source_app_path="$(find "$extract_dir" -maxdepth 2 -name "$APP_NAME" -type d | head -n 1)"
[[ -n "$source_app_path" ]] || fail "Arsiv icinde ${APP_NAME} bulunamadi."

if [[ ! -w "$TARGET_DIR" ]]; then
  TARGET_DIR="$HOME/Applications"
  TARGET_APP_PATH="${TARGET_DIR}/${APP_NAME}"
  mkdir -p "$TARGET_DIR"
fi

echo "Kurulum hedefi: $TARGET_DIR"
rm -rf "$TARGET_APP_PATH"
ditto "$source_app_path" "$TARGET_APP_PATH" || fail "Uygulama kopyalanamadi."

xattr -dr com.apple.quarantine "$TARGET_APP_PATH" 2>/dev/null || true
xattr -dr com.apple.provenance "$TARGET_APP_PATH" 2>/dev/null || true

echo "Taskofonico aciliyor..."
open "$TARGET_APP_PATH" || fail "Uygulama acilamadi."

echo
echo "Taskofonico kuruldu: $TARGET_APP_PATH"
echo "Bundan sonra uygulamayi bu klasorden acabilirsin."

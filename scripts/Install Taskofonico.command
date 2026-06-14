#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Taskofonico.app"
SOURCE_APP_PATH="$SCRIPT_DIR/$APP_NAME"
SYSTEM_TARGET_DIR="/Applications"
USER_TARGET_DIR="$HOME/Applications"
TARGET_DIR="$SYSTEM_TARGET_DIR"
TARGET_APP_PATH="$TARGET_DIR/$APP_NAME"

show_message() {
  local message="$1"
  osascript -e "display dialog \"${message//\"/\\\"}\" buttons {\"Tamam\"} default button \"Tamam\" with title \"Taskofonico Installer\"" >/dev/null 2>&1 || true
}

if [[ ! -d "$SOURCE_APP_PATH" ]]; then
  show_message "Taskofonico.app bu klasorde bulunamadi. Install dosyasini, uygulamayla ayni klasorden calistir."
  exit 1
fi

mkdir -p "$USER_TARGET_DIR"

if [[ ! -w "$SYSTEM_TARGET_DIR" ]]; then
  TARGET_DIR="$USER_TARGET_DIR"
  TARGET_APP_PATH="$TARGET_DIR/$APP_NAME"
fi

echo "Taskofonico kuruluyor..."
echo "Hedef klasor: $TARGET_DIR"

if ! ditto "$SOURCE_APP_PATH" "$TARGET_APP_PATH" 2>/dev/null; then
  TARGET_DIR="$USER_TARGET_DIR"
  TARGET_APP_PATH="$TARGET_DIR/$APP_NAME"
  mkdir -p "$TARGET_DIR"
  ditto "$SOURCE_APP_PATH" "$TARGET_APP_PATH"
fi

xattr -dr com.apple.quarantine "$TARGET_APP_PATH" 2>/dev/null || true
xattr -dr com.apple.provenance "$TARGET_APP_PATH" 2>/dev/null || true

open "$TARGET_APP_PATH"

show_message "Taskofonico kuruldu ve acildi. Bundan sonra uygulamayi ${TARGET_DIR} icinden acabilirsin."

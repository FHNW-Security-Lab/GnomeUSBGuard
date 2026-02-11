#!/usr/bin/env bash
set -euo pipefail

UUID="usbguard-prompt@blacksheeep"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$TARGET"
cp -r "$REPO_ROOT/extension/." "$TARGET/"

echo "Installed extension files into: $TARGET"
echo "Enable the extension with:"
echo "  gnome-extensions enable $UUID"


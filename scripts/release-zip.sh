#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$PWD}"
EXTENSION_DIR="$REPO_ROOT/extension"
METADATA_PATH="$EXTENSION_DIR/metadata.json"
BUILD_DIR="$REPO_ROOT/build"

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "error: extension directory not found at $EXTENSION_DIR" >&2
  exit 1
fi

if [[ ! -f "$METADATA_PATH" ]]; then
  echo "error: metadata.json not found at $METADATA_PATH" >&2
  exit 1
fi

UUID="$(jq -r '.uuid // empty' "$METADATA_PATH")"
VERSION="$(jq -r '.version // empty' "$METADATA_PATH")"

if [[ -z "$UUID" ]]; then
  echo "error: metadata.json is missing a non-empty \"uuid\" field" >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  echo "error: metadata.json is missing a non-empty \"version\" field" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PACK_OUT_DIR="$TMP_DIR/out"
mkdir -p "$PACK_OUT_DIR"

PACK_HELP="$(gnome-extensions pack --help 2>&1 || true)"
if [[ -z "$PACK_HELP" ]] || ! grep -q "pack" <<<"$PACK_HELP"; then
  PACK_HELP="$(gnome-extensions help pack 2>&1 || true)"
fi

PACK_ARGS=()
if grep -q -- '--force' <<<"$PACK_HELP"; then
  PACK_ARGS+=(--force)
fi

run_pack_with_cwd() {
  local cwd="$1"
  local source_arg="$2"
  (
    cd "$cwd"
    gnome-extensions pack "${PACK_ARGS[@]}" "$source_arg"
  )
}

run_pack_outdir() {
  local source_arg="$1"
  gnome-extensions pack "${PACK_ARGS[@]}" --out-dir "$PACK_OUT_DIR" "$source_arg"
}

PACK_OK=0
if grep -q -- '--out-dir' <<<"$PACK_HELP"; then
  if run_pack_outdir "$EXTENSION_DIR"; then
    PACK_OK=1
  elif run_pack_outdir "."; then
    PACK_OK=1
  fi
fi

if [[ "$PACK_OK" -eq 0 ]]; then
  if run_pack_with_cwd "$PACK_OUT_DIR" "$EXTENSION_DIR"; then
    PACK_OK=1
  elif run_pack_with_cwd "$EXTENSION_DIR" "."; then
    PACK_OK=1
  fi
fi

if [[ "$PACK_OK" -eq 0 ]]; then
  echo "error: failed to package extension with gnome-extensions pack" >&2
fi

GENERATED_ZIP="$(find "$PACK_OUT_DIR" -maxdepth 1 -type f -name '*.zip' | head -n 1)"
if [[ -z "$GENERATED_ZIP" ]]; then
  GENERATED_ZIP="$TMP_DIR/${UUID}.zip"
  (
    cd "$EXTENSION_DIR"
    zip -rq "$GENERATED_ZIP" .
  )
fi

mkdir -p "$BUILD_DIR"
find "$BUILD_DIR" -maxdepth 1 -type f -name "${UUID}*.zip" -delete

TARGET_ZIP="$BUILD_DIR/${UUID}-v${VERSION}.zip"
cp "$GENERATED_ZIP" "$TARGET_ZIP"

if gnome-extensions help 2>&1 | grep -qE '^[[:space:]]+validate[[:space:]]'; then
  gnome-extensions validate "$TARGET_ZIP"
else
  echo "Skipping validate: this gnome-extensions version has no validate command."
fi

echo "Created release zip: $TARGET_ZIP"

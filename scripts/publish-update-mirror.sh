#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/ubuntu/ws/SerialTerminalPackages"
VERSION="${1:-}"

if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: $0 <version>" >&2
  exit 2
fi

SOURCE="$ROOT/incoming/$VERSION"
RELEASE="$ROOT/releases/$VERSION"
PUBLIC="$ROOT/public"

if [[ ! -d "$SOURCE" ]]; then
  echo "Upload directory does not exist: $SOURCE" >&2
  exit 1
fi

if [[ ! -f "$SOURCE/latest.yml" ]]; then
  echo "Missing latest.yml in $SOURCE" >&2
  exit 1
fi

shopt -s nullglob
installers=("$SOURCE"/*.exe)
blockmaps=("$SOURCE"/*.exe.blockmap)
if (( ${#installers[@]} != 1 || ${#blockmaps[@]} != 1 )); then
  echo "Exactly one Windows installer and one blockmap are required" >&2
  exit 1
fi

public_installer="$(sed -n 's/^path:[[:space:]]*//p' "$SOURCE/latest.yml" | head -n 1 | tr -d "'\"")"
public_installer="$(basename "$public_installer")"
if [[ -z "$public_installer" || "$public_installer" != *.exe ]]; then
  echo "latest.yml does not contain a valid Windows installer path" >&2
  exit 1
fi

if [[ -e "$RELEASE" ]]; then
  echo "Release already exists: $RELEASE" >&2
  exit 1
fi

install -d -m 2775 "$RELEASE" "$PUBLIC"
cp -a "$SOURCE"/. "$RELEASE"/
find "$RELEASE" -type d -exec chmod 2775 {} +
find "$RELEASE" -type f -exec chmod 0664 {} +

public_assets=(
  "${installers[0]}:$public_installer"
  "${blockmaps[0]}:$public_installer.blockmap"
)
for mapping in "${public_assets[@]}"; do
  source_asset="${mapping%%:*}"
  public_name="${mapping#*:}"
  asset="$RELEASE/$(basename "$source_asset")"
  link="$PUBLIC/$public_name"
  ln -sfn "$asset" "$link.new"
  mv -Tf "$link.new" "$link"
done

ln -sfn "$RELEASE/latest.yml" "$PUBLIC/latest.yml.new"
mv -Tf "$PUBLIC/latest.yml.new" "$PUBLIC/latest.yml"

rm -rf "$SOURCE"
echo "Published SerialTerminal $VERSION"
echo "Feed: https://trigger-cn.top/serialterminal/latest.yml"

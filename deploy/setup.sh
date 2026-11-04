#!/usr/bin/env bash
# Build & publish ToyBox as a STATIC site on elnuevos.es.
#
# No Node runtime, no port, no pm2 — the whole toy box runs in the browser
# (Matter.js physics + canvas). Caddy serves the built files from $WEBROOT under
# the /toybox path (see deploy/Caddyfile).
#
# SUDO-FREE: this expects $WEBROOT to be OWNED BY THE DEPLOY USER, so the
# webhook can run it unattended. One-time setup on the VPS:
#   sudo mkdir -p /var/www/toybox
#   sudo chown -R "$USER":"$USER" /var/www/toybox
# After that, always run this WITHOUT sudo (sudo would make files root-owned
# again and the webhook user could no longer overwrite them).
#
# Usage (on the VPS, from the repo root):
#   bash deploy/setup.sh
set -euo pipefail

BASE_PATH="${BASE_PATH:-/toybox}"
WEBROOT="${WEBROOT:-/var/www/toybox}"

echo "==> Installing dependencies (clean)"
# A fresh install (not \`npm ci\`) so the platform-correct native deps are present.
# A lockfile generated on another OS trips npm's optional-deps bug (npm/cli#4828:
# rollup's linux binary goes missing), which breaks the build. Removing
# node_modules first also clears any stale wrong-platform binaries.
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund

echo "==> Building with BASE_PATH=$BASE_PATH"
BASE_PATH="$BASE_PATH" npm run build

if [ ! -w "$(dirname "$WEBROOT")" ] && [ ! -w "$WEBROOT" ]; then
  echo "ERROR: $WEBROOT is not writable by $(whoami)." >&2
  echo "Run the one-time chown shown at the top of this script." >&2
  exit 1
fi

echo "==> Publishing to $WEBROOT"
mkdir -p "$WEBROOT"
rm -rf "${WEBROOT:?}/"*
cp -r dist/* "$WEBROOT/"

# Static files only — Caddy serves them directly, so there is nothing to reload
# on a content update.
echo "==> Done. Live at https://elnuevos.es$BASE_PATH/"

#!/usr/bin/env bash
# LOCAL TESTING ONLY: writes a self-signed certificate in the Let's Encrypt layout nginx expects:
#   infra/certs/live/ktrade/fullchain.pem + privkey.pem   (infra/certs/ is gitignored)
# Then start the stack with TLS_DIR=./certs (see DEPLOYMENT_GUIDE.md → "Local production test").
# Usage: infra/scripts/dev-selfsigned.sh [hostname]   (default: localhost; OPENSSL=/path/to/openssl to pick a binary)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep "/CN=..." as-is

HOST="${1:-localhost}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/certs/live/ktrade"
SAN="DNS:localhost,IP:127.0.0.1"
[[ "$HOST" == "localhost" ]] || SAN="DNS:$HOST,$SAN"
mkdir -p "$OUT"
umask 077

"${OPENSSL:-openssl}" req -x509 -nodes -newkey rsa:2048 -days 30 \
  -keyout "$OUT/privkey.pem" -out "$OUT/fullchain.pem" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "extendedKeyUsage=serverAuth"
# nginx (master runs as root) reads these; keep them out of other users' reach on shared machines.
chmod 600 "$OUT/privkey.pem"
chmod 644 "$OUT/fullchain.pem"

echo "Self-signed cert for '$HOST' (30 days) written to $OUT"
echo "Never use it in production. Delete with: rm -rf \"$ROOT/certs\""

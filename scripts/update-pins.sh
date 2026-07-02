#!/usr/bin/env bash
# Re-derive certificate pins before each release.
# Run: bash scripts/update-pins.sh
# Then update android/app/src/main/res/xml/network_security_config.xml
# and bump the expiration date to the next year-end.

set -euo pipefail

spki() {
  local host=$1
  echo | openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null \
    | openssl x509 -pubkey -noout \
    | openssl pkey -pubin -outform der \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A
}

intermediate() {
  local host=$1
  echo | openssl s_client -connect "${host}:443" -servername "$host" -showcerts 2>/dev/null \
    | awk '/-----BEGIN CERTIFICATE-----/{cert=""; count++} count==2{cert=cert $0 "\n"} /-----END CERTIFICATE-----/ && count==2{print cert; exit}' \
    | openssl x509 -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform der 2>/dev/null \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A
}

echo "=== Cloudflare Worker ==="
echo "  leaf:         $(spki contextreply-suggest.tommy-garnell.workers.dev)"
echo "  intermediate: $(intermediate contextreply-suggest.tommy-garnell.workers.dev)"

echo ""
echo "=== api.anthropic.com ==="
echo "  leaf:         $(spki api.anthropic.com)"
echo "  intermediate: $(intermediate api.anthropic.com)"

echo ""
echo "Update network_security_config.xml and set expiration to next 31 Dec."

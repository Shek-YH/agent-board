#!/usr/bin/env sh
set -eu

API_URL="${API_URL:-http://127.0.0.1:3200}"
ADMIN_URL="${ADMIN_URL:-http://127.0.0.1:3100}"

curl --fail --silent --show-error "$API_URL/health/live" >/dev/null
curl --fail --silent --show-error "$API_URL/health/ready" >/dev/null
curl --fail --silent --show-error "$ADMIN_URL/" >/dev/null

status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$API_URL/v1/license/status")"
test "$status" = 401
printf '%s\n' 'live=healthy ready=healthy admin=reachable protected-api=401'

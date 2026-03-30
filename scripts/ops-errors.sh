#!/bin/bash
# OPS 에러 현황 — Hub 에러 엔드포인트 경유

MINUTES="${1:-60}"
SERVICE="${2}"

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"
[ -z "$TOKEN" ] && TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
[ -z "$TOKEN" ] && { echo "❌ HUB_AUTH_TOKEN 없음"; exit 1; }

URL="$HUB_URL/hub/errors/recent?minutes=$MINUTES"
[ -n "$SERVICE" ] && URL="${URL}&service=$SERVICE"

curl -s "$URL" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

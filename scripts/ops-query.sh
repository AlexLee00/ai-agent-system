#!/bin/bash
# OPS DB 쿼리 — Hub PG 엔드포인트 경유

SCHEMA="${1:-investment}"
SQL="${2}"

if [ -z "$SQL" ]; then
  echo "사용법: ops-query.sh <schema> <sql>"
  echo "스키마: investment | claude | reservation | ska | worker | blog | public"
  exit 1
fi

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"
[ -z "$TOKEN" ] && TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
[ -z "$TOKEN" ] && { echo "❌ HUB_AUTH_TOKEN 없음"; exit 1; }

curl -s -X POST "$HUB_URL/hub/pg/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"schema\":\"$SCHEMA\",\"sql\":\"$SQL\"}" | python3 -m json.tool

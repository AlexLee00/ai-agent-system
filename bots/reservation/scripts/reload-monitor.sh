#!/bin/bash
# 빠른 재시작: 문법 체크 → 정지 → 재시작 → 확인 (E2E 없음)
# 사용: bash scripts/reload-monitor.sh

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/ai.ska.naver-monitor.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR="$SCRIPT_DIR/../auto/monitors/naver-monitor.js"
SERVICE="gui/$(id -u)/ai.ska.naver-monitor"

# 1. 문법 체크
echo "🔍 문법 체크..."
node --check "$MONITOR" || { echo "❌ 문법 오류 — 재시작 중단"; exit 1; }

# 2. 정지
echo "⏹ 모니터 정지..."
launchctl bootout "$SERVICE" 2>/dev/null || true
pkill -f "naver-monitor" 2>/dev/null || true
sleep 2

# 3. 재시작
echo "🚀 재시작..."
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "$SERVICE"
sleep 3

# 4. 확인
PRINT_OUT=$(launchctl print "$SERVICE" 2>/dev/null || true)
PID=$(printf '%s\n' "$PRINT_OUT" | awk -F'= ' '/^[[:space:]]*pid = / {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
STATE=$(printf '%s\n' "$PRINT_OUT" | awk -F'= ' '/^[[:space:]]*state = / {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')
if [ "$STATE" = "running" ] && [ -n "$PID" ]; then
  echo "✅ 재시작 완료 (PID: $PID)"
else
  echo "❌ 재시작 실패"; exit 1
fi

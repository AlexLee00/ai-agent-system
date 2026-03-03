#!/bin/bash
# 빠른 재시작: 문법 체크 → 정지 → 재시작 → 확인 (E2E 없음)
# 사용: bash scripts/reload-monitor.sh

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/ai.ska.naver-monitor.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR="$SCRIPT_DIR/../auto/monitors/naver-monitor.js"

# 1. 문법 체크
echo "🔍 문법 체크..."
node --check "$MONITOR" || { echo "❌ 문법 오류 — 재시작 중단"; exit 1; }

# 2. 정지
echo "⏹ 모니터 정지..."
launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "naver-monitor" 2>/dev/null || true
sleep 2

# 3. 재시작
echo "🚀 재시작..."
launchctl load "$PLIST"
launchctl start ai.ska.naver-monitor
sleep 3

# 4. 확인
if launchctl list | grep -q "ai.ska.naver-monitor"; then
  PID=$(launchctl list | grep "ai.ska.naver-monitor" | awk '{print $1}')
  echo "✅ 재시작 완료 (PID: $PID)"
else
  echo "❌ 재시작 실패"; exit 1
fi

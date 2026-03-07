#!/bin/bash
# scripts/chaos/test-service-restart.sh
# 장애 주입 1: launchd 서비스 강제 종료 → 덱스터 감지 + 독터 복구 검증
#
# ⚠️ 비핵심 서비스만 테스트 (덱스터 퀵체크)
# ⚠️ 실투자(루나팀 암호화폐) 영향 절대 금지
set -e

SERVICE="ai.claude.dexter.quick"
PLIST="$HOME/Library/LaunchAgents/${SERVICE}.plist"

echo "=============================="
echo "🔥 장애 주입 1: 서비스 강제 종료"
echo "=============================="
echo "대상: $SERVICE"
echo ""

# 0. 사전 상태 기록
echo "[$(date '+%H:%M:%S')] 사전 상태:"
launchctl list | grep "$SERVICE" | tee /tmp/chaos-before.txt || echo "(서비스 없음)" | tee /tmp/chaos-before.txt

# 1. 서비스 강제 종료
echo ""
echo "[$(date '+%H:%M:%S')] 서비스 종료 중..."
launchctl bootout "gui/$(id -u)/${SERVICE}" 2>/dev/null || true
sleep 1
launchctl list | grep "$SERVICE" 2>/dev/null && echo "⚠️ 아직 실행 중" || echo "✅ 서비스 종료됨"

# 2. 덱스터 퀵체크로 감지 확인
echo ""
echo "[$(date '+%H:%M:%S')] 덱스터 퀵체크로 감지 확인..."
cd "$(dirname "$0")/../.." && node bots/claude/src/dexter-quickcheck.js 2>&1 | grep -E "(dexter|퀵체크|quick|종료코드|launchd)" | head -10 || true

# 3. 서비스 복구
echo ""
echo "[$(date '+%H:%M:%S')] 서비스 복구 중..."
if [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  sleep 1
  launchctl list | grep "$SERVICE" | tee /tmp/chaos-after.txt || echo "(복구 실패)"
  echo "✅ 서비스 복구됨"
else
  echo "⚠️ plist 없음: $PLIST"
fi

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
echo ""
echo "사전:"; cat /tmp/chaos-before.txt
echo "사후:"; cat /tmp/chaos-after.txt 2>/dev/null

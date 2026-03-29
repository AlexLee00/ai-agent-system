#!/bin/bash
# CI/CD 배포 후 변경된 팀만 선택적 재시작
# OPS 전용 — DEV에서는 launchd 서비스가 없으므로 자동 스킵

set -e

PROJECT_ROOT="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
MODE_VALUE="${MODE:-dev}"
UID_VALUE="$(id -u)"

if [ "$MODE_VALUE" != "ops" ]; then
  echo "ℹ️ DEV 환경 — launchd 서비스 없음, smart-restart 스킵"
  exit 0
fi

CHANGED="$(git -C "$PROJECT_ROOT" diff --name-only HEAD~1 HEAD 2>/dev/null || echo '')"

restart_service() {
  local label="$1"
  echo "🔄 재시작: $label"
  launchctl kickstart -k "gui/${UID_VALUE}/${label}" 2>/dev/null \
    && echo "  ✅ $label" \
    || echo "  ⚠️ $label 재시작 실패 (서비스 미등록?)"
  sleep 2
}

echo "📋 변경 파일 감지 중..."
if [ -z "$CHANGED" ]; then
  echo "ℹ️ 변경 파일 없음 (첫 배포 또는 git 이력 없음)"
  CHANGED="."
fi

if echo "$CHANGED" | grep -q "^packages/core"; then
  echo ""
  echo "⚠️  packages/core 변경 — 전체 팀 순차 재시작"
  restart_service "ai.investment.crypto"
  restart_service "ai.ska.commander"
  restart_service "ai.ska.naver-monitor"
  restart_service "ai.blog.daily"
  restart_service "ai.blog.node-server"
  restart_service "ai.worker.web"
  restart_service "ai.worker.nextjs"
  restart_service "ai.worker.lead"
  restart_service "ai.worker.task-runner"
  restart_service "ai.orchestrator"
  restart_service "ai.claude.dexter"
  echo "✅ 전체 재시작 완료"
  exit 0
fi

RESTARTED=0

if echo "$CHANGED" | grep -q "^bots/investment"; then
  restart_service "ai.investment.crypto"
  restart_service "ai.investment.commander"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -qE "^bots/reservation|^bots/ska"; then
  restart_service "ai.ska.commander"
  restart_service "ai.ska.naver-monitor"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -q "^bots/blog"; then
  restart_service "ai.blog.daily"
  restart_service "ai.blog.node-server"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -q "^bots/worker"; then
  restart_service "ai.worker.web"
  restart_service "ai.worker.nextjs"
  restart_service "ai.worker.lead"
  restart_service "ai.worker.task-runner"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -q "^bots/orchestrator"; then
  restart_service "ai.orchestrator"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -q "^bots/claude"; then
  restart_service "ai.claude.dexter"
  restart_service "ai.claude.commander"
  RESTARTED=$((RESTARTED+1))
fi

if echo "$CHANGED" | grep -q "^bots/hub"; then
  echo "ℹ️ hub 변경 감지 — 현재 launchd 서비스 라벨 미구성, 재시작 스킵"
fi

if [ "$RESTARTED" -eq 0 ]; then
  echo "ℹ️ 재시작 대상 없음 (docs/config 변경만 감지됨)"
else
  echo "✅ ${RESTARTED}개 팀 재시작 완료"
fi

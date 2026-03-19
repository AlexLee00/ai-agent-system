#!/bin/bash
# ─────────────────────────────────────────────────────────
# pre-reboot.sh — 재부팅 전 준비/대기 루틴
# 기본값: 준비만 수행하고 대기
# 실제 ai-agent-system 서비스 정지는 --drain-now로 명시 실행
# 사용법:
#   bash scripts/pre-reboot.sh
#   bash scripts/pre-reboot.sh --drain-now
# ─────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="$HOME/projects/ai-agent-system"
LOG_FILE="/tmp/pre-reboot.log"
PREPARED_FILE="/tmp/ai-agent-pre-reboot-prepared.txt"
SERVICE_SNAPSHOT_FILE="/tmp/pre-reboot-services.txt"
DOC_STATUS_FILE="/tmp/pre-reboot-docs.txt"
TELEGRAM_NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
DRAIN_NOW=0
NOW_TS=$(date +%s)
TODAY=$(date '+%Y-%m-%d')

DOC_CHECKS=(
  "SESSION_HANDOFF|$PROJECT_DIR/docs/SESSION_HANDOFF.md|86400"
  "WORK_HISTORY|$PROJECT_DIR/docs/WORK_HISTORY.md|172800"
  "CHANGELOG|$PROJECT_DIR/docs/CHANGELOG.md|172800"
  "TEST_RESULTS|$PROJECT_DIR/docs/TEST_RESULTS.md|172800"
  "PLATFORM_IMPLEMENTATION_TRACKER|$PROJECT_DIR/docs/PLATFORM_IMPLEMENTATION_TRACKER.md|172800"
)

if [ "${1:-}" = "--drain-now" ]; then
  DRAIN_NOW=1
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

send_telegram() {
  local msg_file="$1"
  "$TELEGRAM_NODE" -e "
    const fs = require('fs');
    const sender = require('$PROJECT_DIR/packages/core/lib/telegram-sender');
    const text = fs.readFileSync('$msg_file', 'utf-8');
    sender.send('claude-lead', text).catch(() => {});
    setTimeout(() => {}, 3000);
  " 2>/dev/null || true
}

service_registered() {
  local svc="$1"
  launchctl print "$LAUNCHCTL_DOMAIN/$svc" >/dev/null 2>&1
}

stop_service_if_registered() {
  local svc="$1"
  local label="$2"
  if service_registered "$svc"; then
    if launchctl stop "$svc" 2>/dev/null; then
      log "   ✅ ${label} 정지 신호"
    else
      log "   ⚠️  ${label} 정지 실패"
    fi
  else
    log "   ⏭️  ${label} 미등록/미실행"
  fi
}

snapshot_services() {
  launchctl list 2>/dev/null | grep "	ai\." | sort > "$SERVICE_SNAPSHOT_FILE"
  log "💾 launchd 서비스 상태 스냅샷 저장 → $SERVICE_SNAPSHOT_FILE"
}

validate_reboot_docs() {
  local failures=0
  : > "$DOC_STATUS_FILE"
  log "🗂️  문서 업데이트 / 세션 핸드오프 점검"

  for entry in "${DOC_CHECKS[@]}"; do
    IFS='|' read -r label path max_age <<< "$entry"
    if [ ! -f "$path" ]; then
      log "   ❌ ${label} 누락: $path"
      printf 'missing|%s|%s\n' "$label" "$path" >> "$DOC_STATUS_FILE"
      failures=1
      continue
    fi

    local mtime age
    mtime=$(stat -f %m "$path" 2>/dev/null || echo 0)
    age=$((NOW_TS - mtime))
    if [ "$age" -le "$max_age" ]; then
      log "   ✅ ${label} 최근 갱신 확인"
      printf 'ok|%s|%s|%s\n' "$label" "$path" "$mtime" >> "$DOC_STATUS_FILE"
    else
      log "   ⚠️  ${label} 최근 갱신 확인 필요 (path: $path)"
      printf 'stale|%s|%s|%s\n' "$label" "$path" "$mtime" >> "$DOC_STATUS_FILE"
      failures=1
    fi
  done

  if [ "$failures" -eq 0 ]; then
    log "✅ 문서 업데이트 / 세션 핸드오프 점검 통과"
    return 0
  fi

  log "⚠️  문서 또는 세션 핸드오프 최신성 확인 필요"
  return 1
}

write_prepared_marker() {
  cat > "$PREPARED_FILE" <<EOF
prepared_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
mode=$([ "$DRAIN_NOW" -eq 1 ] && echo "drain" || echo "prepare_only")
project_dir=$PROJECT_DIR
snapshot_file=$SERVICE_SNAPSHOT_FILE
doc_status_file=$DOC_STATUS_FILE
prepared_date=$TODAY
EOF
  log "📝 재부팅 준비 상태 기록 → $PREPARED_FILE"
}

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$DRAIN_NOW" -eq 1 ]; then
  log "🔄 재부팅 직전 안전 정지 루틴 시작 (--drain-now)"
else
  log "🔄 재부팅 준비/대기 루틴 시작"
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$PROJECT_DIR"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  log "⚠️  미커밋 변경사항 있음 — commit 여부 재확인 권장"
  git status --short 2>/dev/null | head -20 | while read -r line; do log "   $line"; done
else
  log "✅ Git 상태 클린"
fi

snapshot_services
DOCS_OK=0
if validate_reboot_docs; then
  DOCS_OK=1
fi
write_prepared_marker

if [ "$DRAIN_NOW" -eq 0 ]; then
  PRE_MSG_FILE="/tmp/pre-reboot-msg.txt"
  cat > "$PRE_MSG_FILE" <<EOF
🔄 <b>ai-agent-system 재부팅 준비 완료</b> ($(date '+%H:%M:%S'))

현재 단계는 준비/대기 상태입니다.
아직 서비스 정지나 OS 종료는 수행하지 않았습니다.

[다음 단계]
• 필수 문서와 세션 핸드오프 최신성 재확인
• 재부팅 직전: bash $PROJECT_DIR/scripts/pre-reboot.sh --drain-now
• 그 다음 사용자가 직접 재시작 실행
EOF
  send_telegram "$PRE_MSG_FILE"

  log ""
  log "✅ 준비 단계 완료 — 현재는 대기 상태입니다."
  log "→ 아직 ai-agent-system 서비스 정지 및 OS 종료는 수행하지 않았습니다."
  log "→ 필수 문서 점검 결과: $DOC_STATUS_FILE"
  log "→ 재부팅 직전에 아래 명령을 수동 실행하세요:"
  log "   bash $PROJECT_DIR/scripts/pre-reboot.sh --drain-now"
  log "→ 최종 재시작은 사용자가 직접 진행합니다."
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

if [ "$DOCS_OK" -ne 1 ]; then
  log ""
  log "❌ 필수 문서 업데이트 / 세션 핸드오프 확인이 끝나지 않아 drain 단계 중단"
  log "→ 아래 파일을 최신 상태로 반영한 뒤 다시 실행하세요."
  log "   $PROJECT_DIR/docs/SESSION_HANDOFF.md"
  log "   $PROJECT_DIR/docs/WORK_HISTORY.md"
  log "   $PROJECT_DIR/docs/CHANGELOG.md"
  log "   $PROJECT_DIR/docs/TEST_RESULTS.md"
  log "   $PROJECT_DIR/docs/PLATFORM_IMPLEMENTATION_TRACKER.md"
  log "→ 점검 결과: $DOC_STATUS_FILE"
  exit 1
fi

log "⏹️  ai-agent-system 서비스 안전 정지 시작"

log "🤖 오케스트레이터 / OpenClaw / n8n"
stop_service_if_registered "ai.orchestrator" "오케스트레이터"
stop_service_if_registered "ai.openclaw.gateway" "OpenClaw 게이트웨이"
stop_service_if_registered "ai.n8n.server" "n8n 서버"

log "🧩 워커팀"
stop_service_if_registered "ai.worker.web" "워커 웹"
stop_service_if_registered "ai.worker.nextjs" "워커 Next.js"
stop_service_if_registered "ai.worker.lead" "워커 lead"
stop_service_if_registered "ai.worker.task-runner" "워커 task-runner"

log "💹 투자팀"
stop_service_if_registered "ai.investment.commander" "루나 커맨더"
stop_service_if_registered "ai.investment.crypto" "루나 크립토"
stop_service_if_registered "ai.investment.crypto.validation" "루나 크립토 검증거래"
stop_service_if_registered "ai.investment.domestic" "루나 국내주식"
stop_service_if_registered "ai.investment.domestic.validation" "루나 국내주식 검증거래"
stop_service_if_registered "ai.investment.overseas" "루나 해외주식"
stop_service_if_registered "ai.investment.overseas.validation" "루나 해외주식 검증거래"
stop_service_if_registered "ai.investment.argos" "아르고스"
stop_service_if_registered "ai.investment.reporter" "투자 리포터"

log "📝 블로그팀"
stop_service_if_registered "ai.blog.node-server" "블로그 node-server"

log "🛎️  클로드팀"
stop_service_if_registered "ai.claude.commander" "클로드 커맨더"
stop_service_if_registered "ai.claude.dexter" "덱스터"
stop_service_if_registered "ai.claude.dexter.quick" "덱스터 quick"
stop_service_if_registered "ai.claude.dexter.daily" "덱스터 daily"
stop_service_if_registered "ai.claude.archer" "아처"
stop_service_if_registered "ai.claude.health-dashboard" "클로드 health-dashboard"
stop_service_if_registered "ai.claude.speed-test" "클로드 speed-test"

log "🏪 예약/Ska"
stop_service_if_registered "ai.ska.naver-monitor" "앤디 (네이버 모니터)"
stop_service_if_registered "ai.ska.kiosk-monitor" "지미 (키오스크 모니터)"

snapshot_services
date '+%Y-%m-%dT%H:%M:%S KST' > /tmp/last-reboot-time.txt
log "📝 재부팅 직전 시각 기록: $(cat /tmp/last-reboot-time.txt)"

PRE_MSG_FILE="/tmp/pre-reboot-msg.txt"
cat > "$PRE_MSG_FILE" <<EOF
🔄 <b>ai-agent-system 재부팅 직전 준비 완료</b> ($(date '+%H:%M:%S'))

ai-agent-system 관련 서비스 정지 신호를 전송했습니다.
다른 로컬 시스템은 이 스크립트가 건드리지 않습니다.

[현재 상태]
• ai-agent-system 기준 재부팅 직전 대기
• 필수 문서/세션 핸드오프 점검 통과
• 최종 OS 재시작은 사용자가 직접 진행
EOF
send_telegram "$PRE_MSG_FILE"

log ""
log "✅ ai-agent-system 기준 재부팅 직전 정리 완료"
log "→ 이 스크립트는 사용자의 판단 없이 OS 종료/재시작을 실행하지 않습니다."
log "→ 다른 노트북 시스템은 별도 확인 후, 최종 재시작은 사용자가 직접 진행하세요."
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

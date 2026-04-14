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
TELEGRAM_NODE="/opt/homebrew/bin/node"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
DRAIN_NOW=0
FORCE_DOCS=0
NOW_TS=$(date +%s)
TODAY=$(date '+%Y-%m-%d')

DOC_CHECKS=(
  "CLAUDE_ROOT|$PROJECT_DIR/CLAUDE.md|86400"
  "WORK_HISTORY|$PROJECT_DIR/docs/history/WORK_HISTORY.md|172800"
  "CHANGELOG|$PROJECT_DIR/docs/history/CHANGELOG.md|172800"
  "TEST_RESULTS|$PROJECT_DIR/docs/history/TEST_RESULTS.md|172800"
  "RESEARCH_JOURNAL|$PROJECT_DIR/docs/research/RESEARCH_JOURNAL.md|172800"
)

for arg in "$@"; do
  case "$arg" in
    --drain-now)
      DRAIN_NOW=1
      ;;
    --force-docs)
      FORCE_DOCS=1
      ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

send_telegram() {
  local msg_file="$1"
  "$TELEGRAM_NODE" -e "
    const fs = require('fs');
    const { publishToWebhook } = require('$PROJECT_DIR/packages/core/lib/reporting-hub');
    const text = fs.readFileSync('$msg_file', 'utf-8');
    publishToWebhook({
      event: {
        from_bot: 'pre-reboot',
        team: 'claude-lead',
        event_type: 'pre_reboot_notice',
        alert_level: 1,
        message: text,
      }
    }).catch(() => {});
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
• 문서 확인을 이미 마쳤고 즉시 종료가 필요하면: bash $PROJECT_DIR/scripts/pre-reboot.sh --drain-now --force-docs
• 그 다음 사용자가 직접 재시작 실행
EOF
  send_telegram "$PRE_MSG_FILE"

  log ""
  log "✅ 준비 단계 완료 — 현재는 대기 상태입니다."
  log "→ 아직 ai-agent-system 서비스 정지 및 OS 종료는 수행하지 않았습니다."
  log "→ 필수 문서 점검 결과: $DOC_STATUS_FILE"
  log "→ 재부팅 직전에 아래 명령을 수동 실행하세요:"
  log "   bash $PROJECT_DIR/scripts/pre-reboot.sh --drain-now"
  log "   문서 경고를 인지하고 바로 종료해야 하면: bash $PROJECT_DIR/scripts/pre-reboot.sh --drain-now --force-docs"
  log "→ 최종 재시작은 사용자가 직접 진행합니다."
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

if [ "$DOCS_OK" -ne 1 ] && [ "$FORCE_DOCS" -ne 1 ]; then
  log ""
  log "❌ 필수 문서 업데이트 / 세션 핸드오프 확인이 끝나지 않아 drain 단계 중단"
  log "→ 아래 파일을 최신 상태로 반영한 뒤 다시 실행하세요."
  log "   $PROJECT_DIR/CLAUDE.md"
  log "   $PROJECT_DIR/docs/history/WORK_HISTORY.md"
  log "   $PROJECT_DIR/docs/history/CHANGELOG.md"
  log "   $PROJECT_DIR/docs/history/TEST_RESULTS.md"
  log "   $PROJECT_DIR/docs/research/RESEARCH_JOURNAL.md"
  log "→ 점검 결과: $DOC_STATUS_FILE"
  exit 1
fi

if [ "$DOCS_OK" -ne 1 ] && [ "$FORCE_DOCS" -eq 1 ]; then
  log "⚠️  문서 최신성 경고를 사용자가 확인했고 --force-docs로 drain 계속 진행"
fi

log "⏹️  ai-agent-system 서비스 안전 정지 시작"

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
stop_service_if_registered "ai.investment.health-check" "투자 health-check"
stop_service_if_registered "ai.investment.unrealized-pnl" "미실현 손익"
stop_service_if_registered "ai.investment.market-alert-domestic-open" "국내장 오픈 알림"
stop_service_if_registered "ai.investment.market-alert-domestic-close" "국내장 마감 알림"
stop_service_if_registered "ai.investment.market-alert-overseas-open" "해외장 오픈 알림"
stop_service_if_registered "ai.investment.market-alert-overseas-close" "해외장 마감 알림"
stop_service_if_registered "ai.investment.market-alert-crypto-daily" "크립토 일일 알림"
stop_service_if_registered "ai.investment.prescreen-domestic" "국내장 prescreen"
stop_service_if_registered "ai.investment.prescreen-overseas" "해외장 prescreen"

log "🏪 SKA팀"
stop_service_if_registered "ai.ska.commander" "스카 커맨더"
stop_service_if_registered "ai.ska.dashboard" "스카 대시보드"
stop_service_if_registered "ai.ska.naver-monitor" "앤디 (네이버 모니터)"
stop_service_if_registered "ai.ska.kiosk-monitor" "지미 (키오스크 모니터)"
stop_service_if_registered "ai.ska.eve" "이브"
stop_service_if_registered "ai.ska.eve-crawl" "이브 크롤"
stop_service_if_registered "ai.ska.rebecca" "레베카"
stop_service_if_registered "ai.ska.rebecca-weekly" "레베카 weekly"
stop_service_if_registered "ai.ska.etl" "스카 ETL"
stop_service_if_registered "ai.ska.db-backup" "스카 DB 백업"
stop_service_if_registered "ai.ska.health-check" "스카 health-check"
stop_service_if_registered "ai.ska.forecast-daily" "매출 예측 daily"
stop_service_if_registered "ai.ska.forecast-weekly" "매출 예측 weekly"
stop_service_if_registered "ai.ska.forecast-monthly" "매출 예측 monthly"
stop_service_if_registered "ai.ska.log-rotate" "스카 로그 로테이트"
stop_service_if_registered "ai.ska.pickko-daily-audit" "피코 일일 감사"
stop_service_if_registered "ai.ska.pickko-daily-summary" "피코 일일 요약"
stop_service_if_registered "ai.ska.pickko-pay-scan" "피코 결제 스캔"
stop_service_if_registered "ai.ska.pickko-verify" "피코 검증"
stop_service_if_registered "ai.ska.today-audit" "스카 금일 감사"

log "📝 블로그팀"
stop_service_if_registered "ai.blog.node-server" "블로그 node-server"
stop_service_if_registered "ai.blog.comfyui" "블로그 ComfyUI"
stop_service_if_registered "ai.blog.daily" "블로그 daily"
stop_service_if_registered "ai.blog.health-check" "블로그 health-check"
stop_service_if_registered "ai.blog.collect-performance" "블로그 성과 수집"

log "🧩 워커팀"
stop_service_if_registered "ai.worker.web" "워커 웹"
stop_service_if_registered "ai.worker.nextjs" "워커 Next.js"
stop_service_if_registered "ai.worker.lead" "워커 lead"
stop_service_if_registered "ai.worker.task-runner" "워커 task-runner"
stop_service_if_registered "ai.worker.health-check" "워커 health-check"
stop_service_if_registered "ai.worker.claude-monitor" "워커 claude-monitor"

log "🛎️  클로드팀"
stop_service_if_registered "ai.claude.commander" "클로드 커맨더"
stop_service_if_registered "ai.claude.dexter" "덱스터"
stop_service_if_registered "ai.claude.dexter.quick" "덱스터 quick"
stop_service_if_registered "ai.claude.dexter.daily" "덱스터 daily"
stop_service_if_registered "ai.claude.archer" "아처"
stop_service_if_registered "ai.claude.health-dashboard" "클로드 health-dashboard"
stop_service_if_registered "ai.claude.health-check" "클로드 health-check"
stop_service_if_registered "ai.claude.speed-test" "클로드 speed-test"

log "🔬 연구팀"
stop_service_if_registered "ai.research.scanner" "리서치 스캐너"

log "🏠 집사 (Steward)"
stop_service_if_registered "ai.steward.hourly" "집사 hourly"
stop_service_if_registered "ai.steward.daily" "집사 daily"
stop_service_if_registered "ai.steward.weekly" "집사 weekly"

log "✍️  라이트 / 이벤트"
stop_service_if_registered "ai.write.daily" "라이트 daily"
stop_service_if_registered "ai.event.reminders" "이벤트 리마인더"

log "🔄 공통 에이전트"
stop_service_if_registered "ai.agent.auto-commit" "auto-commit"
stop_service_if_registered "ai.agent.nightly-sync" "nightly-sync"
stop_service_if_registered "ai.agent.post-reboot" "post-reboot (자기 자신)"

log "🔧 인프라 (OpenClaw / n8n / Hub / MLX)"
stop_service_if_registered "ai.openclaw.gateway" "OpenClaw 게이트웨이"
stop_service_if_registered "ai.n8n.server" "n8n 서버"
stop_service_if_registered "ai.hub.resource-api" "Hub 리소스 API"
stop_service_if_registered "ai.mlx.server" "MLX LLM 서버"
stop_service_if_registered "ai.openclaw.model-sync" "OpenClaw 모델 싱크"
stop_service_if_registered "ai.env.setup" "환경 설정"

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

#!/bin/bash
# ─────────────────────────────────────────────────────────
# post-reboot.sh — 재부팅 후 시작 루틴
# launchd ai.agent.post-reboot.plist → RunAtLoad=true 자동 실행
# 수동 실행: bash scripts/post-reboot.sh
# ─────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="$HOME/projects/ai-agent-system"
LOG_FILE="/tmp/post-reboot.log"
FOLLOWUP_FILE="/tmp/post-reboot-followup.txt"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
TELEGRAM_NODE="/opt/homebrew/bin/node"
DRY_RUN=0

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

log() {
  local line="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  printf '%s\n' "$line" >> "$LOG_FILE"
  if [ -t 1 ]; then
    printf '%s\n' "$line"
  fi
}

send_telegram() {
  local msg_file="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "🧪 dry-run 모드 — 텔레그램 발송 생략"
    while IFS= read -r line; do
      log "   $line"
    done < "$msg_file"
    return 0
  fi

  PROJECT_DIR_ENV="$PROJECT_DIR" MSG_FILE_ENV="$msg_file" \
  "$TELEGRAM_NODE" - <<'NODE' 2>/dev/null || true
const fs = require('fs');
const { publishToWebhook } = require(process.env.PROJECT_DIR_ENV + '/packages/core/lib/reporting-hub');

(async () => {
  const text = fs.readFileSync(process.env.MSG_FILE_ENV, 'utf-8');
  await publishToWebhook({
    event: {
      from_bot: 'post-reboot',
      team: 'claude-lead',
      event_type: 'post_reboot_notice',
      alert_level: 1,
      message: text,
    },
  });
})().catch(() => {});
NODE
}

log "🚀 재부팅 후 시작 루틴 시작 (시스템 안정화 대기 45초)..."
sleep 45

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🔍 서비스 상태 점검 시작"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
sleep 20

REPORT_LINES=()
OK=0
WARN=0
FAIL=0

append_report() {
  REPORT_LINES+=("$1")
}

has_recent_dexter_report() {
  local log_path="$PROJECT_DIR/bots/claude/dexter.log"
  if [ ! -f "$log_path" ]; then
    return 1
  fi

  local now_ts mtime age tail_text
  now_ts=$(date +%s)
  mtime=$(stat -f %m "$log_path" 2>/dev/null || echo 0)
  age=$((now_ts - mtime))
  if [ "$age" -gt 5400 ]; then
    return 1
  fi

  tail_text=$(tail -n 80 "$log_path" 2>/dev/null || true)
  [[ "$tail_text" == *"📋 요약:"* || "$tail_text" == *"🎉 모든 체크 통과"* || "$tail_text" == *"이상 없음 — 텔레그램 발송 생략"* ]]
}

check_svc() {
  local svc="$1"
  local label="$2"
  local pid
  pid=$(launchctl list 2>/dev/null | awk -v s="$svc" '$3==s {print $1}')
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" != "0" ]; then
    log "   ✅ ${label} (PID: ${pid})"
    append_report "✅ ${label}"
    ((OK++)) || true
  else
    log "   ❌ ${label} 미실행"
    append_report "❌ ${label} 미실행"
    ((FAIL++)) || true
  fi
}

check_periodic() {
  local svc="$1"
  local label="$2"
  local optional="${3:-0}"
  local info runs exit_raw exit_code
  info=$(launchctl print "$LAUNCHCTL_DOMAIN/$svc" 2>/dev/null || true)
  runs=$(echo "$info" | awk '/	runs =/ {print $3}')
  exit_raw=$(echo "$info" | sed -n 's/^[[:space:]]*last exit code = \(.*\)$/\1/p' | head -n 1)

  if [[ "$exit_raw" =~ ^[0-9]+$ ]]; then
    exit_code="$exit_raw"
  else
    exit_code=""
  fi

  if [ -z "$runs" ]; then
    if [ "$optional" = "1" ]; then
      log "   ℹ️  ${label} (선택적 서비스 미등록)"
      append_report "ℹ️ ${label} 미등록(선택)"
    else
      log "   ⚠️  ${label} (서비스 미등록)"
      append_report "⚠️ ${label} 미등록"
      ((WARN++)) || true
    fi
  elif [ "$runs" -ge 1 ] && [ "$exit_code" = "0" ]; then
    log "   ✅ ${label} (${runs}회 실행, exit=0)"
    append_report "✅ ${label}"
    ((OK++)) || true
  elif [ "$runs" -eq 0 ] || [ -z "$exit_code" ] || [ "$exit_raw" = "(never)" ]; then
    log "   ⏳ ${label} (등록됨, 첫 트리거 대기 중)"
    append_report "⏳ ${label} 대기중"
    ((WARN++)) || true
  elif [ "$svc" = "ai.claude.dexter" ] && [ "$exit_code" = "1" ] && has_recent_dexter_report; then
    log "   ✅ ${label} (최근 점검 결과 존재, exit=1 허용)"
    append_report "✅ ${label} (최근 점검 결과 있음)"
    ((OK++)) || true
  else
    log "   ❌ ${label} (exit=${exit_raw:-unknown})"
    append_report "❌ ${label} 오류 (exit=${exit_raw:-unknown})"
    ((FAIL++)) || true
  fi
}

log "🔧 인프라 (OpenClaw / n8n / Hub / MLX)"
check_svc      "ai.mlx.server"          "MLX LLM 서버"
check_svc      "ai.hub.resource-api"    "Hub 리소스 API"
check_svc      "ai.openclaw.gateway"    "OpenClaw 게이트웨이"
check_svc      "ai.n8n.server"          "n8n 워크플로우 서버"
check_periodic "ai.openclaw.model-sync" "OpenClaw 모델 싱크"
check_periodic "ai.env.setup"           "환경 설정"

log "💹 투자팀"
check_svc      "ai.investment.commander"             "루나 커맨더"
check_periodic "ai.investment.crypto"                "루나 크립토 사이클"
check_periodic "ai.investment.crypto.validation"     "루나 크립토 검증거래" "1"
check_periodic "ai.investment.domestic"              "루나 국내주식 사이클"
check_periodic "ai.investment.domestic.validation"   "루나 국내주식 검증거래" "1"
check_periodic "ai.investment.overseas"              "루나 해외주식 사이클"
check_periodic "ai.investment.overseas.validation"   "루나 해외주식 검증거래" "1"
check_periodic "ai.investment.argos"                 "아르고스"
check_periodic "ai.investment.reporter"              "투자 리포터"
check_periodic "ai.investment.health-check"          "투자 health-check"
check_periodic "ai.investment.unrealized-pnl"        "미실현 손익"
check_periodic "ai.investment.market-alert-domestic-open"   "국내장 오픈 알림"
check_periodic "ai.investment.market-alert-domestic-close"  "국내장 마감 알림"
check_periodic "ai.investment.market-alert-overseas-open"   "해외장 오픈 알림"
check_periodic "ai.investment.market-alert-overseas-close"  "해외장 마감 알림"
check_periodic "ai.investment.market-alert-crypto-daily"    "크립토 일일 알림"
check_periodic "ai.investment.prescreen-domestic"           "국내장 prescreen"
check_periodic "ai.investment.prescreen-overseas"           "해외장 prescreen"

log "🏪 SKA팀"
check_svc      "ai.ska.commander"            "스카 커맨더"
check_svc      "ai.ska.dashboard"            "스카 대시보드"
check_svc      "ai.ska.naver-monitor"        "앤디 (네이버 모니터)"
check_periodic "ai.ska.kiosk-monitor"        "지미 (키오스크 모니터)"
check_periodic "ai.ska.eve"                  "이브"
check_periodic "ai.ska.eve-crawl"            "이브 크롤"
check_periodic "ai.ska.rebecca"              "레베카"
check_periodic "ai.ska.rebecca-weekly"       "레베카 weekly"
check_periodic "ai.ska.etl"                  "스카 ETL"
check_periodic "ai.ska.db-backup"            "스카 DB 백업"
check_periodic "ai.ska.health-check"         "스카 health-check"
check_periodic "ai.ska.forecast-daily"       "매출 예측 daily"
check_periodic "ai.ska.forecast-weekly"      "매출 예측 weekly"
check_periodic "ai.ska.forecast-monthly"     "매출 예측 monthly"
check_periodic "ai.ska.log-rotate"           "스카 로그 로테이트"
check_periodic "ai.ska.pickko-daily-audit"   "피코 일일 감사"
check_periodic "ai.ska.pickko-daily-summary" "피코 일일 요약"
check_periodic "ai.ska.pickko-pay-scan"      "피코 결제 스캔"
check_periodic "ai.ska.pickko-verify"        "피코 검증"
check_periodic "ai.ska.today-audit"          "스카 금일 감사"

log "📝 블로그팀"
check_svc      "ai.blog.node-server"         "블로그 node-server"
check_periodic "ai.blog.daily"               "블로그 daily"
check_periodic "ai.blog.health-check"        "블로그 health-check"
check_periodic "ai.blog.collect-performance" "블로그 성과 수집"

log "🧩 워커팀"
check_svc      "ai.worker.web"            "워커 웹"
check_svc      "ai.worker.nextjs"         "워커 Next.js"
check_svc      "ai.worker.lead"           "워커 lead"
check_svc      "ai.worker.task-runner"    "워커 task-runner"
check_periodic "ai.worker.health-check"   "워커 health-check"
check_periodic "ai.worker.claude-monitor" "워커 claude-monitor"

log "🛎️  클로드팀"
check_svc      "ai.claude.commander"        "클로드 커맨더"
check_svc      "ai.claude.health-dashboard" "클로드 health-dashboard"
check_periodic "ai.claude.dexter.quick"     "덱스터 quick"
check_periodic "ai.claude.dexter"           "덱스터"
check_periodic "ai.claude.dexter.daily"     "덱스터 daily"
check_periodic "ai.claude.archer"           "아처"
check_periodic "ai.claude.health-check"     "클로드 health-check"
check_periodic "ai.claude.speed-test"       "클로드 speed-test"

log "🔬 연구팀"
check_periodic "ai.research.scanner"     "리서치 스캐너"

log "🏠 집사 (Steward)"
check_periodic "ai.steward.hourly"       "집사 hourly"
check_periodic "ai.steward.daily"        "집사 daily"
check_periodic "ai.steward.weekly"       "집사 weekly"

log "✍️  라이트 / 이벤트"
check_periodic "ai.write.daily"          "라이트 daily"
check_periodic "ai.event.reminders"      "이벤트 리마인더"

log "🔄 공통 에이전트"
check_periodic "ai.agent.auto-commit"    "auto-commit"
check_periodic "ai.agent.nightly-sync"   "nightly-sync"
check_periodic "ai.agent.post-reboot"    "post-reboot (자기 자신)"

launchctl list 2>/dev/null | grep "	ai\." | sort > /tmp/post-reboot-services.txt
log "💾 전체 서비스 목록 저장 → /tmp/post-reboot-services.txt"

cat > "$FOLLOWUP_FILE" <<EOF
post_reboot_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
required_followups:
- /Users/alexlee/projects/ai-agent-system/CLAUDE.md
- /Users/alexlee/projects/ai-agent-system/docs/history/WORK_HISTORY.md
- /Users/alexlee/projects/ai-agent-system/docs/history/CHANGELOG.md
- /Users/alexlee/projects/ai-agent-system/docs/history/TEST_RESULTS.md
- /Users/alexlee/projects/ai-agent-system/docs/research/RESEARCH_JOURNAL.md
rule=재부팅 후 상태 변화 또는 장애/복구 조치가 있으면 위 문서와 세션 인수인계를 갱신
EOF
log "📝 재부팅 후 문서/세션 후속 체크리스트 저장 → $FOLLOWUP_FILE"

LAST_COMMIT=$(git -C "$PROJECT_DIR" log --oneline -1 2>/dev/null || echo "알 수 없음")
BOOT_TIME=$(date '+%Y-%m-%d %H:%M:%S')

if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  STATUS_ICON="✅"
  STATUS_TEXT="전체 정상"
elif [ "$FAIL" -eq 0 ]; then
  STATUS_ICON="⚠️"
  STATUS_TEXT="치명 오류 없음, 일부 대기/미등록 ${WARN}건"
else
  STATUS_ICON="❌"
  STATUS_TEXT="오류 ${FAIL}건, 대기/미등록 ${WARN}건"
fi

MSG_FILE="/tmp/post-reboot-msg.txt"
REPORT_TEXT=""
if [ "${#REPORT_LINES[@]}" -gt 0 ]; then
  REPORT_TEXT=$(printf '%s\n' "${REPORT_LINES[@]}")
fi

cat > "$MSG_FILE" <<EOF
🖥️ <b>맥북 재부팅 완료</b> (${BOOT_TIME})
${STATUS_ICON} ${STATUS_TEXT}

${REPORT_TEXT}
마지막 커밋: ${LAST_COMMIT}

[수동 후속 권장]
• worker / orchestrator / investment / blog health-report --json 재확인
• reservation health-report --json 재확인
• 필요 시 bash $PROJECT_DIR/scripts/post-reboot.sh --dry-run
• 상태 변화가 있으면 CLAUDE / WORK_HISTORY / CHANGELOG / TEST_RESULTS / RESEARCH_JOURNAL 갱신
EOF
send_telegram "$MSG_FILE"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "✅ 재부팅 후 시작 루틴 완료 (OK: ${OK}, WARN: ${WARN}, FAIL: ${FAIL})"
if [ "$FAIL" -gt 0 ] || [ "$WARN" -gt 0 ]; then
  log "⚠️  launchd 상태와 팀별 health-report를 함께 재확인하세요."
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

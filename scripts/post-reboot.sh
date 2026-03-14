#!/bin/bash
# ─────────────────────────────────────────────────────────
# post-reboot.sh — 재부팅 후 시작 루틴
# launchd ai.agent.post-reboot.plist → RunAtLoad=true 자동 실행
# 수동 실행: bash scripts/post-reboot.sh
# ─────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="$HOME/projects/ai-agent-system"
LOG_FILE="/tmp/post-reboot.log"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
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
    log "🧾 메시지 미리보기:"
    while IFS= read -r line; do
      log "   $line"
    done < "$msg_file"
    return 0
  fi

  PROJECT_DIR_ENV="$PROJECT_DIR" MSG_FILE_ENV="$msg_file" \
  /Users/alexlee/.nvm/versions/node/v24.13.1/bin/node - <<'NODE' 2>/dev/null || true
const fs = require('fs');
const sender = require(process.env.PROJECT_DIR_ENV + '/packages/core/lib/telegram-sender');

(async () => {
  const text = fs.readFileSync(process.env.MSG_FILE_ENV, 'utf-8');
  await sender.send('claude-lead', text);
})().catch(() => {});
NODE
}

# ── 시스템 안정화 대기 ────────────────────────────────────
log "🚀 재부팅 후 시작 루틴 시작 (시스템 안정화 대기 45초)..."
sleep 45

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🔍 서비스 상태 점검 시작"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# KeepAlive 서비스들이 자동 재시작될 때까지 추가 대기
sleep 20

# ── 서비스 상태 확인 ──────────────────────────────────────
REPORT_LINES=()
OK=0
FAIL=0

append_report() {
  REPORT_LINES+=("$1")
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

# 주기 태스크 점검: runs≥1+exit0=정상 / runs=0=대기중(오류아님) / exit≠0=실패
check_periodic() {
  local svc="$1"
  local label="$2"
  local info runs exit_raw exit_code
  info=$(launchctl print "$LAUNCHCTL_DOMAIN/$svc" 2>/dev/null)
  runs=$(echo "$info" | awk '/	runs =/ {print $3}')
  exit_raw=$(echo "$info" | sed -n 's/^[[:space:]]*last exit code = \(.*\)$/\1/p' | head -n 1)

  # exit_code가 숫자가 아니면(never 등) 빈 값으로 처리
  if [[ "$exit_raw" =~ ^[0-9]+$ ]]; then
    exit_code="$exit_raw"
  else
    exit_code=""
  fi

  if [ -z "$runs" ]; then
    log "   ⚠️  ${label} (서비스 미등록)"
    append_report "⚠️ ${label} 미등록"
    ((FAIL++)) || true
  elif [ "$runs" -ge 1 ] && [ "$exit_code" = "0" ]; then
    log "   ✅ ${label} (${runs}회 실행, exit=0)"
    append_report "✅ ${label}"
    ((OK++)) || true
  elif [ "$runs" -eq 0 ] || [ -z "$exit_code" ] || [ "$exit_raw" = "(never)" ]; then
    log "   ⏳ ${label} (등록됨, 첫 트리거 대기 중)"
    append_report "⏳ ${label} 대기중"
    ((OK++)) || true
  else
    log "   ❌ ${label} (exit=${exit_raw:-unknown})"
    append_report "❌ ${label} 오류 (exit=${exit_raw:-unknown})"
    ((FAIL++)) || true
  fi
}

log "📡 OpenClaw / 스카팀:"
check_svc      "ai.openclaw.gateway"    "OpenClaw 게이트웨이"
check_svc      "ai.ska.naver-monitor"   "앤디 (네이버 모니터)"
check_periodic "ai.ska.kiosk-monitor"   "지미 (키오스크 모니터, 10분)"

log "💹 루나팀:"
check_periodic "ai.investment.crypto"   "루나 크립토 사이클 (5분)"
check_periodic "ai.investment.domestic" "루나 국내주식 사이클 (5분)"
check_periodic "ai.investment.overseas" "루나 해외주식 사이클 (5분)"

log "🤖 클로드팀:"
check_periodic "ai.claude.dexter"       "덱스터 (시스템 점검, 1시간)"

log "🔄 공통 에이전트:"
check_periodic "ai.agent.auto-commit"   "auto-commit"
check_periodic "ai.agent.nightly-sync"  "nightly-sync"

log "⚙️  n8n:"
check_svc      "ai.n8n.server"          "n8n 워크플로우 서버 (포트 5678)"

# ── 전체 launchd 서비스 목록 저장 ────────────────────────
launchctl list 2>/dev/null | grep "	ai\." | sort > /tmp/post-reboot-services.txt
log "💾 전체 서비스 목록 저장 → /tmp/post-reboot-services.txt"

# ── 재부팅 전 마지막 커밋 확인 ───────────────────────────
LAST_COMMIT=$(git -C "$PROJECT_DIR" log --oneline -1 2>/dev/null || echo "알 수 없음")
BOOT_TIME=$(date '+%Y-%m-%d %H:%M:%S')

# ── 텔레그램 최종 보고 ────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  STATUS_ICON="✅"
  STATUS_TEXT="전체 정상"
elif [ "$FAIL" -le 2 ]; then
  STATUS_ICON="⚠️"
  STATUS_TEXT="${FAIL}개 서비스 확인 필요"
else
  STATUS_ICON="❌"
  STATUS_TEXT="${FAIL}개 서비스 미실행"
fi

MSG_FILE="/tmp/post-reboot-msg.txt"
REPORT_TEXT=""
if [ "${#REPORT_LINES[@]}" -gt 0 ]; then
  REPORT_TEXT=$(printf '%s\n' "${REPORT_LINES[@]}")
fi

cat > "$MSG_FILE" << EOF
🖥️ <b>맥북 재부팅 완료</b> (${BOOT_TIME})
${STATUS_ICON} ${STATUS_TEXT}

${REPORT_TEXT}
마지막 커밋: ${LAST_COMMIT}
EOF
send_telegram "$MSG_FILE"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "✅ 재부팅 후 시작 루틴 완료 (OK: ${OK}, FAIL: ${FAIL})"
if [ "$FAIL" -gt 0 ]; then
  log "⚠️  일부 서비스 미실행 — skastatus 명령으로 수동 확인 필요"
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

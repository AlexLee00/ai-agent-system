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
PRE_REBOOT_SNAPSHOT_FILE="${PRE_REBOOT_SERVICE_SNAPSHOT_FILE:-/tmp/pre-reboot-services.txt}"
POST_REBOOT_SNAPSHOT_FILE="${POST_REBOOT_SERVICE_SNAPSHOT_FILE:-/tmp/post-reboot-services.txt}"
DRY_RUN=0
CRITICAL_SERVICES=(
  "🔧 인프라 (Hub / Telegram callback / MLX)|ai.mlx.server|MLX LLM 서버"
  "🔧 인프라 (Hub / Telegram callback / MLX)|ai.hub.resource-api|Hub 리소스 API"
  "🔧 인프라 (Hub / Telegram callback / MLX)|ai.telegram.callback-poller|텔레그램 콜백 poller"
  "🔧 인프라 (Hub / Telegram callback / MLX)|ai.elixir.supervisor|Team Jay 대시보드/Elixir supervisor"
  "🔧 인프라 (Hub / Telegram callback / MLX)|ai.sigma.mcp-server|Sigma MCP 서버"
  "💹 투자팀|ai.investment.commander|루나 커맨더"
  "💹 투자팀|ai.luna.marketdata-mcp|루나 마켓데이터 MCP"
  "💹 투자팀|ai.luna.tradingview-ws|루나 TradingView WS"
  "🏪 SKA팀|ai.ska.commander|스카 커맨더"
  "🏪 SKA팀|ai.ska.naver-monitor|앤디 (네이버 모니터)"
  "📝 블로그팀|ai.blog.node-server|블로그 node-server"
  "🛎️  클로드팀|ai.claude.commander|클로드 커맨더"
  "🛎️  클로드팀|ai.claude.auto-dev.autonomous|클로드 자동개발 (L5)"
)

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
    log "🧪 dry-run 모드 — 텔레그램 발송 생략 (미리보기: $msg_file)"
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

if [ "$DRY_RUN" -eq 1 ]; then
  log "🧪 dry-run 모드 — 시스템 안정화 대기 생략"
else
  log "🚀 재부팅 후 시작 루틴 시작 (시스템 안정화 대기 45초)..."
  sleep 45
fi

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🔍 서비스 상태 점검 시작"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$DRY_RUN" -eq 0 ]; then
  sleep 20
fi

REPORT_LINES=()
OK=0
INFO=0
WARN=0
FAIL=0

append_report() {
  REPORT_LINES+=("$1")
}

launchctl_field() {
  local info="$1"
  local pattern="$2"
  echo "$info" | sed -n "s/^[[:space:]]*${pattern}[[:space:]]*=[[:space:]]*\\(.*\\)$/\\1/p" | head -n 1
}

check_svc() {
  local svc="$1"
  local label="$2"
  local pid info state exit_raw exit_code
  pid=$(launchctl list 2>/dev/null | awk -v s="$svc" '$3==s {print $1}')
  info=$(launchctl print "$LAUNCHCTL_DOMAIN/$svc" 2>/dev/null || true)
  state=$(launchctl_field "$info" "state")
  exit_raw=$(launchctl_field "$info" "last exit code")

  if [[ "$exit_raw" =~ ^[0-9]+$ ]]; then
    exit_code="$exit_raw"
  else
    exit_code=""
  fi

  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" != "0" ]; then
    log "   ✅ ${label} (PID: ${pid})"
    append_report "✅ ${label}"
    ((OK++)) || true
  elif [ "$state" = "running" ]; then
    log "   ✅ ${label} (running, pid 미노출)"
    append_report "✅ ${label} (running)"
    ((OK++)) || true
  elif [ "$state" = "spawn scheduled" ] && [ "${exit_code:-}" = "0" ]; then
    log "   ⏳ ${label} (launchd 대기 중, 최근 종료 정상)"
    append_report "⏳ ${label} 대기중(최근 정상)"
    ((WARN++)) || true
  else
    log "   ❌ ${label} 미실행"
    append_report "❌ ${label} 미실행"
    ((FAIL++)) || true
  fi
}

snapshot_services() {
  local snapshot_file="$1"
  launchctl list 2>/dev/null \
    | awk '$3 ~ /^ai\./ { print $3 "|" $1 "|" $2 }' \
    | sort > "$snapshot_file"
}

normalize_snapshot() {
  local source_file="$1"
  local normalized_file="$2"
  awk '
    index($0, "|") {
      split($0, fields, "|")
      if (fields[1] ~ /^ai\./) print fields[1] "|" fields[2] "|" fields[3]
      next
    }
    {
      count = split($0, fields, /[[:space:]]+/)
      if (count >= 3 && fields[3] ~ /^ai\./) print fields[3] "|" fields[1] "|" fields[2]
    }
  ' "$source_file" | sort -t '|' -k1,1 -u > "$normalized_file"
}

is_critical_service() {
  local requested_service="$1"
  local entry group service label
  for entry in "${CRITICAL_SERVICES[@]}"; do
    IFS='|' read -r group service label <<< "$entry"
    if [ "$requested_service" = "$service" ]; then
      return 0
    fi
  done
  return 1
}

run_critical_service_checks() {
  local entry group service label current_group=""
  for entry in "${CRITICAL_SERVICES[@]}"; do
    IFS='|' read -r group service label <<< "$entry"
    if [ "$group" != "$current_group" ]; then
      log "$group"
      current_group="$group"
    fi
    check_svc "$service" "$label"
  done
}

is_failed_snapshot_state() {
  local pid="$1"
  local exit_code="$2"
  [ "$pid" = "-" ] && [[ "$exit_code" =~ ^[1-9][0-9]*$ ]]
}

compare_service_snapshots() {
  local baseline_file="$1"
  local current_file="$2"
  local normalized_baseline svc pid exit_code current_line current_pid current_exit
  local baseline_line baseline_pid baseline_exit matched_count=0 baseline_missing=0

  normalized_baseline=$(mktemp /tmp/post-reboot-baseline.XXXXXX)
  if [ ! -s "$baseline_file" ]; then
    log "   ℹ️  재부팅 전 스냅샷 없음 — 현재 launchctl 목록을 기준선으로 사용"
    append_report "ℹ️ 재부팅 전 스냅샷 없음 (현재 상태로 기준선 초기화)"
    ((INFO++)) || true
    baseline_missing=1
    cp "$current_file" "$normalized_baseline"
  else
    normalize_snapshot "$baseline_file" "$normalized_baseline"
  fi

  while IFS='|' read -r svc pid exit_code; do
    [ -n "$svc" ] || continue
    is_critical_service "$svc" && continue
    current_line=$(awk -F '|' -v service="$svc" '$1 == service { print; exit }' "$current_file")
    if [ -z "$current_line" ]; then
      log "   ⚠️  ${svc} (재부팅 후 목록에서 사라짐)"
      append_report "⚠️ ${svc} 재부팅 후 미등록"
      ((WARN++)) || true
      continue
    fi

    IFS='|' read -r _ current_pid current_exit <<< "$current_line"
    if ! is_failed_snapshot_state "$current_pid" "$current_exit"; then
      ((matched_count++)) || true
    elif [ "$baseline_missing" -eq 0 ] \
      && is_failed_snapshot_state "$pid" "$exit_code" \
      && [ "$exit_code" = "$current_exit" ]; then
      ((matched_count++)) || true
    fi
  done < "$normalized_baseline"

  while IFS='|' read -r svc pid exit_code; do
    [ -n "$svc" ] || continue
    is_critical_service "$svc" && continue
    is_failed_snapshot_state "$pid" "$exit_code" || continue

    baseline_line=$(awk -F '|' -v service="$svc" '$1 == service { print; exit }' "$normalized_baseline")
    if [ "$baseline_missing" -eq 0 ] && [ -n "$baseline_line" ]; then
      IFS='|' read -r _ baseline_pid baseline_exit <<< "$baseline_line"
      if is_failed_snapshot_state "$baseline_pid" "$baseline_exit" && [ "$baseline_exit" = "$exit_code" ]; then
        continue
      fi
    fi

    log "   ❌ ${svc} (재부팅 후 신규 실패, exit=${exit_code})"
    append_report "❌ ${svc} 신규 실패 (exit=${exit_code})"
    ((FAIL++)) || true
  done < "$current_file"

  if [ "$matched_count" -gt 0 ]; then
    OK=$((OK + matched_count))
    log "   ✅ 나머지 launchd 잡 ${matched_count}개 스냅샷 일치"
    append_report "✅ 나머지 launchd 잡 ${matched_count}개 스냅샷 일치"
  fi

  rm -f "$normalized_baseline"
}

run_critical_service_checks

log "📋 나머지 launchd 잡 재부팅 전후 비교"
snapshot_services "$POST_REBOOT_SNAPSHOT_FILE"
compare_service_snapshots "$PRE_REBOOT_SNAPSHOT_FILE" "$POST_REBOOT_SNAPSHOT_FILE"
log "💾 전체 서비스 목록 저장 → $POST_REBOOT_SNAPSHOT_FILE"

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
  STATUS_TEXT="치명 오류 없음, 경고 ${WARN}건 / 정보 ${INFO}건"
else
  STATUS_ICON="❌"
  STATUS_TEXT="오류 ${FAIL}건, 경고 ${WARN}건 / 정보 ${INFO}건"
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
• orchestrator / investment / blog health-report --json 재확인
• reservation health-report --json 재확인
• 필요 시 bash $PROJECT_DIR/scripts/post-reboot.sh --dry-run
• 상태 변화가 있으면 CLAUDE / WORK_HISTORY / CHANGELOG / TEST_RESULTS / RESEARCH_JOURNAL 갱신
EOF
send_telegram "$MSG_FILE"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "✅ 재부팅 후 시작 루틴 완료 (OK: ${OK}, INFO: ${INFO}, WARN: ${WARN}, FAIL: ${FAIL})"
if [ "$FAIL" -gt 0 ] || [ "$WARN" -gt 0 ]; then
  log "⚠️  launchd 상태와 팀별 health-report를 함께 재확인하세요."
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

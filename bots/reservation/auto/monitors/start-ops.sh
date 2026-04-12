#!/bin/bash
# ================================================================
#  start-ops.sh — 스카봇 OPS 모드 (2중 시작 검증)
#
#  [시작 3중]
#   1중 (Shell):  self-lock·디스크·네트워크·secrets 파일 존재 확인
#   2중 (Node):   OPS 가드·필수 keys·DB 파일/테이블·Puppeteer Chrome 검증
#   3중 (Conn):   네이버 HTTP 도달 + 텔레그램 발송 확인
#
#  정상 통과 후 naver-monitor 자동 재시작 루프 진입.
# ================================================================

cd "$(dirname "$0")"

BOT_DIR="$(cd ../.. && pwd)"
LOCK_FILE="$HOME/.openclaw/workspace/naver-monitor.lock"
SELF_LOCK="$HOME/.openclaw/workspace/start-ops.lock"
LOG_FILE="/tmp/naver-ops-mode.log"
NAVER_PROFILE="$HOME/.openclaw/workspace/naver-profile"
NAVER_MONITOR_SCRIPT="/Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js"
KIOSK_PLIST="$HOME/Library/LaunchAgents/ai.ska.kiosk-monitor.plist"
HEADED_FLAG="$BOT_DIR/.playwright-headed"

NODE_BIN="/opt/homebrew/bin/node"
[ ! -x "$NODE_BIN" ] && NODE_BIN=$(which node)

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}
log_err() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1"
  echo "$msg" >&2
  echo "$msg" >> "$LOG_FILE"
}

ensure_launchd_service() {
  local label="$1"
  local plist="$2"
  local service="gui/$(id -u)/$label"

  if launchctl print "$service" >/dev/null 2>&1; then
    return 0
  fi

  if [ ! -f "$plist" ]; then
    log_err "launchd plist 없음: $plist"
    return 1
  fi

  launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1
}

# ================================================================
# ■ 1중 체크 (Shell 레벨)
# ================================================================
log "━━━ [1중 체크] Shell 레벨 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1-1. self-lock: 중복 실행 방지
if [ -f "$SELF_LOCK" ]; then
  OLD_PID=$(cat "$SELF_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log_err "[1중] start-ops.sh 이미 실행 중 (PID: $OLD_PID) — 중복 차단"
    exit 1
  fi
  log "  ℹ️  이전 lock 잔존 (PID=$OLD_PID 종료됨) — 제거"
  rm -f "$SELF_LOCK"
fi
echo $$ > "$SELF_LOCK"
trap "rm -f '$SELF_LOCK'; log '🔓 lock 해제'" EXIT INT TERM
log "  ✅ self-lock 획득 (PID: $$)"

# 1-2. 디스크 여유 공간 확인 (최소 500MB)
AVAIL_KB=$(df -k "$BOT_DIR" | awk 'NR==2 {print $4}')
if [ "${AVAIL_KB:-0}" -lt 512000 ] 2>/dev/null; then
  log_err "[1중] 디스크 공간 부족 (여유: ${AVAIL_KB}KB < 512MB)"
  exit 1
fi
log "  ✅ 디스크 여유 공간 OK ($(( AVAIL_KB / 1024 ))MB)"

# 1-3. secrets.json 파일 존재 확인
SECRETS_FILE="$BOT_DIR/secrets.json"
if [ ! -f "$SECRETS_FILE" ]; then
  log "  ⚠️  secrets.json 없음 — preflight에서 실제 필수 키를 다시 확인"
else
  log "  ✅ secrets.json 존재"
fi

# 1-4. 네트워크 연결 확인 (네이버 스마트플레이스 도달 가능 여부)
if curl -sf --max-time 5 "https://naver.com" -o /dev/null 2>&1; then
  log "  ✅ 네이버 도달 가능"
else
  log_err "[1중] 네이버 연결 불가 — 네트워크 확인 필요"
  exit 1
fi

log "━━━ [1중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 2중 체크 (Node.js 프리플라이트)
# ================================================================
log "━━━ [2중 체크] Node.js 프리플라이트 ━━━━━━━━━━━━━━━━━━━━━━━"

MODE=ops "$NODE_BIN" "$BOT_DIR/scripts/preflight.js" 2>&1 | tee -a "$LOG_FILE"
PREFLIGHT_EXIT=${PIPESTATUS[0]}

if [ $PREFLIGHT_EXIT -ne 0 ]; then
  log_err "[2중] 프리플라이트 실패 — OPS 실행 중단"
  exit 1
fi
log "━━━ [2중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 3중 체크 (API 연결성: 네이버 + 텔레그램)
# ================================================================
log "━━━ [3중 체크] API 연결성 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

MODE=ops "$NODE_BIN" "$BOT_DIR/scripts/preflight.js" --conn 2>&1 | tee -a "$LOG_FILE"
CONN_EXIT=${PIPESTATUS[0]}

if [ $CONN_EXIT -ne 0 ]; then
  log_err "[3중] 연결성 체크 실패 — OPS 실행 중단"
  exit 1
fi
log "━━━ [3중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 이전 프로세스 정리 유틸
# ================================================================
cleanup_old() {
  # 락 파일에서 구 PID 확인
  if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      log "  🔍 구 프로세스 발견 (PID: $OLD_PID) → 종료"
      kill "$OLD_PID" 2>/dev/null
      sleep 2
    fi
    rm -f "$LOCK_FILE"
    log "  🗑️  락 파일 제거"
  fi

  # 잔존 naver-monitor 프로세스 정리
  STALE_PIDS=$(pgrep -f "$NAVER_MONITOR_SCRIPT" 2>/dev/null)
  if [ -n "$STALE_PIDS" ]; then
    log "  🔍 잔존 프로세스 발견 (PID: $STALE_PIDS) → 종료"
    echo "$STALE_PIDS" | xargs kill 2>/dev/null
    sleep 2
  fi

  # naver-profile Chromium 잔존 프로세스 정리 (SingletonLock 해제)
  CHROME_PIDS=$(pgrep -f "$NAVER_PROFILE" 2>/dev/null)
  if [ -n "$CHROME_PIDS" ]; then
    log "  🌐 Chromium 잔존 프로세스 종료 (naver-profile 락 해제)"
    echo "$CHROME_PIDS" | xargs kill 2>/dev/null
    sleep 5
  fi

  # SingletonLock 삭제 (frame detach 원인 방지)
  rm -f "$NAVER_PROFILE/SingletonLock" "$NAVER_PROFILE/SingletonCookie" "$NAVER_PROFILE/SingletonSocket" 2>/dev/null
  log "  🔓 Chrome SingletonLock 제거 완료"

  # 고아 tail -f 프로세스 정리
  ORPHAN_TAILS=$(pgrep -f "tail -f.*(openclaw|pickko|naver-ops)" 2>/dev/null)
  if [ -n "$ORPHAN_TAILS" ]; then
    log "  🧹 고아 tail 프로세스 정리 (PID: $ORPHAN_TAILS)"
    echo "$ORPHAN_TAILS" | xargs kill 2>/dev/null
  fi
}

# ================================================================
# ■ OPS 루프 시작
# ================================================================
log "🚀 ━━━ OPS 모드 자동 재시작 루프 시작 ━━━━━━━━━━━━━━━━━━━━"

# 픽코 키오스크 모니터는 launchd 스케줄에 맡긴다.
# naver-monitor 재기동 직후 강제 kickstart를 하면 CDP/WS 준비 전 연결 경쟁이 발생해
# false warning 또는 connect ECONNREFUSED가 연쇄적으로 생길 수 있다.
if [ "${SKA_KIOSK_KICKSTART_ON_BOOT:-0}" = "1" ]; then
  if ensure_launchd_service "ai.ska.kiosk-monitor" "$KIOSK_PLIST" && \
    launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor 2>/dev/null; then
    log "  🔄 픽코 키오스크 모니터 킥스타트"
  else
    log "  ⚠️  픽코 키오스크 모니터 킥스타트 실패"
  fi
else
  log "  ℹ️  픽코 키오스크 모니터 즉시 kickstart 비활성화 (launchd 주기 사용)"
fi

while true; do
  cleanup_old
  log "▶ naver-monitor 시작"

  NAVER_HEADLESS_VALUE="${NAVER_HEADLESS:-0}"
  PLAYWRIGHT_HEADLESS_VALUE="${PLAYWRIGHT_HEADLESS:-false}"
  if [ -f "$HEADED_FLAG" ]; then
    NAVER_HEADLESS_VALUE=0
    PLAYWRIGHT_HEADLESS_VALUE=false
    log "  👀 headed 플래그 감지 — 보이는 브라우저로 강제 전환"
  fi

  MODE=ops PICKKO_ENABLE=1 STRICT_TIME=1 \
  PLAYWRIGHT_HEADLESS="$PLAYWRIGHT_HEADLESS_VALUE" NAVER_HEADLESS="$NAVER_HEADLESS_VALUE" \
  TELEGRAM_ENABLED=1 NAVER_INTERVAL_MS=300000 \
  OBSERVE_ONLY=${OBSERVE_ONLY:-0} \
  PICKKO_CANCEL_ENABLE=1 \
  PICKKO_HEADLESS=1 \
  PICKKO_PROTOCOL_TIMEOUT_MS=300000 \
  "$NODE_BIN" naver-monitor.js >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?

  log "⏹ naver-monitor 종료 (exit: $EXIT_CODE, 5초 후 재시작...)"

  # 최신 1000줄만 유지
  if [ -f "$LOG_FILE" ]; then
    tail -1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi

  sleep 5
done

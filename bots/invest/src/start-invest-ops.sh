#!/bin/bash
# ================================================================
#  start-invest-ops.sh — 투자봇 OPS 파이프라인 (3중 체크)
#  ⚠️  실제 자산 이동 — 반드시 3중 체크 통과 후 실행
#
#  [시작 3중]
#   1중 (Shell):  lock·좀비·네트워크·디스크·secrets 기본 검증
#   2중 (Node):   OPS가드·DB·스키마·포지션무결성·단주기방지
#   3중 (API):    바이낸스 연결·텔레그램 연결 실제 테스트
#
#  [종료 3중 - Node.js health.js 처리]
#   1중 (Signal): SIGTERM/SIGINT graceful flag
#   2중 (DB):     pending 롤백·포지션 스냅샷·DB close
#   3중 (Cleanup): lock삭제·상태파일·텔레그램 알림
# ================================================================

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BOT_DIR"

LOG_FILE="/tmp/invest-pipeline.log"
SELF_LOCK="/tmp/invest-ops.lock"

NODE_BIN="$HOME/.nvm/versions/node/v24.13.1/bin/node"
[ ! -f "$NODE_BIN" ] && NODE_BIN=$(which node)

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

export INVEST_MODE=ops
export NODE_ENV=production

# ================================================================
# ■ 1중 체크 (Shell 레벨)
# ================================================================
log "━━━ [1중 체크] Shell 레벨 시작 ━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1-1. self-lock: 중복 실행 방지
if [ -f "$SELF_LOCK" ]; then
  OLD_PID=$(cat "$SELF_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log_err "[1중] 파이프라인 이미 실행 중 (PID: $OLD_PID) — 중복 차단"
    exit 1
  fi
  log "  ℹ️  이전 lock 잔존 (PID=$OLD_PID 종료됨) — 제거"
  rm -f "$SELF_LOCK"
fi
echo $$ > "$SELF_LOCK"
trap "rm -f '$SELF_LOCK'; log '🔓 lock 해제'" EXIT INT TERM
log "  ✅ self-lock 획득 (PID: $$)"

# 1-2. 잔존 invest 프로세스 정리
ZOMBIE_PIDS=$(pgrep -f "node.*invest.*(signal-aggregator|binance-executor)" 2>/dev/null | grep -v $$)
if [ -n "$ZOMBIE_PIDS" ]; then
  log "  ⚠️  잔존 invest 프로세스 발견 → 종료 (PID: $ZOMBIE_PIDS)"
  echo "$ZOMBIE_PIDS" | xargs kill 2>/dev/null
  sleep 2
  log "  ✅ 잔존 프로세스 정리 완료"
else
  log "  ✅ 잔존 프로세스 없음"
fi

# 1-3. 네트워크 연결 확인 (바이낸스 도달 가능 여부)
if curl -sf --max-time 5 "https://api.binance.com/api/v3/ping" > /dev/null 2>&1; then
  log "  ✅ 바이낸스 API 도달 가능"
else
  log_err "[1중] 바이낸스 API 연결 불가 (네트워크 확인 필요)"
  exit 1
fi

# 1-4. 디스크 여유 공간 확인 (최소 500MB)
AVAIL_KB=$(df -k "$BOT_DIR" | awk 'NR==2 {print $4}')
if [ "${AVAIL_KB:-0}" -lt 512000 ] 2>/dev/null; then
  log_err "[1중] 디스크 공간 부족 (여유: ${AVAIL_KB}KB < 512MB)"
  exit 1
fi
log "  ✅ 디스크 여유 공간 OK ($(( AVAIL_KB / 1024 ))MB)"

# 1-5. secrets.json 기본 확인 (Shell에서 빠른 pre-check)
DRY_RUN_VAL=$("$NODE_BIN" -e "
  try { process.stdout.write(String(require('./lib/secrets').loadSecrets().dry_run)); }
  catch(e) { process.stdout.write('error'); }
" 2>/dev/null)
if [ "$DRY_RUN_VAL" != "false" ]; then
  log_err "[1중] secrets.json dry_run=${DRY_RUN_VAL} (false여야 함)"
  exit 1
fi
log "  ✅ secrets.json dry_run=false"

log "━━━ [1중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 2중 체크 (Node.js 레벨)
# ================================================================
log "━━━ [2중 체크] Node.js 프리플라이트 ━━━━━━━━━━━━━━━━━━━━━━"

"$NODE_BIN" -e "
const { preflightSystemCheck } = require('./lib/health');
preflightSystemCheck()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 | tee -a "$LOG_FILE"
PREFLIGHT_EXIT=${PIPESTATUS[0]}

if [ $PREFLIGHT_EXIT -ne 0 ]; then
  log_err "[2중] Node.js 프리플라이트 실패 — OPS 실행 중단"
  exit 1
fi
log "━━━ [2중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 3중 체크 (API 연결성)
# ================================================================
log "━━━ [3중 체크] API 연결성 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

"$NODE_BIN" -e "
const { preflightConnCheck } = require('./lib/health');
preflightConnCheck()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 | tee -a "$LOG_FILE"
CONN_EXIT=${PIPESTATUS[0]}

if [ $CONN_EXIT -ne 0 ]; then
  log_err "[3중] API 연결 실패 — OPS 실행 중단"
  exit 1
fi
log "━━━ [3중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ OPS 경고 카운트다운 (TTY 있을 때만)
# ================================================================
if [ -t 0 ]; then
  echo ""
  echo "⚠️  ════════════════════════════════════════"
  echo "⚠️   3중 체크 전체 통과 — OPS 모드 진입"
  echo "⚠️   실제 바이낸스 주문이 실행됩니다"
  echo "⚠️  ════════════════════════════════════════"
  echo ""
  echo "5초 후 시작합니다. 취소: Ctrl+C"
  for i in 5 4 3 2 1; do printf "  %d...\r" $i; sleep 1; done
  echo ""
fi

# ================================================================
# ■ OPS 파이프라인 실행
# ================================================================
log "🚀 ━━━ OPS 파이프라인 시작 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# heartbeat 기록 (시작)
"$NODE_BIN" -e "require('./lib/health').recordHeartbeat({ status: 'running' });" 2>/dev/null

PIPELINE_OK=true

# Step 1: 신호 집계 (TA + LLM + 신호 DB 저장)
log "  📊 [Step 1] 신호 집계..."
"$NODE_BIN" src/analysts/signal-aggregator.js >> "$LOG_FILE" 2>&1
SIG_EXIT=$?
if [ $SIG_EXIT -ne 0 ]; then
  log_err "  [Step 1] 신호 집계 실패 (exit: $SIG_EXIT)"
  PIPELINE_OK=false
else
  log "  ✅ [Step 1] 신호 집계 완료"

  # Step 2: 실행봇 (pending 신호 처리 → 리스크 → 주문)
  log "  ⚡ [Step 2] 실행봇..."
  "$NODE_BIN" src/binance-executor.js >> "$LOG_FILE" 2>&1
  EXE_EXIT=$?
  if [ $EXE_EXIT -ne 0 ]; then
    log_err "  [Step 2] 실행봇 실패 (exit: $EXE_EXIT)"
    PIPELINE_OK=false
  else
    log "  ✅ [Step 2] 실행봇 완료"
  fi
fi

# heartbeat 기록 (완료)
if $PIPELINE_OK; then
  "$NODE_BIN" -e "require('./lib/health').recordHeartbeat({ status: 'idle' });" 2>/dev/null
  log "🏁 ━━━ OPS 파이프라인 정상 완료 ━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  "$NODE_BIN" -e "require('./lib/health').recordHeartbeat({ status: 'error', error: 'pipeline failed' });" 2>/dev/null
  log_err "━━━ OPS 파이프라인 오류 종료 ━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
fi

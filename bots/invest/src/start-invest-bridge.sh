#!/bin/bash
# ================================================================
#  start-invest-bridge.sh — 업비트 브릿지 OPS (3중 체크)
#  ⚠️  실제 자산 이동 (KRW ↔ USDT 전환, 바이낸스 전송)
# ================================================================

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BOT_DIR"

LOG_FILE="/tmp/invest-bridge.log"
SELF_LOCK="/tmp/invest-bridge.lock"

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
# ■ 1중 체크 (Shell)
# ================================================================
log "━━━ [1중 체크] Shell 레벨 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1-1. self-lock
if [ -f "$SELF_LOCK" ]; then
  OLD_PID=$(cat "$SELF_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log_err "[1중] 브릿지 이미 실행 중 (PID: $OLD_PID)"
    exit 1
  fi
  rm -f "$SELF_LOCK"
fi
echo $$ > "$SELF_LOCK"
trap "rm -f '$SELF_LOCK'; log '🔓 bridge lock 해제'" EXIT INT TERM
log "  ✅ self-lock 획득 (PID: $$)"

# 1-2. 네트워크 확인 (업비트 + 바이낸스)
if curl -sf --max-time 5 "https://api.upbit.com/v1/market/all" > /dev/null 2>&1; then
  log "  ✅ 업비트 API 도달 가능"
else
  log_err "[1중] 업비트 API 연결 불가"
  exit 1
fi

# 1-3. secrets 기본 확인
DRY_RUN_VAL=$("$NODE_BIN" -e "
  try { process.stdout.write(String(require('./lib/secrets').loadSecrets().dry_run)); }
  catch(e) { process.stdout.write('error'); }
" 2>/dev/null)
if [ "$DRY_RUN_VAL" != "false" ]; then
  log_err "[1중] dry_run=${DRY_RUN_VAL} — 브릿지 차단"
  exit 1
fi

UPBIT_LEN=$("$NODE_BIN" -e "
  try { process.stdout.write(String((require('./lib/secrets').loadSecrets().upbit_access_key||'').length)); }
  catch(e) { process.stdout.write('0'); }
" 2>/dev/null)
if [ "${UPBIT_LEN:-0}" -lt 10 ] 2>/dev/null; then
  log_err "[1중] upbit_access_key 미설정"
  exit 1
fi
log "  ✅ secrets 기본 확인 완료"

log "━━━ [1중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 2중 체크 (Node.js — 업비트 브릿지 전용)
# ================================================================
log "━━━ [2중 체크] Node.js 프리플라이트 ━━━━━━━━━━━━━━━━━━━━━━"

"$NODE_BIN" -e "
const { preflightSystemCheck } = require('./lib/health');
preflightSystemCheck()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 | tee -a "$LOG_FILE"
PF_EXIT=${PIPESTATUS[0]}

if [ $PF_EXIT -ne 0 ]; then
  log_err "[2중] Node.js 프리플라이트 실패"
  exit 1
fi
log "━━━ [2중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 3중 체크 (API — 업비트 잔고 조회 테스트)
# ================================================================
log "━━━ [3중 체크] API 연결성 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

"$NODE_BIN" -e "
const { fetchBalance } = require('./lib/upbit');
fetchBalance()
  .then(b => { console.log('      ✅ 업비트 잔고 조회 OK (KRW:', b.KRW.toLocaleString(), ')'); process.exit(0); })
  .catch(e => { console.error('      ❌ 업비트 잔고 조회 실패:', e.message); process.exit(1); });
" 2>&1 | tee -a "$LOG_FILE"
CONN_EXIT=${PIPESTATUS[0]}

if [ $CONN_EXIT -ne 0 ]; then
  log_err "[3중] 업비트 API 연결 실패 — 브릿지 중단"
  exit 1
fi
log "━━━ [3중 체크] 통과 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ================================================================
# ■ 브릿지 실행
# ================================================================
log "🌉 ━━━ 업비트 브릿지 시작 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

"$NODE_BIN" src/upbit-bridge.js >> "$LOG_FILE" 2>&1
BRIDGE_EXIT=$?

if [ $BRIDGE_EXIT -ne 0 ]; then
  log_err "━━━ 브릿지 오류 종료 (exit: $BRIDGE_EXIT) ━━━━━━━━━━━━━━━━━"
  exit 1
fi
log "🏁 ━━━ 브릿지 정상 완료 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

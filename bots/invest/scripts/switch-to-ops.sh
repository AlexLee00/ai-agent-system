#!/bin/bash
# ================================================================
#  switch-to-ops.sh — 루나팀 DEV → OPS 전환 체크리스트
#
#  이 스크립트는 전환 전 사전 점검만 수행합니다.
#  실제 전환은 마지막에 사용자 확인 후 진행합니다.
#
#  실행: bash bots/invest/scripts/switch-to-ops.sh
# ================================================================

cd "$(cd "$(dirname "$0")/.." && pwd)"

NODE_BIN="$HOME/.nvm/versions/node/v24.13.1/bin/node"
[ ! -f "$NODE_BIN" ] && NODE_BIN=$(which node)

PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; }
sep()  { echo ""; echo "─────────────────────────────────────────"; }

echo ""
echo "🔍 루나팀 DEV → OPS 전환 사전 점검"
echo "═════════════════════════════════════════"

# ─── 1. secrets.json 확인 ───────────────────────────────────────
sep
echo "① secrets.json 설정 확인"

check_secret() {
  local key=$1 desc=$2
  local val
  val=$("$NODE_BIN" -e "
    try {
      const v = require('./lib/secrets').loadSecrets()['$key'] || '';
      process.stdout.write(String(v.length));
    } catch { process.stdout.write('0'); }
  " 2>/dev/null)
  if [ "${val:-0}" -ge 10 ] 2>/dev/null; then ok "$desc 설정됨"
  else fail "$desc 미설정 (secrets.json 확인 필요)"; fi
}

DRY_RUN=$("$NODE_BIN" -e "
  try { process.stdout.write(String(require('./lib/secrets').loadSecrets().dry_run)); }
  catch { process.stdout.write('error'); }
" 2>/dev/null)
# dry_run=true가 DEV 기본값. OPS 전환 직전에 false로 바꿈
if [ "$DRY_RUN" = "false" ]; then
  warn "dry_run=false — OPS 모드 준비됨 (DEV 개발 중엔 true 권장)"
  ((PASS++))
else
  ok "dry_run=${DRY_RUN} (DEV 안전 모드)"
  warn "OPS 전환 직전: secrets.json dry_run → false 로 변경 필요"
fi

check_secret "binance_api_key"    "binance_api_key"
check_secret "binance_api_secret" "binance_api_secret"
check_secret "telegram_bot_token" "telegram_bot_token"
check_secret "anthropic_api_key"  "anthropic_api_key"

# ─── 2. 네트워크 연결 ───────────────────────────────────────────
sep
echo "② 외부 API 연결 확인"

if curl -sf --max-time 5 "https://api.binance.com/api/v3/ping" > /dev/null 2>&1; then
  ok "바이낸스 API 도달 가능"
else
  fail "바이낸스 API 연결 불가"
fi

TG_TOKEN=$("$NODE_BIN" -e "
  try { process.stdout.write(require('./lib/secrets').loadSecrets().telegram_bot_token || ''); }
  catch { process.stdout.write(''); }
" 2>/dev/null)
if [ -n "$TG_TOKEN" ]; then
  TG_STATUS=$(curl -sf --max-time 5 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if d.get('ok') else 'fail')" 2>/dev/null || echo "fail")
  if [ "$TG_STATUS" = "ok" ]; then ok "텔레그램 봇 토큰 유효"
  else fail "텔레그램 봇 토큰 무효"; fi
fi

# ─── 3. 바이낸스 잔고 확인 ─────────────────────────────────────
sep
echo "③ 바이낸스 잔고 확인"

BALANCE=$("$NODE_BIN" -e "
  const { fetchBalance } = require('./lib/binance');
  fetchBalance().then(b => {
    const usdt = b?.USDT?.free ?? b?.free?.USDT ?? 0;
    console.log(usdt.toFixed(2));
  }).catch(e => console.log('error: ' + e.message));
" 2>/dev/null)

if [[ "$BALANCE" =~ ^[0-9] ]]; then
  ok "바이낸스 USDT 잔고: \$${BALANCE}"
  if (( $(echo "$BALANCE < 10" | python3 -c "import sys; print(int(eval(sys.stdin.read())))") )); then
    warn "잔고가 \$10 미만 — OPS 실거래 전 USDT 충전 권장"
  fi
else
  fail "바이낸스 잔고 조회 실패: ${BALANCE}"
fi

# ─── 4. DEV launchd 서비스 현황 ────────────────────────────────
sep
echo "④ DEV launchd 서비스 현황 (OPS 전환 시 중지 필요)"

DEV_SERVICES=("ai.invest.dev" "ai.invest.tpsl" "ai.invest.fund" "ai.invest.report" "ai.invest.bridge")
for svc in "${DEV_SERVICES[@]}"; do
  status=$(launchctl list | grep "$svc" 2>/dev/null | awk '{print $1}')
  if [ -n "$status" ]; then
    warn "$svc 등록됨 → OPS 전환 전 unload 필요"
  else
    ok "$svc 미등록 (정상)"
  fi
done

# ─── 5. DB 무결성 ───────────────────────────────────────────────
sep
echo "⑤ DB 무결성 확인"

"$NODE_BIN" -e "
const db = require('./lib/db');
db.query('SELECT COUNT(*) as cnt FROM signals WHERE status=\'pending\'').then(r => {
  const cnt = r[0]?.cnt ?? 0;
  if (cnt > 0) console.log('warn: pending 신호 ' + cnt + '건 — OPS 전환 전 처리 권장');
  else console.log('ok: pending 신호 없음');
}).catch(e => console.log('error: ' + e.message));
" 2>/dev/null | while read -r line; do
  if [[ "$line" == ok* ]]; then ok "${line#ok: }"
  elif [[ "$line" == warn* ]]; then warn "${line#warn: }"; ((PASS++))
  else fail "${line#error: }"; fi
done

# ─── 결과 ───────────────────────────────────────────────────────
sep
echo ""
echo "═════════════════════════════════════════"
echo "  결과: ✅ ${PASS}개 통과  ❌ ${FAIL}개 실패"
echo "═════════════════════════════════════════"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "  ❌ 실패 항목 해결 후 재실행하세요."
  echo ""
  exit 1
fi

echo ""
echo "  ✅ 모든 항목 통과 — OPS 전환 준비 완료"
echo ""
echo "  OPS 전환 순서:"
echo "  1. DEV 서비스 중지:"
for svc in "${DEV_SERVICES[@]}"; do
  echo "       launchctl unload ~/Library/LaunchAgents/${svc}.plist"
done
echo "  2. secrets.json: dry_run=false 확인 (이미 완료)"
echo "  3. OPS 파이프라인 실행:"
echo "       bash bots/invest/src/start-invest-ops.sh"
echo ""

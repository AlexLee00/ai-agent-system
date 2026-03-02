#!/bin/bash
# ─────────────────────────────────────────────────────────
# post-reboot.sh — 재부팅 후 시작 루틴
# launchd ai.agent.post-reboot.plist → RunAtLoad=true 자동 실행
# 수동 실행: bash scripts/post-reboot.sh
# ─────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="$HOME/projects/ai-agent-system"
LOG_FILE="/tmp/post-reboot.log"
CHAT_ID=***REMOVED***

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

send_telegram() {
  local msg="$1"
  /Users/alexlee/.nvm/versions/node/v24.13.1/bin/node -e "
    try {
      const s = require('$PROJECT_DIR/bots/reservation/lib/secrets.js');
      const { telegram_bot_token: tok, telegram_chat_id: cid } = s.loadSecrets(['telegram_bot_token','telegram_chat_id']);
      const https = require('https');
      const body = JSON.stringify({ chat_id: cid, text: '$msg', parse_mode: 'Markdown' });
      const req = https.request({ hostname:'api.telegram.org', path:'/bot'+tok+'/sendMessage', method:'POST', headers:{'Content-Type':'application/json'} }, ()=>{});
      req.on('error', ()=>{});
      req.write(body); req.end();
      setTimeout(()=>{}, 3000);
    } catch(e) {}
  " 2>/dev/null || true
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
REPORT=""
OK=0
FAIL=0

check_svc() {
  local svc="$1"
  local label="$2"
  local pid
  pid=$(launchctl list 2>/dev/null | awk -v s="$svc" '$3==s {print $1}')
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" != "0" ]; then
    log "   ✅ ${label} (PID: ${pid})"
    REPORT="${REPORT}✅ ${label}%0A"
    ((OK++)) || true
  else
    log "   ❌ ${label} 미실행"
    REPORT="${REPORT}❌ ${label}%0A"
    ((FAIL++)) || true
  fi
}

log "📡 OpenClaw / 스카팀:"
check_svc "ai.openclaw.gateway"    "OpenClaw 게이트웨이"
check_svc "ai.ska.naver-monitor"   "앤디 (네이버 모니터)"
check_svc "ai.ska.kiosk-monitor"   "지미 (키오스크 모니터)"

log "💹 루나팀:"
check_svc "ai.invest.dev"          "제이슨 (신호 집계, 10분)"
check_svc "ai.invest.bridge"       "몰리 (업비트 브릿지, 1시간)"

log "🤖 클로드팀:"
check_svc "ai.claude.dexter"       "덱스터 (시스템 점검, 1시간)"

log "🔄 공통 에이전트:"
check_svc "ai.agent.auto-commit"   "auto-commit"
check_svc "ai.agent.nightly-sync"  "nightly-sync"

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

MSG="🖥️ *맥북 재부팅 완료* (${BOOT_TIME})%0A${STATUS_ICON} ${STATUS_TEXT}%0A%0A${REPORT}%0A마지막 커밋: ${LAST_COMMIT}"
send_telegram "$MSG"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "✅ 재부팅 후 시작 루틴 완료 (OK: ${OK}, FAIL: ${FAIL})"
if [ "$FAIL" -gt 0 ]; then
  log "⚠️  일부 서비스 미실행 — skastatus 명령으로 수동 확인 필요"
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

#!/bin/bash
# ─────────────────────────────────────────────────────────
# pre-reboot.sh — 재부팅 전 안전 종료 루틴
# 사용법: bash scripts/pre-reboot.sh
# ─────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="$HOME/projects/ai-agent-system"
LOG_FILE="/tmp/pre-reboot.log"
CHAT_ID=***REMOVED***

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

send_telegram() {
  local msg_file="$1"
  /Users/alexlee/.nvm/versions/node/v24.13.1/bin/node -e "
    const fs = require('fs');
    const sender = require('$PROJECT_DIR/packages/core/lib/telegram-sender');
    const text = fs.readFileSync('$msg_file', 'utf-8');
    sender.send('claude-lead', text).catch(() => {});
    setTimeout(() => {}, 3000);
  " 2>/dev/null || true
}

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🔄 재부팅 전 안전 종료 루틴 시작"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. 미커밋 변경사항 확인 ──────────────────────────────
cd "$PROJECT_DIR"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  log "⚠️  미커밋 변경사항 있음 — git commit 후 재부팅 권장"
  git status --short 2>/dev/null | head -10 | while read line; do log "   $line"; done
else
  log "✅ Git 상태 클린"
fi

# ── 2. 루나팀 투자 서비스 정지 (데이터 안전) ────────────
log "⏹️  루나팀 투자 서비스 정지 중..."
for svc in ai.investment.crypto ai.investment.domestic ai.investment.overseas; do
  if launchctl list 2>/dev/null | grep -q "	${svc}$"; then
    launchctl stop "$svc" 2>/dev/null && log "   ✅ $svc 정지" || log "   ⚠️ $svc 정지 실패"
  fi
done

# ── 3. 클로드팀 서비스 정지 ──────────────────────────────
log "⏹️  클로드팀 서비스 정지 중..."
for svc in ai.claude.dexter ai.claude.archer ai.claude.speed-test; do
  if launchctl list 2>/dev/null | grep -q "	${svc}$"; then
    launchctl stop "$svc" 2>/dev/null && log "   ✅ $svc 정지" || true
  fi
done

# ── 4. 스카팀 모니터 graceful 종료 ──────────────────────
log "⏹️  스카팀 모니터 종료 신호 전송..."
# KeepAlive 서비스 — stop하면 launchd가 즉시 재시작하지만 재부팅 시 자동 복구됨
for svc in ai.ska.naver-monitor ai.ska.kiosk-monitor; do
  if launchctl list 2>/dev/null | grep -q "	${svc}$"; then
    launchctl stop "$svc" 2>/dev/null && log "   ✅ $svc 종료 신호" || true
  fi
done

# ── 5. OpenClaw 게이트웨이 정지 ──────────────────────────
log "⏹️  OpenClaw 게이트웨이 정지..."
launchctl stop ai.openclaw.gateway 2>/dev/null && log "   ✅ OpenClaw 게이트웨이 정지" || true

# ── 6. 현재 launchd 서비스 상태 스냅샷 저장 ─────────────
log "💾 launchd 서비스 상태 스냅샷 저장 → /tmp/pre-reboot-services.txt"
launchctl list 2>/dev/null | grep "	ai\." | sort > /tmp/pre-reboot-services.txt

# ── 7. 재부팅 시각 기록 ──────────────────────────────────
date '+%Y-%m-%dT%H:%M:%S KST' > /tmp/last-reboot-time.txt
log "📝 재부팅 시각 기록: $(cat /tmp/last-reboot-time.txt)"

# ── 8. 텔레그램 알림 ─────────────────────────────────────
REBOOT_TIME=$(date '+%H:%M:%S')
PRE_MSG_FILE="/tmp/pre-reboot-msg.txt"
cat > "$PRE_MSG_FILE" << EOF
🔄 <b>맥북 재부팅 준비 완료</b> (${REBOOT_TIME})

모든 봇 서비스 안전 종료
재부팅 후 자동 재시작 예정

[재부팅 후 확인]
• 텔레그램 '부팅완료' 알림 대기 (약 1분 소요)
• skastatus 명령으로 서비스 상태 확인
EOF
send_telegram "$PRE_MSG_FILE"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "✅ 재부팅 전 종료 루틴 완료!"
log "→ 지금 sudo reboot 또는 Apple 메뉴 > 재시작 실행 가능"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

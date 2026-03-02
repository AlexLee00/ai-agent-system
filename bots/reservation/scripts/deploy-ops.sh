#!/bin/bash
# ================================================================
#  scripts/deploy-ops.sh — 스카봇 OPS 배포 스크립트
#
#  흐름:
#    1. E2E 테스트 (28개 케이스 전체 통과 필수)
#    2. 사용자 최종 컨펌 (--yes 플래그로 생략 가능)
#    3. OPS launchd 재시작 (naver-monitor + kiosk-monitor)
#    4. 재시작 확인 (10초 대기 후 프로세스 생존 여부 검증)
#    5. 덱스터 체크섬 갱신 + 텔레그램 배포 완료 알림
#
#  사용법:
#    bash scripts/deploy-ops.sh          # 대화형 컨펌
#    bash scripts/deploy-ops.sh --yes    # 자동 컨펌 (CI/자동화용)
#    bash scripts/deploy-ops.sh --dry    # 실제 재시작 없이 플로우만 확인
# ================================================================

set -euo pipefail

# ── 경로 설정 ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/tmp/ska-deploy.log"

NODE_BIN="$HOME/.nvm/versions/node/v24.13.1/bin/node"
[ ! -f "$NODE_BIN" ] && NODE_BIN=$(which node)

DEXTER_SCRIPT="$HOME/projects/ai-agent-system/bots/claude/src/dexter.js"

# ── 플래그 파싱 ──────────────────────────────────────────────────
AUTO_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)  AUTO_YES=1 ;;
    --dry)     DRY_RUN=1  ;;
  esac
done

# ── 로그 헬퍼 ───────────────────────────────────────────────────
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
log_ok() { log "✅ $1"; }

# ── 텔레그램 알림 헬퍼 ─────────────────────────────────────────
send_telegram() {
  local msg="$1"
  cd "$BOT_DIR"
  # printf → stdin 으로 메시지 전달 (멀티라인·특수문자 안전)
  printf '%s' "$msg" | "$NODE_BIN" -e "
    const { sendTelegram } = require('./lib/telegram');
    let msg = '';
    process.stdin.on('data', d => msg += d);
    process.stdin.on('end', () => {
      sendTelegram(msg).then(() => process.exit(0)).catch(() => process.exit(0));
    });
  " 2>/dev/null || true
  cd - > /dev/null
}

# ── 0. 헤더 ─────────────────────────────────────────────────────
echo ""
echo "🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀   스카봇 OPS 배포 스크립트"
[ "$DRY_RUN" -eq 1 ] && echo "🔍   DRY-RUN 모드 (실제 재시작 없음)"
echo "🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. E2E 테스트 ────────────────────────────────────────────────
log "━━━ [1단계] E2E 테스트 실행 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$BOT_DIR"
if TELEGRAM_ENABLED=0 "$NODE_BIN" scripts/e2e-test.js 2>&1 | tee -a "$LOG_FILE"; then
  log_ok "E2E 테스트 전체 통과"
else
  log_err "E2E 테스트 실패 — 배포 중단"
  send_telegram "❌ [스카봇 배포 실패] E2E 테스트 미통과 — 배포 중단"
  exit 1
fi
cd - > /dev/null

# ── 2. 사용자 컨펌 ───────────────────────────────────────────────
log "━━━ [2단계] 배포 컨펌 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$AUTO_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo ""
  echo "  📋 배포 대상:"
  echo "     - ai.ska.naver-monitor  (OPS 재시작)"
  echo "     - ai.ska.kiosk-monitor  (OPS 재시작)"
  echo ""
  read -r -p "  OPS에 배포하겠습니까? (yes/N): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    log "  배포 취소 (사용자 중단)"
    exit 0
  fi
fi

log_ok "컨펌 완료 — 배포 진행"

if [ "$DRY_RUN" -eq 1 ]; then
  log "  [DRY-RUN] launchctl 재시작 건너뜀"
  log "  [DRY-RUN] 배포 완료 (실제 재시작 없음)"
  echo ""
  echo "✅ DRY-RUN 완료. --yes 플래그 없이 재실행하면 실제 배포됩니다."
  exit 0
fi

# ── 3. OPS 재시작 ────────────────────────────────────────────────
log "━━━ [3단계] OPS 재시작 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

send_telegram "🚀 [스카봇 배포 시작] OPS 재시작 중..."

# naver-monitor 재시작 (KeepAlive라 kickstart -k 로 즉시 재시작)
log "  naver-monitor 재시작..."
if launchctl kickstart -k "gui/$UID/ai.ska.naver-monitor" 2>&1 | tee -a "$LOG_FILE"; then
  log_ok "naver-monitor kickstart 완료"
else
  log_err "naver-monitor kickstart 실패"
  send_telegram "❌ [스카봇 배포 실패] naver-monitor kickstart 실패"
  exit 1
fi

# kiosk-monitor 재시작
log "  kiosk-monitor 재시작..."
launchctl kickstart -k "gui/$UID/ai.ska.kiosk-monitor" 2>&1 | tee -a "$LOG_FILE" || \
  log "  ⚠️  kiosk-monitor kickstart 실패 (무시하고 진행)"

# ── 4. 재시작 확인 (최대 60초, 5초 간격 재시도) ──────────────────
log "━━━ [4단계] 재시작 확인 (최대 60초 대기) ━━━━━━━━━━━━━━━━━━"
# start-ops.sh가 1중+2중+3중 체크를 완료하는 데 30~40초 소요됨
MONITOR_PID=""
for i in $(seq 1 12); do
  sleep 5
  MONITOR_PID=$(launchctl list | awk '/ai.ska.naver-monitor/ {print $1}')
  if [ -n "$MONITOR_PID" ] && [ "$MONITOR_PID" != "-" ]; then
    break
  fi
  log "  ⏳ 대기 중... (${i}/12, ${MONITOR_PID:-시작 중})"
done

if [ -n "$MONITOR_PID" ] && [ "$MONITOR_PID" != "-" ]; then
  log_ok "naver-monitor 정상 실행 중 (PID: $MONITOR_PID)"
else
  log_err "naver-monitor 실행 확인 실패 (60초 초과)"
  log "  💡 로그 확인: tail -50 /tmp/naver-ops-mode.log"
  send_telegram "⚠️ [스카봇 배포] naver-monitor 60초 내 실행 미확인 — 로그 확인 필요"
  exit 1
fi

# ── 5. 덱스터 체크섬 갱신 ───────────────────────────────────────
log "━━━ [5단계] 덱스터 체크섬 갱신 ━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f "$DEXTER_SCRIPT" ]; then
  if "$NODE_BIN" "$DEXTER_SCRIPT" --update-checksums 2>&1 | tee -a "$LOG_FILE"; then
    log_ok "체크섬 갱신 완료"
  else
    log "  ⚠️  체크섬 갱신 실패 (배포는 성공)"
  fi
else
  log "  ⚠️  dexter.js 없음 — 체크섬 갱신 건너뜀"
fi

# ── 완료 ─────────────────────────────────────────────────────────
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
log "━━━ 배포 완료 ($TIMESTAMP) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

send_telegram "✅ [스카봇 배포 완료]
시각: $TIMESTAMP
E2E: 28/28 통과
OPS: naver-monitor 재시작 확인 (PID: $MONITOR_PID)
로그: /tmp/ska-deploy.log"

echo ""
echo "🎉 배포 완료!"
echo "   로그: tail -f /tmp/naver-ops-mode.log"
echo ""

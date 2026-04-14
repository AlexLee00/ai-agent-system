#!/bin/bash
# scripts/disaster-recovery.sh — 재해 복구 스크립트
#
# 맥미니 장애 시 맥북에서 즉시 OPS 전환 (목표 30분 이내)
# ⚠️ 반드시 최신 백업 파일이 있어야 함
#
# 사용법:
#   bash scripts/disaster-recovery.sh              # 전체 복구
#   bash scripts/disaster-recovery.sh --dry-run    # 절차만 확인
#   bash scripts/disaster-recovery.sh --status     # 현재 상태만 확인
set -euo pipefail

DRY_RUN=false
STATUS_ONLY=false

for arg in "$@"; do
  case $arg in
    --dry-run)   DRY_RUN=true ;;
    --status)    STATUS_ONLY=true ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$HOME/.openclaw/workspace/backups"
LAUNCHD_DIR="$PROJECT_DIR/scripts/launchd"

# ── 색상 ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "  ${RED}❌ $1${NC}"; }
info() { echo -e "  ℹ️  $1"; }

run() {
  if $DRY_RUN; then echo "  [DRY-RUN] $*"; return 0; fi
  eval "$@"
}

# ── 상태 확인 모드 ────────────────────────────────────────────────
if $STATUS_ONLY; then
  echo ""
  echo "🔍 현재 복구 준비 상태"
  echo "══════════════════════════════════"

  # 최신 백업 파일
  LATEST=$(ls "$BACKUP_DIR"/*.sql 2>/dev/null | sort -r | head -1 || echo "")
  if [ -n "$LATEST" ]; then
    AGE=$(( ($(date +%s) - $(stat -f '%m' "$LATEST" 2>/dev/null || stat -c '%Y' "$LATEST")) / 3600 ))
    ok "최신 백업: $(basename $LATEST) (${AGE}시간 전)"
    [ "$AGE" -gt 24 ] && warn "백업 24시간 초과 — node scripts/migration/backup-verify.js --backup 실행 권장"
  else
    err "백업 없음 — node scripts/migration/backup-verify.js --backup 실행 필요"
  fi

  # PostgreSQL
  if pg_isready -d jay -q 2>/dev/null; then ok "PostgreSQL jay DB 실행 중"; else err "PostgreSQL 미실행"; fi

  # secrets.json
  [ -f "$PROJECT_DIR/bots/reservation/secrets.json" ] && ok "secrets.json 존재" || err "secrets.json 없음"

  # launchd plist
  PLIST_COUNT=$(ls "$LAUNCHD_DIR"/*.plist 2>/dev/null | wc -l | tr -d ' ')
  ok "launchd plist: ${PLIST_COUNT}개"

  echo ""
  exit 0
fi

# ════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  🚨 재해 복구 시작 (맥북 → OPS 전환)             ║"
echo "╚══════════════════════════════════════════════════╝"
$DRY_RUN && warn "DRY-RUN 모드 — 실제 변경 없음"
echo ""

START_TIME=$(date +%s)

# ── 1단계: 최신 백업 확인 ─────────────────────────────────────────
echo "1/5 백업 파일 확인..."
LATEST=$(ls "$BACKUP_DIR"/*.sql 2>/dev/null | sort -r | head -1 || true)
if [ -z "$LATEST" ]; then
  err "백업 없음 — 복구 불가"
  echo "  먼저 맥미니에서 백업을 가져오세요:"
  echo "  scp mac-mini:~/.openclaw/workspace/backups/jay_latest.sql $BACKUP_DIR/"
  exit 1
fi
AGE=$(( ($(date +%s) - $(stat -f '%m' "$LATEST" 2>/dev/null || stat -c '%Y' "$LATEST")) / 3600 ))
ok "최신 백업: $(basename $LATEST) (${AGE}시간 전)"
[ "$AGE" -gt 24 ] && warn "주의: 백업 파일이 24시간 이상 오래됨"

# ── 2단계: PostgreSQL 복구 ─────────────────────────────────────────
echo ""
echo "2/5 PostgreSQL 복구..."
if pg_isready -d jay -q 2>/dev/null; then
  info "기존 jay DB 존재 — 스킵 (데이터 유지)"
  info "새 데이터로 덮어쓰려면: dropdb jay && createdb jay && psql jay < $(basename $LATEST)"
  ok "PostgreSQL: 기존 DB 사용"
else
  warn "jay DB 없음 — 백업에서 복원"
  run "createdb jay"
  run "psql jay -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'"
  run "psql jay < '$LATEST'"
  ok "PostgreSQL 복원 완료"
fi

# ── 3단계: 서비스 설정 확인 ────────────────────────────────────────
echo ""
echo "3/5 서비스 설정 확인..."

if [ -f "$PROJECT_DIR/bots/reservation/secrets.json" ]; then
  ok "secrets.json 존재"
else
  err "secrets.json 없음 — 수동 복사 필요"
  echo "  scp mac-mini:~/projects/ai-agent-system/bots/reservation/secrets.json $PROJECT_DIR/bots/reservation/"
  exit 1
fi

if [ -d "$PROJECT_DIR/node_modules" ]; then
  ok "npm install 완료"
else
  warn "node_modules 없음 — npm install 실행"
  run "cd '$PROJECT_DIR' && npm install"
fi

# ── 4단계: launchd 서비스 등록 ────────────────────────────────────
echo ""
echo "4/5 launchd 서비스 등록..."

if [ -d "$LAUNCHD_DIR" ]; then
  PLIST_COUNT=$(ls "$LAUNCHD_DIR"/*.plist 2>/dev/null | wc -l | tr -d ' ')
  info "plist 파일: ${PLIST_COUNT}개"

  if $DRY_RUN; then
    info "[DRY-RUN] launchctl bootstrap gui/\$(id -u) 각 plist"
  else
    for plist in "$LAUNCHD_DIR"/*.plist; do
      SERVICE=$(basename "$plist" .plist)
      launchctl bootout "gui/$(id -u)/$SERVICE" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && \
        info "등록: $SERVICE" || warn "등록 실패: $SERVICE"
    done
  fi
  ok "launchd 서비스 등록 완료"
else
  warn "launchd plist 디렉토리 없음: $LAUNCHD_DIR"
fi

# ── 5단계: 헬스체크 + 텔레그램 알림 ─────────────────────────────
echo ""
echo "5/5 헬스체크 + 텔레그램 알림..."

# 덱스터 빠른 점검
if $DRY_RUN; then
  info "[DRY-RUN] node $PROJECT_DIR/bots/claude/src/dexter.js"
else
  echo "  덱스터 점검 중..."
  DEXTER_RESULT=$(node "$PROJECT_DIR/bots/claude/src/dexter.js" 2>&1 | tail -3)
  echo "  $DEXTER_RESULT"
fi

# 텔레그램 복구 완료 알림
ELAPSED=$(( $(date +%s) - START_TIME ))
run "node -e \"
  const { publishToWebhook } = require('$PROJECT_DIR/packages/core/lib/reporting-hub');
  publishToWebhook({
    event: {
      from_bot: 'disaster-recovery',
      team: 'emergency',
      event_type: 'disaster_recovery_completed',
      alert_level: 4,
      message: '🚨 재해 복구 완료\\\\n맥북에서 OPS 전환됨\\\\n소요: ${ELAPSED}초\\\\n백업: $(basename $LATEST)'
    }
  });
\""
ok "텔레그램 CRITICAL 알림 발송"

echo ""
echo "══════════════════════════════════════════════════"
echo -e "  ${GREEN}✅ 재해 복구 완료 (소요: ${ELAPSED}초)${NC}"
echo ""
echo "  다음 단계:"
echo "  1. 텔레그램 포럼 메시지 수신 확인"
echo "  2. 24시간 집중 모니터링 (덱스터 퀵체크 5분 주기)"
echo "  3. 루나팀 PAPER_MODE 확인 후 OPS 재개"
echo ""

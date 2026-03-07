#!/bin/bash
# scripts/chaos/test-secrets-permission.sh
# 장애 주입 2: secrets.json 권한 변경 → 덱스터 보안 체크 감지 확인
#
# ⚠️ 테스트 후 반드시 600으로 복구됨 (set -e 보장)
set -e

cd "$(dirname "$0")/../.."
SECRETS=$(find bots/reservation -name "secrets.json" -not -path "*/node_modules/*" | head -1)

if [ -z "$SECRETS" ]; then
  echo "⚠️ secrets.json 없음 — 테스트 스킵"
  exit 0
fi

ORIGINAL_PERM=$(stat -f "%Lp" "$SECRETS")
echo "=============================="
echo "🔥 장애 주입 2: secrets.json 권한 변경"
echo "=============================="
echo "파일: $SECRETS"
echo "현재 권한: $ORIGINAL_PERM"
echo ""

# 복구 보장 trap
trap "chmod $ORIGINAL_PERM '$SECRETS'; echo ''; echo '[복구 trap] 권한 복구됨: -> $ORIGINAL_PERM'" EXIT

# 1. 권한 변경 (600 → 644)
chmod 644 "$SECRETS"
echo "[$(date '+%H:%M:%S')] 권한 변경됨: $ORIGINAL_PERM → 644"

# 2. 덱스터 보안 체크로 감지 확인
echo ""
echo "[$(date '+%H:%M:%S')] 덱스터 보안 체크 실행..."
node bots/claude/src/dexter.js 2>&1 | grep -E "(secret|권한|permission|보안|600|644|CRITICAL|❌|⚠️)" | head -15 || true

echo ""
echo "[$(date '+%H:%M:%S')] 권한 복구 중..."
chmod 600 "$SECRETS"
trap - EXIT  # trap 해제 (이미 복구)

echo "✅ 권한 복구됨: 644 → 600"
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"

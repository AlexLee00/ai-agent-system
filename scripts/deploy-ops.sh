#!/bin/bash
# scripts/deploy-ops.sh — OPS 배포 전 안전 확인 스크립트
#
# 사용법: bash scripts/deploy-ops.sh
# 모든 단계 통과 시: "✅ OPS 배포 준비 완료" 출력
# 실패 시: exit 1

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 OPS 배포 준비 점검..."
echo "   프로젝트 경로: $ROOT"
echo ""

FAIL=0

# ─── 1. 현재 브랜치 확인 ────────────────────────────────────────────────────
echo "[ 1/5 ] 브랜치 확인"
BRANCH=$(git -C "$ROOT" branch --show-current 2>/dev/null || echo "")
if [ "$BRANCH" != "main" ]; then
  echo -e "  ${RED}❌ main 브랜치에서만 OPS 배포 가능 (현재: ${BRANCH:-알 수 없음})${NC}"
  FAIL=1
else
  echo -e "  ${GREEN}✅ main 브랜치 확인${NC}"
fi

# ─── 2. uncommitted 변경 없는지 ─────────────────────────────────────────────
echo "[ 2/5 ] 미커밋 변경사항 확인"
DIRTY=$(git -C "$ROOT" status --porcelain 2>/dev/null || echo "")
if [ -n "$DIRTY" ]; then
  echo -e "  ${RED}❌ uncommitted 변경사항 존재:${NC}"
  echo "$DIRTY" | head -5 | while read -r line; do echo "     $line"; done
  echo -e "  ${YELLOW}→ git commit 후 재시도하세요.${NC}"
  FAIL=1
else
  echo -e "  ${GREEN}✅ 미커밋 변경 없음 (clean)${NC}"
fi

# ─── 3. E2E 테스트 통과 확인 ────────────────────────────────────────────────
echo "[ 3/5 ] E2E 테스트"
if npm --prefix "$ROOT" test 2>&1 | tail -3 | grep -qiE "error|fail|❌"; then
  echo -e "  ${RED}❌ 테스트 실패. 수정 후 재시도.${NC}"
  FAIL=1
else
  echo -e "  ${GREEN}✅ 테스트 통과${NC}"
fi

# ─── 4. pre-commit 훅 설치 확인 ─────────────────────────────────────────────
echo "[ 4/5 ] pre-commit 훅 확인"
HOOK="$ROOT/.git/hooks/pre-commit"
if [ ! -f "$HOOK" ]; then
  echo -e "  ${YELLOW}⚠️  pre-commit 훅 미설치. 설치 중...${NC}"
  bash "$ROOT/scripts/setup-hooks.sh" 2>/dev/null \
    && echo -e "  ${GREEN}✅ 훅 설치 완료${NC}" \
    || echo -e "  ${RED}❌ 훅 설치 실패 — bash scripts/setup-hooks.sh 수동 실행 필요${NC}"
elif [ ! -x "$HOOK" ]; then
  echo -e "  ${YELLOW}⚠️  pre-commit 훅 실행 권한 없음. 수정 중...${NC}"
  chmod +x "$HOOK" \
    && echo -e "  ${GREEN}✅ 실행 권한 부여 완료${NC}" \
    || { echo -e "  ${RED}❌ 권한 부여 실패${NC}"; FAIL=1; }
else
  echo -e "  ${GREEN}✅ pre-commit 훅 설치됨 + 실행 권한 확인${NC}"
fi

# ─── 5. secrets 파일 권한 확인 ──────────────────────────────────────────────
echo "[ 5/5 ] secrets 파일 권한"
SECRETS_FOUND=0
while IFS= read -r -d '' f; do
  SECRETS_FOUND=$((SECRETS_FOUND + 1))
  # macOS: stat -f "%Lp", Linux: stat -c "%a"
  PERM=$(stat -f "%Lp" "$f" 2>/dev/null || stat -c "%a" "$f" 2>/dev/null || echo "unknown")
  if [ "$PERM" != "600" ]; then
    echo -e "  ${YELLOW}⚠️  $f 권한 수정 (${PERM} → 600)${NC}"
    chmod 600 "$f" \
      && echo -e "  ${GREEN}   ✅ 수정 완료${NC}" \
      || { echo -e "  ${RED}   ❌ 수정 실패${NC}"; FAIL=1; }
  else
    echo -e "  ${GREEN}✅ $f 권한 600 확인${NC}"
  fi
done < <(find "$ROOT" -name "secrets.json" -not -path "*/node_modules/*" -not -path "*/.git/*" -print0)

if [ "$SECRETS_FOUND" -eq 0 ]; then
  echo -e "  ${GREEN}✅ secrets.json 없음 (config.yaml 방식 사용)${NC}"
fi

# ─── 결과 ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}  ✅ OPS 배포 준비 완료${NC}"
  echo ""
  echo "  Luna 통합 런타임 기준으로 서비스를 시작하세요."
  echo "  예) npm --prefix bots/investment run -s runtime:luna-ops-scheduler -- --dry-run --json"
else
  echo -e "${RED}  ❌ ${FAIL}건 실패 — 위 항목 해결 후 재시도하세요.${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

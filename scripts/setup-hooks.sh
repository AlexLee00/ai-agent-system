#!/bin/bash
# Git 훅 설치 스크립트
# 사용: bash scripts/setup-hooks.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts"
HOOKS_DST="$REPO_ROOT/.git/hooks"

GREEN='\033[0;32m'
NC='\033[0m'

install_hook() {
  local name="$1"
  if [ -f "$HOOKS_SRC/$name" ]; then
    cp "$HOOKS_SRC/$name" "$HOOKS_DST/$name"
    chmod +x "$HOOKS_DST/$name"
    echo -e "${GREEN}✅ $name 설치됨${NC}"
  fi
}

install_hook "pre-commit"

echo ""
echo "Git 훅 설치 완료. 이제 커밋 시 보안 검사가 자동 실행됩니다."

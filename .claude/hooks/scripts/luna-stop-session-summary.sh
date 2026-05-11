#!/bin/zsh
# Luna Stop Hook — 세션 종료 시 요약 출력
# 항상 exit 0

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

changed="$(git -C "$REPO_ROOT" diff --name-only -- bots/investment/ 2>/dev/null || true)"

if [[ -z "$changed" ]]; then
  exit 0
fi

echo "[Luna][Stop] 루나팀 세션 종료 체크리스트"

if echo "$changed" | grep -q "bots/investment/team/"; then
  echo " - 에이전트 코드 수정됨: smoke test 권장 (npm run smoke:luna)"
fi

if echo "$changed" | grep -q "bots/investment/elixir/"; then
  echo " - Elixir 코드 수정됨: mix test 권장"
fi

if echo "$changed" | grep -q "bots/investment/nodes/"; then
  echo " - Pipeline 노드 수정됨: 노드 순서/페이로드 스키마 확인 권장"
fi

if echo "$changed" | grep -q "bots/investment/a2a/"; then
  echo " - A2A 모듈 수정됨: npm run luna:a2a:smoke 확인 권장"
fi

echo " - 변경 파일:"
echo "$changed" | sed 's/^/   - /'

exit 0

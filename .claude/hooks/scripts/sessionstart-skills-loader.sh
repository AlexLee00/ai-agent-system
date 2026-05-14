#!/bin/zsh
# SessionStart Hook — 스킬 로더 + 인벤토리 출력
# Always exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# .claude/skills/ 하위 SKILL.md 수 카운트
skill_count="$(find "$REPO_ROOT/.claude/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"

# packages/core/lib/skills/*.ts 수 카운트
ts_count="$(find "$REPO_ROOT/packages/core/lib/skills" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')"

echo "[SessionStart][skills] Claude Code 스킬 $skill_count 개 로드됨 (core TS: $ts_count 개)" >&2

# 스킬 목록 간략 출력
find "$REPO_ROOT/.claude/skills" -name 'SKILL.md' 2>/dev/null \
  | sed 's|.*/\([^/]*\)/SKILL.md|\1|' \
  | sort \
  | tr '\n' ' ' \
  | xargs -I{} echo "[SessionStart][skills] 사용 가능: {}" >&2

exit 0

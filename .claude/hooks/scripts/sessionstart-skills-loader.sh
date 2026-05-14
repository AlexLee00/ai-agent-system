#!/bin/zsh
# SessionStart Hook — 스킬 로더 + 인벤토리 + session-analyzer 위험도 출력
# Always exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# .claude/skills/ 하위 SKILL.md 수 카운트
skill_count="$(find "$REPO_ROOT/.claude/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"

# skills/ ROOT 하위 SKILL.md 수 카운트
root_skill_count="$(find "$REPO_ROOT/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"

# packages/core/lib/skills/*.ts 수 카운트
ts_count="$(find "$REPO_ROOT/packages/core/lib/skills" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')"

echo "[SessionStart][skills] Claude Code 스킬 $skill_count 개 + ROOT $root_skill_count 개 로드됨 (core TS: $ts_count 개)" >&2

# .claude/skills/ 목록
find "$REPO_ROOT/.claude/skills" -name 'SKILL.md' 2>/dev/null \
  | sed 's|.*/\([^/]*\)/SKILL.md|\1|' \
  | sort \
  | tr '\n' ' ' \
  | xargs -I{} echo "[SessionStart][skills] .claude: {}" >&2

# skills/ ROOT 목록
root_list="$(find "$REPO_ROOT/skills" -name 'SKILL.md' 2>/dev/null \
  | sed 's|.*/\([^/]*\)/SKILL.md|\1|' \
  | sort \
  | tr '\n' ' ')"
[[ -n "$root_list" ]] && echo "[SessionStart][skills] root: $root_list" >&2

# session-analyzer-cli.ts 실행 (24시간 이내 변경사항 위험도 분석)
TSX="$(command -v tsx 2>/dev/null || echo "$REPO_ROOT/node_modules/.bin/tsx")"
ANALYZER_CLI="$REPO_ROOT/packages/core/lib/skills/bin/session-analyzer-cli.ts"
if [[ -x "$TSX" && -f "$ANALYZER_CLI" ]]; then
  cd "$REPO_ROOT"
  "$TSX" "$ANALYZER_CLI" "24 hours ago" 2>/dev/null | sed 's/^/[SessionStart]/' >&2 || true
fi

exit 0

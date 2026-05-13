#!/bin/zsh
# PostToolUse Hook — Write/Edit 후 기본 검증
# Always exit 0 (post-tool hooks cannot block)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

changed="$(git diff --name-only -- packages/core bots .claude 2>/dev/null || true)"
[[ -z "$changed" ]] && exit 0

js_ts_files="$(echo "$changed" | grep -E '\.(js|ts)$' | grep -v '\.d\.ts$' || true)"
if [[ -n "$js_ts_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ ! -f "$REPO_ROOT/$file" ]] && continue
    node --check "$REPO_ROOT/$file" >/dev/null 2>&1 \
      && echo "[PostToolUse][verify] OK: $file" \
      || echo "[PostToolUse][verify] FAIL: $file → /systematic-debugging 권장"
  done <<< "$js_ts_files"
fi

exit 0

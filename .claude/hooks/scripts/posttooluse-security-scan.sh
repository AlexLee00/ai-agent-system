#!/bin/zsh
# PostToolUse Hook — Write/Edit 후 security-pipeline 보안 스캔
# Always exit 0 (post-tool hooks cannot block)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

changed="$(git diff --name-only -- packages/core bots .claude 2>/dev/null || true)"
[[ -z "$changed" ]] && exit 0

js_ts_files="$(echo "$changed" | grep -E '\.(js|ts|mjs|cjs)$' | grep -v '\.d\.ts$' || true)"
[[ -z "$js_ts_files" ]] && exit 0

TSX="$(command -v tsx 2>/dev/null || echo "$REPO_ROOT/node_modules/.bin/tsx")"
SECURITY_CLI="$REPO_ROOT/packages/core/lib/skills/bin/security-pipeline-cli.ts"

[[ ! -f "$SECURITY_CLI" ]] && exit 0

if [[ -x "$TSX" || -f "$TSX" ]]; then
  file_args=()
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ ! -f "$REPO_ROOT/$file" ]] && continue
    file_args+=("$REPO_ROOT/$file")
  done <<< "$js_ts_files"

  if [[ ${#file_args[@]} -gt 0 ]]; then
    "$TSX" "$SECURITY_CLI" "${file_args[@]}" 2>/dev/null | sed 's/^/[PostToolUse]/' >&2 || true
  fi
fi

exit 0

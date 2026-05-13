#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

changed="$(git diff --name-only -- bots/blog .claude/hooks/hooks.json || true)"

if [[ -z "$changed" ]]; then
  exit 0
fi

if echo "$changed" | grep -q '^\.claude/hooks/hooks\.json$'; then
  node --input-type=module -e "import fs from 'node:fs'; JSON.parse(fs.readFileSync('$REPO_ROOT/.claude/hooks/hooks.json','utf8')); console.log('[PostToolUse][blog] hooks.json OK')"
fi

js_files="$(echo "$changed" | egrep '^bots/blog/.*\.(js)$' || true)"
if [[ -n "$js_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    node --check "$REPO_ROOT/$file" >/dev/null
    echo "[PostToolUse][blog] node --check OK: $file"
  done <<< "$js_files"
fi

legacy_files="$(echo "$changed" | egrep '^bots/blog/.*\.(legacy\.js)$' || true)"
if [[ -n "$legacy_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    node --check "$REPO_ROOT/$file" >/dev/null
    echo "[PostToolUse][blog] node --check OK: $file"
  done <<< "$legacy_files"
fi

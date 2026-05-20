#!/bin/zsh
# PostToolUse Hook — Write/Edit 후 Hermes 학습 버퍼에 변경 사항 기록
# Loopback System: Loop 2 (Observation) — Always exit 0
INPUT="$(cat)"
tool_name="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")"
case "$tool_name" in Write|Edit|MultiEdit) ;; *) exit 0 ;; esac
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUFFER_FILE="$REPO_ROOT/.claude/hermes-buffer.jsonl"
file_path="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); ti=d.get('tool_input',{}); print(ti.get('file_path',ti.get('path','')) or '')" 2>/dev/null || echo "")"
[[ -z "$file_path" ]] && exit 0
domain="claude"
case "$file_path" in */bots/investment/*) domain="luna" ;; */bots/blog/*) domain="blog" ;; */bots/hub/*) domain="hub" ;; */bots/ska/*) domain="ska" ;; esac
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 -c "
import json, os
entry = {'ts': '$timestamp', 'tool': '$tool_name', 'file': '$file_path', 'domain': '$domain'}
buf = '$BUFFER_FILE'
lines = (open(buf).readlines()[-499:] if os.path.exists(buf) else [])
lines.append(json.dumps(entry, ensure_ascii=False) + '\n')
open(buf, 'w').writelines(lines)
" 2>/dev/null || true
echo "[PostToolUse][hermes-record] 기록: $file_path (domain=$domain)" >&2
exit 0

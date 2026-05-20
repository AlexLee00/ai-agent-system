#!/bin/zsh
# PostToolUse Hook — Hermes 버퍼에서 패턴 추출 (5회 이상 반복 파일)
# Loopback System: Loop 3 (Learning) — Always exit 0
INPUT="$(cat)"
tool_name="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")"
[[ "$tool_name" != "Bash" ]] && exit 0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUFFER_FILE="$REPO_ROOT/.claude/hermes-buffer.jsonl"
[[ ! -f "$BUFFER_FILE" ]] && exit 0
# 버퍼가 30줄 이상일 때만 패턴 추출 시도
line_count="$(wc -l < "$BUFFER_FILE" | tr -d ' ')"
[[ "$line_count" -lt 30 ]] && exit 0
python3 -c "
import json, collections, os
buf = '$BUFFER_FILE'
files = collections.Counter()
with open(buf) as f:
    for line in f:
        try:
            d = json.loads(line)
            files[d.get('file','')] += 1
        except: pass
hot = [(f,c) for f,c in files.most_common(5) if c >= 5]
if hot:
    print('[PostToolUse][pattern-extractor] 빈번 변경 파일 (Hermes 학습 후보):', file=__import__('sys').stderr)
    for f,c in hot:
        print(f'  {c}회: {f}', file=__import__('sys').stderr)
" 2>&1 >&2 || true
exit 0

#!/bin/zsh
# PreCompact Hook — 컨텍스트 압축 전 스킬 인덱스 새로고침 안내
# Loopback System: Loop 5 (Decision support) — Always exit 0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
echo "[PreCompact][skill-refresh] ═══════════════════════════════" >&2
echo "[PreCompact][skill-refresh] 컨텍스트 압축 시작 — 스킬 상태 요약" >&2
# skills/ 목록
SKILLS_DIR="$REPO_ROOT/bots/claude/skills"
if [[ -d "$SKILLS_DIR" ]]; then
  skill_list="$(ls "$SKILLS_DIR" 2>/dev/null | tr '\n' ' ')"
  echo "[PreCompact][skill-refresh] 등록 스킬: $skill_list" >&2
fi
# A2A skills 목록
A2A_DIR="$REPO_ROOT/bots/claude/a2a/skills"
if [[ -d "$A2A_DIR" ]]; then
  a2a_list="$(ls "$A2A_DIR" 2>/dev/null | grep '\.ts$' | sed 's/\.ts//' | tr '\n' ' ')"
  echo "[PreCompact][skill-refresh] A2A skills: $a2a_list" >&2
fi
# Hermes 버퍼 상태
BUFFER="$REPO_ROOT/.claude/hermes-buffer.jsonl"
if [[ -f "$BUFFER" ]]; then
  buf_lines="$(wc -l < "$BUFFER" | tr -d ' ')"
  echo "[PreCompact][skill-refresh] Hermes 버퍼: ${buf_lines}줄 (패턴 누적 중)" >&2
fi
echo "[PreCompact][skill-refresh] → 압축 후 스킬 컨텍스트 자동 복원" >&2
echo "[PreCompact][skill-refresh] ═══════════════════════════════" >&2
exit 0

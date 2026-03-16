#!/bin/bash
# nightly-sync.sh - 자정 자동 실행: 활성 봇 컨텍스트 보존 + 정리 작업
# launchd로 매일 00:00에 실행됨

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/nightly-sync.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

# launchd에서는 PATH가 비어 node를 못 찾는 경우가 있어, 먼저 NVM을 불러와 절대 경로를 고정한다.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
fi
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "[$DATE] ❌ node 실행 경로를 찾지 못했습니다." >> "$LOG_FILE"
  exit 1
fi

echo "[$DATE] ====== 자정 컨텍스트 보존 시작 ======" >> "$LOG_FILE"

# 1. 활성 봇(status: ops) 역방향 동기화 (워크스페이스 → context/)
echo "[$DATE] 📥 활성 봇 역동기화 중..." >> "$LOG_FILE"
"$NODE_BIN" "$ROOT/scripts/deploy-context.js" --all --sync >> "$LOG_FILE" 2>&1

# 2. llm_cache 만료 항목 정리 (Node.js — psql PATH 미보장 환경 대응)
echo "[$DATE] 🧹 llm_cache 만료 항목 정리 중..." >> "$LOG_FILE"
"$NODE_BIN" -e "
  require('$ROOT/packages/core/lib/llm-cache').cleanExpired()
    .then(n => console.log('[llm-cache] 삭제:', n, '건'))
    .catch(e => console.warn('[llm-cache] 정리 실패 (무시):', e.message));
" >> "$LOG_FILE" 2>&1

# 3. RAG 30일 이상 오래된 데이터 정리
echo "[$DATE] 🗂️  RAG 오래된 데이터 정리 중 (30일 초과)..." >> "$LOG_FILE"
"$NODE_BIN" -e "
  const rag = require('$ROOT/packages/core/lib/rag');
  const COLLECTIONS = ['operations', 'tech_digest', 'system_docs'];
  Promise.all(COLLECTIONS.map(c =>
    rag.cleanOld(c, 30)
      .then(n => console.log('[rag] ' + c + ' 삭제:', n, '건'))
      .catch(e => console.warn('[rag] ' + c + ' 정리 실패 (무시):', e.message))
  ));
" >> "$LOG_FILE" 2>&1

# 4. PostgreSQL 커넥션 풀 상태 로그
echo "[$DATE] 🗄️  PostgreSQL 활성 커넥션 수..." >> "$LOG_FILE"
"$NODE_BIN" -e "
  require('$ROOT/packages/core/lib/pg-pool').query('public', 'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()')
    .then(r => console.log('[pg-pool] 활성 커넥션:', r[0].n, '개'))
    .catch(e => console.warn('[pg-pool] 조회 실패 (무시):', e.message));
" >> "$LOG_FILE" 2>&1

# 5. n8n 워크플로우 활성 상태 확인
echo "[$DATE] ⚙️  n8n 활성 워크플로우..." >> "$LOG_FILE"
WF_COUNT=$(curl -s http://localhost:5678/api/v1/workflows 2>/dev/null | grep -o '"active":true' | wc -l | tr -d ' ')
echo "  활성: ${WF_COUNT}개" >> "$LOG_FILE"

# 6. git commit (변경사항 있을 때만)
cd "$ROOT"
if ! git diff --quiet bots/; then
  git add bots/
  git commit -m "chore: 자정 자동 컨텍스트 보존 ($(date '+%Y-%m-%d'))" >> "$LOG_FILE" 2>&1
  echo "[$DATE] ✅ git commit 완료" >> "$LOG_FILE"
else
  echo "[$DATE] ℹ️ 변경사항 없음 - commit 스킵" >> "$LOG_FILE"
fi

echo "[$DATE] ====== 완료 ======" >> "$LOG_FILE"

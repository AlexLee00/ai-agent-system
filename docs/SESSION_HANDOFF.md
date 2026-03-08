# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-09)

### 워커팀 Phase 4 AI 고도화 완료

#### 구현 완료
- `bots/worker/lib/ai-client.js`: `callLLM()` + `callLLMWithFallback()` (Groq llama-4-maverick → Claude haiku-4-5 폴백)
- `bots/worker/lib/ai-helper.js`: `buildSQLPrompt`, `buildSummaryPrompt`, `extractSQL`, `isSelectOnly`, `isSafeQuestion`
- `POST /api/ai/ask`: 자연어→SQL→실행→RAG→요약 / admin/master 전용 / 감사 로그 기록
- `POST /api/ai/revenue-forecast`: 90일 매출 → Groq 30일 예측 / 감사 로그 기록
- `web/app/ai/page.js`: AI 질문 UI + 매출 예측 UI
- `bots/worker/scripts/start-worker-web.sh`: launchd 래퍼 (config.yaml에서 API 키 런타임 로드)
- `ai.worker.web.plist`: 래퍼 스크립트 방식으로 변경

#### 보안
- `isSafeQuestion()`: 입력 질문에 위험 키워드 차단 (UNSAFE_QUESTION)
- `isSelectOnly()`: 생성 SQL SELECT 전용 검증 (이중 방어)

#### 미완 — RAG 임베딩 비활성
- OpenAI `text-embedding-3-small` 쿼터 초과 → RAG 저장/검색 모두 실패
- 실패는 `try-catch` + `.catch(()=>{})` 로 조용히 무시됨 — 기능 영향 없음
- **맥미니 도착 후** Ollama `nomic-embed-text`(768dim) 로 전환 예정
  - `packages/core/lib/rag.js` `createEmbedding()` → Ollama HTTP 폴백 추가
  - `reservation.rag_work_docs` 테이블 현재 빈 상태 (재생성 가능)

### Python rag-system 잔재 완전 제거
- `~/projects/rag-system/` 삭제, `scripts/migrate-rag.js` 삭제
- `network.js` 덱스터 체크: RAG 서버 미실행 시 warn 격상
- `migrate` 스크립트 3종, `llm-cache.js`, `rag-server.js` 주석 정리

---

## 다음 작업 백로그 (우선순위 순)

1. **업체별 메뉴 설정** — 업체마다 사용하는 기능 모듈 ON/OFF 제어
2. **RAG 자동 수집 완성** — 맥미니 Ollama 도착 후 (`nomic-embed-text` 전환)
3. **1호 업체 파일럿 준비** — 실제 업체 데이터 마이그레이션 + 테스트

---

## 워커팀 현재 운영 상태

| 서비스 | launchd | 포트 | 상태 |
|--------|---------|------|------|
| API 서버 | `ai.worker.web` | 4000 | ✅ |
| Next.js | `ai.worker.nextjs` | 4001 | ✅ |
| RAG 서버 | `ai.rag.server` | 8100 | ✅ (임베딩만 비활성) |

## 워커팀 계정 (테스트용)
- `alex` / `admin1234` — master 권한 (AI 분석 메뉴 접근 가능)

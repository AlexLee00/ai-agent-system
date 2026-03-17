# 데이터베이스 스키마 인덱스

> 마지막 업데이트: 2026-03-18
> 목적: ai-agent-system의 DB 종류, 스키마, 주요 테이블, 소스 오브 트루스 코드를 빠르게 찾기 위한 인덱스다.

---

## 1. 역할

- 이 문서는 모든 컬럼을 풀어 적는 DDL 백서가 아니다.
- 대신 다음 질문에 빠르게 답하기 위한 문서다.
  - 어떤 팀이 어떤 DB를 쓰는가
  - 주요 테이블은 어디서 정의되는가
  - write/read 경로는 어디서 시작하는가
  - 어떤 문서를 더 읽어야 하는가

---

## 2. 공통 원칙

- PostgreSQL은 `jay` DB 안에서 스키마 분리 방식으로 운영한다.
- SQLite는 lightweight state, queue, alert, local cache 용도로 남아 있다.
- DuckDB는 스카 예측/분석용 배치 저장소다.
- 새 기능은 먼저 기존 스키마/DB를 재사용할 수 있는지 검토한다.
- 런타임 상태 데이터는 Git보다 DB/로그에 남기는 것이 원칙이다.

공용 진입점:
- [packages/core/lib/pg-pool.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/pg-pool.js)
- [packages/core/lib/rag.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/rag.js)
- [packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js)
- [packages/core/lib/intent-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-store.js)
- [packages/core/lib/llm-logger.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-logger.js)

---

## 3. DB 타입별 지도

### PostgreSQL

- 기본 DB: `jay`
- 지원 스키마:
  - `claude`
  - `reservation`
  - `investment`
  - `ska`
  - `worker`
  - `blog`
  - `public`

소스 오브 트루스:
- [packages/core/lib/pg-pool.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/pg-pool.js)

### SQLite

주 용도:
- 팀별 상태 저장
- lightweight queue / alert / local report
- launchd 친화적 운영 데이터

대표 예:
- `~/.openclaw/workspace/state.db`
- `~/.openclaw/workspace/claude-team.db`

### DuckDB

주 용도:
- 스카 예측 결과
- 학습 feature / 실적 비교
- 배치성 분석

대표 예:
- `bots/ska/*.duckdb`

---

## 4. 공용 PostgreSQL 레이어

### AI Feedback

대상 스키마:
- `worker`
- `blog`
- `claude`

주요 테이블:
- `ai_feedback_sessions`
- `ai_feedback_events`

소스 오브 트루스:
- [packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js)

### Intent Engine

대상 스키마:
- 주로 `claude`

주요 테이블:
- `unrecognized_intents`
- `intent_promotion_candidates`
- `intent_promotion_events`

소스 오브 트루스:
- [packages/core/lib/intent-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-store.js)

### RAG

주요 테이블:
- `rag_*` 컬렉션 테이블

소스 오브 트루스:
- [packages/core/lib/rag.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/rag.js)
- [packages/core/lib/rag-safe.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/rag-safe.js)

### LLM Usage

주요 테이블:
- `llm_usage_log`
- 일부 팀의 `token_usage`

소스 오브 트루스:
- [packages/core/lib/llm-logger.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-logger.js)

---

## 5. 팀별 저장소 인덱스

### Claude / Dexter / Orchestrator

주요 저장소:
- SQLite: `claude-team.db`
- PostgreSQL: `claude` 스키마

주요 테이블:
- `bot_commands`
- `mainbot_queue`
- `token_usage`
- `shadow_log`
- `team_modes`
- `intent_*`
- `ai_feedback_*`

소스 오브 트루스:
- [bots/orchestrator/migrations/002_mainbot.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/migrations/002_mainbot.js)
- [bots/orchestrator/migrations/003_bot_commands.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/migrations/003_bot_commands.js)
- [packages/core/lib/shadow-mode.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/shadow-mode.js)

### Reservation / Ska Commander

주요 저장소:
- SQLite `state.db`
- PostgreSQL `reservation` 스키마 일부 공용화

주요 테이블:
- `reservations`
- `cancelled_keys`
- `kiosk_blocks`
- `alerts`
- `daily_summary`
- `llm_usage_log`

소스 오브 트루스:
- [bots/reservation/lib/db.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/db.js)
- [bots/reservation/migrations/](/Users/alexlee/projects/ai-agent-system/bots/reservation/migrations)

### Ska Forecast

주요 저장소:
- DuckDB

주요 테이블/개념:
- `forecast_results`
- `training_feature_daily`
- 예측/실적/환경 feature 계열 테이블

소스 오브 트루스:
- [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
- [bots/ska/scripts/build-ska-model-dataset.js](/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/build-ska-model-dataset.js)
- [bots/ska/scripts/export-ska-training-csv.js](/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/export-ska-training-csv.js)

### Investment

주요 저장소:
- 팀 전용 상태 DB
- PostgreSQL `investment` 스키마 일부 보조 사용

주요 테이블/개념:
- 신호/리뷰/포지션/리스크/스냅샷 계열

소스 오브 트루스:
- [bots/investment/shared/db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

### Worker

주요 저장소:
- PostgreSQL `worker` 스키마

주요 테이블:
- `ai_feedback_sessions`
- `ai_feedback_events`
- `document_reuse_events`
- worker 업무/승인 관련 테이블

소스 오브 트루스:
- [bots/worker/migrations/](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations)
- [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)

### Blog

주요 저장소:
- PostgreSQL `blog` 스키마

주요 테이블:
- `pipeline_store`
- blog 피드백/리서치/발행 관련 테이블

소스 오브 트루스:
- [packages/core/lib/blog-rag-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/blog-rag-store.js)
- [bots/blog/migrations/](/Users/alexlee/projects/ai-agent-system/bots/blog/migrations)

---

## 6. 같이 읽으면 좋은 문서

- 세션 시작
  - [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
- 구조/설계
  - [SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
- 팀별 코드 위치
  - [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)
- 운영 설정
  - [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)

---

## 7. 다음 보강 후보

- team별 실제 테이블 목록을 더 촘촘히 보강
- DuckDB 핵심 테이블/컬럼 목적을 부록으로 분리
- write path / read path owner code를 더 표준화

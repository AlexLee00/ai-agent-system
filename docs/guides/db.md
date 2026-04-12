# 데이터베이스 스키마 인덱스

> 마지막 업데이트: 2026-03-23
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

대표 owner code:
- [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)
- [bots/orchestrator/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js)
- [bots/claude/src/claude-commander.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/claude-commander.js)
- [bots/claude/lib/claude-lead-brain.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/claude-lead-brain.js)

소스 오브 트루스:
- [bots/orchestrator/migrations/002_mainbot.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/migrations/002_mainbot.js)
- [bots/orchestrator/migrations/003_bot_commands.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/migrations/003_bot_commands.js)
- [packages/core/lib/shadow-mode.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/shadow-mode.js)

운영적으로 자주 보는 테이블:
- `claude.bot_commands`
  - 제이/클로드 명령 enqueue, 실행 상태, 결과 추적
- `claude.mainbot_queue`
  - 팀장봇 큐 적재 상태와 지연 확인
- `claude.token_usage`
  - LLM 사용량 집계
- `claude.shadow_log`
  - shadow mode 비교 로그

### Reservation / Ska Commander

주요 저장소:
- PostgreSQL `reservation` 스키마
- SQLite `state.db`는 보조 상태/로컬 캐시 성격으로만 유지

주요 테이블:
- `reservation.reservations`
- `reservation.cancelled_keys`
- `reservation.kiosk_blocks`
- `reservation.alerts`
- `reservation.daily_summary`
- `reservation.pickko_order_raw`
- `reservation.llm_usage_log`

대표 owner code:
- [bots/reservation/lib/db.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/db.ts)
- [bots/reservation/auto/monitors/naver-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.ts)
- [bots/reservation/auto/monitors/pickko-kiosk-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts)
- [bots/reservation/manual/admin/pickko-verify.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/admin/pickko-verify.ts)

소스 오브 트루스:
- [bots/reservation/lib/db.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/db.ts)
- [bots/reservation/migrations/](/Users/alexlee/projects/ai-agent-system/bots/reservation/migrations)

운영적으로 자주 보는 테이블:
- `reservation.reservations`
  - 예약 상태, pickko/naver 동기화 상태, retry/verify 맥락
- `reservation.alerts`
  - andy/jimmy 경고, resolve 여부
- `reservation.daily_summary`
  - `general_revenue = payment_day|general`
  - `pickko_study_room = use_day|study_room`
  - `pickko_total`은 2026-03-23 기준 제거됨
- `reservation.pickko_order_raw`
  - `payment_day|general`와 `use_day|study_room`만 유지
  - `payment_day|study_room`, `amount_delta`는 제거됨
- `reservation.tool_calls`
  - 툴 호출 로그
- SQLite `cancelled_keys`
  - 중복 취소/오발동 점검용 상태 데이터

### Ska Forecast

주요 저장소:
- DuckDB

주요 테이블/개념:
- `forecast_results`
- `training_feature_daily`
- 예측/실적/환경 feature 계열 테이블

대표 owner code:
- [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
- [bots/ska/lib/feature_store.py](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/feature_store.py)
- [bots/ska/src/rebecca.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py)
- [bots/ska/src/etl.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/etl.py)

소스 오브 트루스:
- [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
- [bots/ska/scripts/build-ska-model-dataset.js](/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/build-ska-model-dataset.js)
- [bots/ska/scripts/export-ska-training-csv.js](/Users/alexlee/projects/ai-agent-system/bots/ska/scripts/export-ska-training-csv.js)

운영적으로 자주 보는 테이블:
- `ska.forecast_results`
  - 예측값, actual, bias, model diagnostics, shadow 비교값
- `ska.training_feature_daily`
  - 예측 학습/비교용 일 단위 feature 집합
- `revenue_daily`
  - DuckDB 실적 집계 원본
- `environment_factors`, `exam_events`
  - 보정용 환경 입력

### Investment

주요 저장소:
- 팀 전용 상태 DB
- PostgreSQL `investment` 스키마 일부 보조 사용

주요 테이블/개념:
- 신호/리뷰/포지션/리스크/스냅샷 계열

대표 owner code:
- [bots/investment/shared/db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)
- [bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)

소스 오브 트루스:
- [bots/investment/shared/db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

운영적으로 자주 보는 테이블:
- `investment.signals`
  - 시장별 최종 판단과 analyst output
- `investment.positions`
  - 현재 보유 포지션
- `investment.trades`
  - 실제 체결 결과
- `investment.trade_journal`
  - 일일/주간 분석 리포트 기반 테이블

### Worker

주요 저장소:
- PostgreSQL `worker` 스키마

주요 테이블:
- `ai_feedback_sessions`
- `ai_feedback_events`
- `document_reuse_events`
- worker 업무/승인 관련 테이블

대표 owner code:
- [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
- [bots/worker/src/worker-lead.js](/Users/alexlee/projects/ai-agent-system/bots/worker/src/worker-lead.js)
- [bots/worker/lib/approval.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/approval.js)
- [bots/worker/lib/ai-feedback-service.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/ai-feedback-service.js)
- [bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js)

소스 오브 트루스:
- [bots/worker/migrations/](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations)
- [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)

운영적으로 자주 보는 테이블:
- `worker.documents`
  - 업로드 문서, 요약, 추출 텍스트
- `worker.document_reuse_events`
  - 문서 재사용 이력, 연결 결과
- `worker.system_preferences`
  - 워커 모니터링 기본 설정, 기본 LLM API 선택값
- `worker.approval_requests`
  - 승인 대기 흐름
- `worker.schedules`, `worker.work_journals`, `worker.sales`, `worker.projects`
  - AI가 생성/수정하는 실제 업무 객체
- `worker.audit_log`
  - 권한/운영 행위 추적

### Blog

주요 저장소:
- PostgreSQL `blog` 스키마

주요 테이블:
- `pipeline_store`
- blog 피드백/리서치/발행 관련 테이블

대표 owner code:
- [bots/blog/lib/maestro.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/maestro.js)
- [bots/blog/lib/gems-writer.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/gems-writer.js)
- [bots/blog/lib/pos-writer.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/pos-writer.js)
- [bots/blog/api/node-server.js](/Users/alexlee/projects/ai-agent-system/bots/blog/api/node-server.js)

소스 오브 트루스:
- [packages/core/lib/blog-rag-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/blog-rag-store.js)
- [bots/blog/migrations/](/Users/alexlee/projects/ai-agent-system/bots/blog/migrations)

운영적으로 자주 보는 테이블:
- `blog.posts`
  - 발행 글 본문/메타데이터
- `blog.execution_history`
  - maestro 실행 이력
- `blog.research_cache`
  - 리서치 캐시
- `blog.curriculum_series`, `blog.curriculum`
  - 교육 시리즈/강의 커리큘럼
- `blog.publish_schedule`
  - 발행 스케줄

---

## 5.1 공통 테이블 빠른 찾기

| 목적 | 대표 테이블 | 우선 보는 코드 |
|---|---|---|
| 명령 큐/오케스트레이션 | `claude.bot_commands`, `claude.mainbot_queue` | [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js) |
| 예약 상태/경고 | `reservation.reservations`, `reservation.alerts` | [bots/reservation/lib/db.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/db.js) |
| 예측/실적 비교 | `ska.forecast_results`, `ska.training_feature_daily` | [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py) |
| 거래 판단/성과 | `investment.signals`, `investment.trades`, `investment.trade_journal` | [bots/investment/shared/db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js) |
| 워커 업무 객체 | `worker.documents`, `worker.schedules`, `worker.projects`, `worker.sales` | [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js) |
| 워커 운영 설정 | `worker.system_preferences` | [bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js) |
| AI 피드백 | `*.ai_feedback_sessions`, `*.ai_feedback_events` | [packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js) |
| LLM 사용량 | `*.llm_usage_log`, `claude.token_usage` | [packages/core/lib/llm-logger.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-logger.js) |
| RAG 저장소 | `rag_*` 계열 | [packages/core/lib/rag.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/rag.js) |

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

- 팀별 핵심 테이블에 주요 컬럼/PK/FK를 부록으로 추가
- DuckDB 핵심 테이블/컬럼 목적을 부록으로 분리
- migration 파일과 runtime owner code를 더 표준화

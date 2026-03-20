# 세션 컨텍스트 인덱스

> 마지막 업데이트: 2026-03-18
> 목적: 세션이 바뀌어도 반드시 읽어야 할 공통 문서와, 팀별로 어디서부터 코드를 읽어야 하는지를 한 장에서 안내한다.

---

## 0. 5분 요약

- 이 저장소는 `worker`, `investment`, `reservation/ska`, `claude`, `orchestrator`, `blog` 여섯 축으로 보면 된다.
- 세션 시작 시 가장 먼저 볼 문서는
  - [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
  - [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
  - [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  순서다.
- “문서가 각각 무슨 역할이지?”는 이 문서의 `2. 문서 체계와 역할`을 먼저 본다.
- “기능이 어디 있지?”는 [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)에서 팀 문서로 들어가면 된다.
- “운영 중 바꿀 값이 어디 있지?”는 [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)와 [show-runtime-configs.js](/Users/alexlee/projects/ai-agent-system/scripts/show-runtime-configs.js)를 먼저 본다.
- “제이는 왜 Gemini와 GPT를 같이 쓰지?”는 [TEAM_ORCHESTRATOR_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_ORCHESTRATOR_REFERENCE.md)와 `bots/orchestrator/config.json > runtime_config.jayModels`를 먼저 본다.
- “DB가 어디에 어떻게 저장되지?”는 [DATABASE_SCHEMA_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/DATABASE_SCHEMA_INDEX.md)를 먼저 본다.
- “장애가 났을 때 어떤 순서로 점검하지?”는 [OPERATIONS_RUNBOOK.md](/Users/alexlee/projects/ai-agent-system/docs/OPERATIONS_RUNBOOK.md)를 먼저 본다.
- “지금 무엇이 구현됐지?”는 [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)를 먼저 본다.
- “방금 전 세션이 뭘 했지?”는 [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md), [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md), [CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)를 본다.
- “오늘 세션의 실제 작업 맥락과 연구 기록”은 [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md), [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)를 본다.
- “헬스/장애”는 각 팀 문서의 `자주 쓰는 명령어`와 `운영 스크립트`에서 시작한다.

---

## 1. 사용 원칙

- 이 문서는 `세션 시작 인덱스`다.
- 다음 세션의 개발자/에이전트는 이 문서를 기준으로
  - 공통 규칙
  - 현재 시스템 상태
  - 팀별 진입점
  - 운영 설정 위치
  를 먼저 파악한다.
- 새 기능을 구현했는데 “다음 세션도 알아야 하는 공통 규칙/구조/진입점”이 생기면 이 문서에 반영한다.

### 1.1 문서 범주 구분

- `세션 핵심 문서`
  - 다음 세션이 반드시 먼저 읽어야 하는 문서
- `구조/기준 문서`
  - 시스템 설계, 개발 원칙, 공용 레이어 기준
- `팀 참조 문서`
  - 실제 코드 위치와 운영 스크립트를 찾기 위한 문서
- `운영/튜닝 문서`
  - runtime config, 리뷰 스크립트, 운영 자동화 관련 문서
- `기록 문서`
  - 사실 이력, 기능 변경 이력, 테스트 결과, 연구/회고
- `세션 제외 문서`
  - generated output, vendor 문서, 외부 패키지 README/LICENSE, skill 내부 문서

### 1.2 세션 제외 원칙

- 아래 문서는 저장소 안에 있어도 세션 시작 문서로 읽지 않는다.
  - `bots/blog/output/*.md`
  - `bots/ska/venv/**`
  - `skills/**`
  - 외부 패키지의 `README.md`, `LICENSE.md`, API reference
- 이유:
  - 실행 산출물, 외부 의존성 문서, 코덱 로컬 skill 문서는 프로젝트 컨텍스트 문서가 아니기 때문이다.

---

## 2. 세션 시작 시 우선 읽기

### 2.1 최우선 규칙

1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
   - 세션 시작/종료 루틴
   - 절대 규칙
   - 공용 유틸 사용 규칙
2. [docs/SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
   - 공통 문서 인덱스
   - 팀별 진입점 안내
3. [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
   - 직전 세션 맥락
   - 지금 바로 이어야 할 작업
4. [docs/KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
   - 현재 알려진 문제

추가 규칙:
- 코덱은 세션 시작 시 위 순서를 먼저 읽고 작업을 시작한다.
- 코덱은 세션 종료 직전 [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)를 다시 확인하고, 실제 변경이 있으면 관련 문서를 갱신한 뒤 마감한다.

### 2.2 문서 체계와 역할

- 정책 / 세션 규칙
  - [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
- 세션 시작 인덱스
  - [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
- 현재 상태 / 다음 작업
  - [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  - [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
- 구조 / 기준 설계
  - [README.md](/Users/alexlee/projects/ai-agent-system/README.md)
  - [SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
  - [coding-guide.md](/Users/alexlee/projects/ai-agent-system/docs/coding-guide.md)
  - [DATABASE_SCHEMA_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/DATABASE_SCHEMA_INDEX.md)
- 팀별 구현 위치 안내
  - [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)
- 운영 설정 / 튜닝
  - [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
  - [OPERATIONS_RUNBOOK.md](/Users/alexlee/projects/ai-agent-system/docs/OPERATIONS_RUNBOOK.md)
- 사실 기반 작업 기록
  - [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
  - [CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
  - [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
  - [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
- 장기 연구 / 설계 배경
  - [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

### 2.2.1 세션에서 꼭 필요한 최소 문서 묶음

1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
2. [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
3. [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
4. [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
5. [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
6. [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

이 6개를 읽으면:
- 지금 시스템이 어디까지 왔는지
- 오늘 뭘 이어야 하는지
- 왜 그렇게 설계됐는지
- 코드 어디서 시작해야 하는지
를 대부분 파악할 수 있다.

### 2.3 현재 구현 상태 추적

1. [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
   - 전체 플랫폼 구현 상태
   - 팀별 완료/진행 중/미완료
   - 팀별 빠른 찾기
2. [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
   - 실제 작업 사실 기록
3. [docs/CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
   - 기능 변경 이력
4. [docs/RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)
   - 장기 의사결정, 연구 맥락, 세션 회고 기록

### 2.4 공통 구조 문서

1. [README.md](/Users/alexlee/projects/ai-agent-system/README.md)
   - 저장소 전체 구조
2. [docs/SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
   - 아키텍처와 팀 구조
3. [docs/coding-guide.md](/Users/alexlee/projects/ai-agent-system/docs/coding-guide.md)
   - 코드 규칙과 운영 원칙
4. [docs/DATABASE_SCHEMA_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/DATABASE_SCHEMA_INDEX.md)
   - PostgreSQL/SQLite/DuckDB와 팀별 주요 테이블 인덱스
5. [docs/team-features.md](/Users/alexlee/projects/ai-agent-system/docs/team-features.md)
   - 팀별 기능 개요

### 2.5 운영 설정/튜닝 문서

1. [docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
   - 팀별 `runtime_config` 위치와 조정값
2. [docs/OPERATIONS_RUNBOOK.md](/Users/alexlee/projects/ai-agent-system/docs/OPERATIONS_RUNBOOK.md)
   - 재시작, health check, 장애 대응 순서
3. [scripts/show-runtime-configs.js](/Users/alexlee/projects/ai-agent-system/scripts/show-runtime-configs.js)
   - 현재 팀별 운영 설정 빠른 조회

### 2.6 팀별 참조 문서

1. [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)
   - 팀별 참조 문서 인덱스
2. 팀별 상세 문서
   - [워커](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_WORKER_REFERENCE.md)
   - [루나](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_INVESTMENT_REFERENCE.md)
   - [스카](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_SKA_REFERENCE.md)
   - [클로드](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_CLAUDE_REFERENCE.md)
   - [제이](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_ORCHESTRATOR_REFERENCE.md)
   - [블로](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_BLOG_REFERENCE.md)

---

## 2.7 상황별 빠른 경로

### 기능을 찾고 싶을 때

- 전체 구현 상태 먼저 확인
  - [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
- 팀별 실제 파일/스크립트/설정 위치 찾기
  - [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)

### 운영 설정을 바꾸고 싶을 때

- 운영 변수 위치/의미 확인
  - [docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- 현재 값 빠르게 조회
  - [scripts/show-runtime-configs.js](/Users/alexlee/projects/ai-agent-system/scripts/show-runtime-configs.js)

### DB/스키마를 보고 싶을 때

- 공통 DB 종류와 팀별 스키마/테이블 위치 확인
  - [docs/DATABASE_SCHEMA_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/DATABASE_SCHEMA_INDEX.md)

### 헬스/장애를 보고 싶을 때

- 공통 구조
  - [packages/core/HEALTH_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/HEALTH_ENGINE_PLAN.md)
- 실운영 점검/재시작 순서
  - [docs/OPERATIONS_RUNBOOK.md](/Users/alexlee/projects/ai-agent-system/docs/OPERATIONS_RUNBOOK.md)
- 팀별 health script는 각 팀 참조 문서의 `자주 쓰는 명령어` 섹션 우선 확인

### 세션 인수인계를 받고 싶을 때

- 직전 세션 맥락
  - [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
- 장기 구현 맥락
  - [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
  - [docs/CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)

### 왜 이렇게 설계됐는지 보고 싶을 때

- 전체 구조
  - [docs/SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
- 코딩/운영 원칙
  - [docs/coding-guide.md](/Users/alexlee/projects/ai-agent-system/docs/coding-guide.md)
- 연구/결정 배경
  - [docs/RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

### 세션 종료 시 무엇을 갱신해야 하는지 보고 싶을 때

- 현재 상태 / 다음 작업
  - [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
- 사실 기록
  - [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
  - [docs/CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
  - [docs/TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
  - [docs/KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
- 장기 의사결정 / 회고
  - [docs/RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

### 세션 문서 흐름이 실제로 이어지는지 점검하고 싶을 때

아래 순서로만 읽어서 현재 상태가 이해되면 문서 흐름은 정상이다.

1. `CLAUDE.md`
2. `SESSION_CONTEXT_INDEX.md`
3. `SESSION_HANDOFF.md`
4. `PLATFORM_IMPLEMENTATION_TRACKER.md`
5. `WORK_HISTORY.md`
6. `RESEARCH_JOURNAL.md`

이 순서에서 막히는 지점이 있으면:
- 진입 문서에 링크가 빠졌거나
- 현재 상태가 handoff에 충분히 안 적혔거나
- 팀 참조 문서가 실제 코드와 어긋난 것이다.

### 문서 파싱/OCR 흐름을 보고 싶을 때

- 공용 파서 진입점
  - [packages/core/lib/document-parser.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/document-parser.js)
  - [packages/core/lib/document-parsing/registry.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/document-parsing/registry.js)
- 워커 운영 화면
  - [bots/worker/web/app/admin/ocr-test/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/ocr-test/page.js)
  - [bots/worker/web/app/admin/monitoring/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js)

### 워커 LLM API 적용 상태를 보고 싶을 때

- 화면
  - [bots/worker/web/app/admin/monitoring/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js)
- 서버/API
  - [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
- 설정 저장
  - [bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js)
  - [bots/worker/migrations/017-system-preferences.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/017-system-preferences.sql)

### 자동화/리뷰 흐름을 보고 싶을 때

- 자동매매 리뷰
  - [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
  - [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)
- 스카 예측 리뷰
  - [scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
  - [scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)
- 제이/운영 리뷰
  - [scripts/reviews/jay-llm-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-daily-review.js)

---

## 3. 공통 레이어별 핵심 진입점

### health

- [packages/core/lib/health-provider.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-provider.js)
- [packages/core/lib/health-db.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-db.js)
- 관련 계획:
  - [packages/core/HEALTH_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/HEALTH_ENGINE_PLAN.md)

### intent

- [packages/core/lib/intent-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-core.js)
- 관련 계획:
  - [packages/core/INTENT_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/INTENT_ENGINE_PLAN.md)

### reporting

- [packages/core/lib/reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
- 관련 문서:
  - [packages/core/REPORTING_HUB_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/REPORTING_HUB_PLAN.md)
  - [packages/core/REPORTING_INVENTORY.md](/Users/alexlee/projects/ai-agent-system/packages/core/REPORTING_INVENTORY.md)

### feedback

- [packages/core/lib/ai-feedback-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-core.js)
- [packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js)
- 관련 문서:
  - [docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md](/Users/alexlee/projects/ai-agent-system/docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md)

### document parsing / OCR

- [packages/core/lib/document-parser.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/document-parser.js)
- [packages/core/lib/document-parsing/registry.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/document-parsing/registry.js)

---

## 4. 팀별 빠른 진입점

### 워커

- 핵심 서버/리드
  - [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
  - [bots/worker/src/worker-lead.js](/Users/alexlee/projects/ai-agent-system/bots/worker/src/worker-lead.js)
- 핵심 화면
  - [bots/worker/web/app/dashboard/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/dashboard/page.js)
  - [bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)
  - [bots/worker/web/app/approvals/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js)
  - [bots/worker/web/app/admin/ocr-test/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/ocr-test/page.js)
  - [bots/worker/web/app/admin/monitoring/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js)
- 정책/프롬프트/OCR
  - [bots/worker/lib/ai-policy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/ai-policy.js)
  - [bots/worker/lib/menu-policy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/menu-policy.js)
  - [bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js)
  - [bots/worker/web/components/PromptAdvisor.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/PromptAdvisor.js)
  - [bots/worker/web/lib/document-attachment.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/document-attachment.js)
- 운영 설정/상태
  - [bots/worker/config.json](/Users/alexlee/projects/ai-agent-system/bots/worker/config.json)
  - [bots/worker/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/runtime-config.js)
  - [bots/worker/web/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/runtime-config.js)
  - [bots/worker/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/health-report.js)

### 루나

- 핵심 팀장/리스크/실행
  - [bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
  - [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
  - [bots/investment/team/hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
- 시장별
  - [bots/investment/markets/crypto.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js)
  - [bots/investment/markets/domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
  - [bots/investment/markets/overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)
- 분석/상태
  - [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
  - [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)
  - [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
- 운영 설정
  - [bots/investment/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
  - [bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)

### 스카

- 예약 모니터/핵심 실행
  - [bots/reservation/auto/monitors/naver-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.js)
  - [bots/reservation/auto/monitors/pickko-kiosk-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.js)
- 예측/리뷰
  - [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
  - [bots/ska/src/rebecca.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py)
  - [scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
  - [scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)
- 운영 설정/상태
  - [bots/reservation/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/reservation/config.yaml)
  - [bots/reservation/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/runtime-config.js)
  - [bots/ska/config.json](/Users/alexlee/projects/ai-agent-system/bots/ska/config.json)
  - [bots/ska/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/runtime-config.js)
  - [bots/reservation/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js)

### 클로드 / 덱스터

- 핵심 진입점
  - [bots/claude/src/dexter.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter.js)
  - [bots/claude/src/dexter-quickcheck.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter-quickcheck.js)
- 체크 모듈
  - [bots/claude/lib/checks/bots.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/bots.js)
  - [bots/claude/lib/checks/resources.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/resources.js)
  - [bots/claude/lib/checks/database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)
  - [bots/claude/lib/checks/n8n.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/n8n.js)
- 운영 설정/상태
  - [bots/claude/config.json](/Users/alexlee/projects/ai-agent-system/bots/claude/config.json)
  - [bots/claude/lib/config.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/config.js)
  - [bots/claude/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js)

### 제이 / 오케스트레이터

- 핵심 진입점
  - [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)
  - [bots/orchestrator/lib/intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)
- 운영 상태
  - [bots/orchestrator/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js)
  - [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)
- 운영 설정/문맥
  - [bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
  - [bots/orchestrator/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/runtime-config.js)
  - [bots/orchestrator/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/DEV_SUMMARY.md)

### 블로

- 핵심 진입점
  - [bots/blog/lib/maestro.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/maestro.js)
  - [bots/blog/lib/gems-writer.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/gems-writer.js)
  - [bots/blog/lib/pos-writer.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/pos-writer.js)
- 운영 상태/설정
  - [bots/blog/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-report.js)
  - [bots/blog/config.json](/Users/alexlee/projects/ai-agent-system/bots/blog/config.json)
  - [bots/blog/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.js)

---

## 5. 인수인계용 유지 규칙

- 새 세션에서 시스템을 이해하려면 최소 아래 순서를 지킨다.
  1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
  2. [docs/SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
  3. [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  4. [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
- 코덱 세션은 시작과 종료 모두 이 규칙을 따른다.
- 종료 시에는 최소 `SESSION_HANDOFF / WORK_HISTORY / CHANGELOG / TEST_RESULTS` 갱신 필요 여부를 확인한다.
- 새 기능을 구현했을 때 아래 중 하나에 해당하면 이 문서도 같이 갱신한다.
  - 여러 팀이 공통으로 알아야 하는 규칙
  - 세션이 바뀌어도 다시 찾아야 하는 진입점
  - 운영 중 자주 바꾸는 설정 위치
  - 팀별 핵심 상태 확인 스크립트

---

## 6. 관련 문서

- [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
- [docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [docs/team-features.md](/Users/alexlee/projects/ai-agent-system/docs/team-features.md)
- [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)

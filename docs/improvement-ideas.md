# 플랫폼 개발 추적 문서

> 마지막 업데이트: 2026-03-15
> 목적: 로컬 문서, 실제 코드 구현 상태, 최근 커밋 이력을 기준으로 플랫폼 개발 진행 상황을 누적 추적한다.

---

## 1. 문서 사용 원칙

- 이 문서는 `아이디어 메모`가 아니라 `개발 추적 문서`다.
- 항목은 아래 3가지로 구분한다.
  - `완료`: 코드와 문서 기준으로 실제 반영이 확인된 상태
  - `진행 중`: 구조는 올라왔지만 일부 핵심 연결이나 운영 검증이 남은 상태
  - `미완료`: 설계 또는 다음 작업만 정의된 상태
- 날짜는 가능한 한 `마지막 구현일` 기준으로 적는다.
- 세부 근거는 관련 문서나 실제 코드 경로를 함께 적는다.

---

## 2. 수집 근거

### 로컬 문서

- [README.md](/Users/alexlee/projects/ai-agent-system/README.md)
- [docs/SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
- [docs/coding-guide.md](/Users/alexlee/projects/ai-agent-system/docs/coding-guide.md)
- [docs/team-features.md](/Users/alexlee/projects/ai-agent-system/docs/team-features.md)
- [docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md](/Users/alexlee/projects/ai-agent-system/docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md)
- [packages/core/HEALTH_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/HEALTH_ENGINE_PLAN.md)
- [packages/core/INTENT_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/INTENT_ENGINE_PLAN.md)
- [packages/core/REPORTING_HUB_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/REPORTING_HUB_PLAN.md)
- [packages/core/REPORTING_INVENTORY.md](/Users/alexlee/projects/ai-agent-system/packages/core/REPORTING_INVENTORY.md)
- [bots/reservation/context/N8N_NODE_PLAN.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/N8N_NODE_PLAN.md)
- [bots/reservation/context/N8N_COMMAND_CONTRACT.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/N8N_COMMAND_CONTRACT.md)
- [bots/orchestrator/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/DEV_SUMMARY.md)

### 로컬 구현 상태

- `bots/`, `packages/core/`, `docs/` 하위 실제 코드와 스크립트
- `git log --since=2026-03-04` 기준 최근 구현 커밋

### 노션 페이지 수집 상태

- 대상 링크:
  - [기존 노션 링크](https://www.notion.so/Team-Jay-31fff93a809a81468d84c5f74b3485e4?source=copy_link)
  - [퍼블릭 사이트 링크](https://sour-pipe-122.notion.site/Team-Jay-31fff93a809a81468d84c5f74b3485e4?source=copy_link)
- 2026-03-15 기준 CLI 수집 결과:
  - 공개 페이지 셸 HTML은 확인됨
  - 본문 데이터는 JavaScript 기반으로만 로드되어 자동 추출이 실패함
- 따라서 이번 반영은 `로컬 문서 + 실제 구현 + 커밋 이력`을 기준으로 우선 정리했고, 노션 본문은 추후 수동 대조가 필요한 상태로 남긴다.

---

## 3. 현재 플랫폼 개발 상태 요약

### 전체 판단

- 공용화 축은 크게 진척됐다.
  - `health engine`
  - `intent engine`
  - `reporting hub`
  - `AI feedback layer`
- 운영 안정화도 많이 올라왔다.
  - 통합 헬스
  - 브리핑
  - n8n live webhook 경로 점검
  - 스카 운영 알람/프로세스 안정화
- 지금부터의 핵심은 `새 축 확장`보다 `기존 축의 실제 업무 연결 마무리`다.

### 지금 가장 중요한 개발 축

1. 워커 확인창 기반 AI 피드백 UX 완성
2. 피드백 데이터의 RAG 연결
3. 스카 n8n node화 2차와 write/ops 계열 고도화
4. 스카 RAG의 retrieval-first 활용 강화
5. 권한별 LLM 정책의 실제 런타임 반영

---

## 4. 완료된 개발 축

### 4.1 공용 Health Engine

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-15 | 공용 health 포맷 | JS/Python 공용 health formatter 정리 | [packages/core/HEALTH_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/HEALTH_ENGINE_PLAN.md) |
| 완료 | 2026-03-15 | 공용 provider/adapter | launchd, HTTP, file staleness, DB health adapter 공용화 | [packages/core/lib/health-provider.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-provider.js), [packages/core/lib/health-db.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-db.js) |
| 완료 | 2026-03-15 | 팀별 헬스 리포트 | 루나, 워커, 클로드, 스카, 블로, 오케스트레이터 헬스 라우팅 완료 | [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js) |
| 완료 | 2026-03-15 | 통합 운영 헬스 | `/ops-health`, `summary`, `alerts`, `briefing`까지 구축 | [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js) |
| 완료 | 2026-03-15 | false warning 정리 | 클로드 shadow mismatch, 스카 scheduled job 경고 완화 | [bots/claude/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js), [bots/reservation/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js) |

### 4.2 공용 Intent Engine

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-14 | shared intent core/store | 팀 공용 메타, promotion, unrecognized, report frame 공용화 | [packages/core/INTENT_ENGINE_PLAN.md](/Users/alexlee/projects/ai-agent-system/packages/core/INTENT_ENGINE_PLAN.md) |
| 완료 | 2026-03-14 | 팀 연결 | worker, ska, claude, luna를 shared intent store에 연결 | [packages/core/lib/intent-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/intent-core.js) |
| 완료 | 2026-03-15 | direct routing 운영화 | 팀 인텐트 보고/롤백/헬스가 제이에서 직접 조회 가능 | [bots/orchestrator/lib/intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js) |

### 4.3 공용 Reporting Hub

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-15 | reporting-hub 코어 | payload 표준화, validation, telemetry, fanout, delivery policy 구축 | [packages/core/lib/reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js) |
| 완료 | 2026-03-15 | producer 이관 | reservation, investment, claude, worker, blog 주요 알림/리포트가 허브 경유 | [packages/core/REPORTING_INVENTORY.md](/Users/alexlee/projects/ai-agent-system/packages/core/REPORTING_INVENTORY.md) |
| 완료 | 2026-03-15 | mainbot consumer 고도화 | payload title/summary/action/links를 소비 단계에서 활용 | [bots/orchestrator/lib/batch-formatter.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/batch-formatter.js) |
| 완료 | 2026-03-15 | reporting health | `/reporting-health`, summary, producers, 브리핑 연동 | [bots/orchestrator/scripts/reporting-health.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/reporting-health.js) |
| 완료 | 2026-03-15 | Python reporting bridge | 레베카/forecast 계열 stdout을 reporting-hub로 연결 | [packages/core/scripts/publish-python-report.js](/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js) |

### 4.4 AI Feedback Layer

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-15 | 공용 feedback core/store | `ai_feedback_sessions`, `ai_feedback_events` 공용 레이어 구축 | [packages/core/lib/ai-feedback-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-core.js), [packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js) |
| 완료 | 2026-03-15 | 워커 연결 | AI 업무 제안 → review 수정 → 승인/반려 → committed 연결 | [bots/worker/lib/ai-feedback-service.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/ai-feedback-service.js), [bots/worker/lib/approval.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/approval.js) |
| 완료 | 2026-03-15 | 블로 연결 | 커리큘럼 후보 생성 → 선택/직접 입력 → committed 연결 | [bots/blog/lib/ai-feedback.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/ai-feedback.js) |
| 완료 | 2026-03-15 | 클로드 연결 | LLM 졸업 후보 생성/승인 흐름에 feedback session 연결 | [packages/core/lib/llm-graduation.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-graduation.js) |
| 완료 | 2026-03-15 | 운영 조회/리포트 | `/feedback-health`, feedback report CLI, CSV export 지원 | [bots/orchestrator/scripts/feedback-health.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/feedback-health.js), [packages/core/scripts/feedback-report.js](/Users/alexlee/projects/ai-agent-system/packages/core/scripts/feedback-report.js) |

### 4.5 워커 AI 정책/권한 기반 UX 토대

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-15 | AI 정책 테이블 | 회사 기본값 + 사용자 override 컬럼 추가 | [bots/worker/migrations/013-ai-policy.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/013-ai-policy.sql) |
| 완료 | 2026-03-15 | 정책 계산 헬퍼 | `ui_mode`, `llm_mode`, `confirmation_mode`, toggle 여부 계산 | [bots/worker/lib/ai-policy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/ai-policy.js) |
| 완료 | 2026-03-15 | 설정 API/UI | `/api/settings/ai-policy`와 워커 설정 화면 반영 | [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js), [bots/worker/web/app/settings/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/settings/page.js) |

### 4.6 스카팀 예측/운영/명령 고도화

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-14~15 | 예측 feature store | `training_feature_daily` 구축, reservation 구조/모멘텀 feature 추가 | [bots/ska/lib/feature_store.py](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/feature_store.py) |
| 완료 | 2026-03-15 | 예측 원본 정리 | `forecast_results`를 source of truth로 정리, legacy accuracy/forecast 정리 | [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py) |
| 완료 | 2026-03-15 | forecast health | 예측 상태/추천/튜닝 우선순위 리포트와 제이 라우팅 구축 | [bots/ska/src/forecast_health.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast_health.py) |
| 완료 | 2026-03-15 | 스카 운영 안정화 | dev-mode 알람 스팸 방지, pending 재처리, kiosk bootstrap, launchd health 안정화 | [bots/reservation/auto/monitors/naver-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.js), [bots/reservation/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js) |
| 완료 | 2026-03-15 | 스카 n8n read 경로 | read 명령용 bridge, workflow draft, webhook registry path 해결 | [bots/reservation/context/N8N_NODE_PLAN.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/N8N_NODE_PLAN.md), [bots/reservation/lib/ska-read-service.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/ska-read-service.js) |

### 4.7 n8n 운영/경로 안정화

| 상태 | 마지막 구현일 | 항목 | 내용 | 근거 |
|---|---|---|---|---|
| 완료 | 2026-03-15 | setup client 공용화 | 블로/워커/오케스트레이터/스카 워크플로우 재생성 로직 공용화 | [packages/core/lib/n8n-setup-client.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/n8n-setup-client.js) |
| 완료 | 2026-03-15 | live webhook resolver | registry 기준 production path 해석 | [packages/core/lib/n8n-webhook-registry.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/n8n-webhook-registry.js) |
| 완료 | 2026-03-15 | critical webhook 진단 | 오케스트레이터/클로드 헬스에 critical webhook 상태 노출 | [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js), [bots/claude/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js) |
| 완료 | 2026-03-15 | 알림 템플릿 정리 | critical 알림 health probe 차단, 한글화, 개인 DM 제거 | [bots/orchestrator/n8n/setup-n8n.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/n8n/setup-n8n.js), [bots/orchestrator/n8n/setup-ska-workflows.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/n8n/setup-ska-workflows.js) |

---

## 5. 진행 중인 개발 축

| 상태 | 마지막 구현일 | 항목 | 현재 상태 | 남은 일 |
|---|---|---|---|---|
| 진행 중 | 2026-03-15 | 워커 확인 결과 창 UX | 정책 테이블, feedback layer, review 저장은 준비됨 | attendance/leave 등 정형 업무에 실제 확인창 연결 |
| 진행 중 | 2026-03-15 | 워커 권한별 화면 분기 | 정책 저장과 설정 UI는 있음 | `prompt_only`, `prompt_plus_dashboard`, `full_master_console`를 실제 메인 화면에 반영 |
| 진행 중 | 2026-03-15 | feedback analytics 운영화 | CLI, direct routing, 브리핑 요약까지 있음 | 주간 자동 리포트와 품질 경보 기준 튜닝 |
| 진행 중 | 2026-03-15 | reporting-hub 이관 마무리 | 주요 producer 대부분 이관 | team-bus/잔여 직결 발송 경로 전수 점검 |
| 진행 중 | 2026-03-15 | 스카 n8n node화 | read 명령과 bridge, workflow draft는 완료 | write/ops 계열 `store_resolution`, `analyze_unknown`, restart 계열 보수적 이관 |
| 진행 중 | 2026-03-15 | 스카 RAG 활용 | 저장/조회 adapter는 정리됨 | retrieval-first 운영 힌트, 실패 복구 사례 검색 연결 |

---

## 6. 미완료 개발 축

### 6.1 워커 / AI 입력 UX

| 상태 | 목표 | 비고 |
|---|---|---|
| 미완료 | [bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)에 확인 결과 창 추가 | [docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md](/Users/alexlee/projects/ai-agent-system/docs/AI_FEEDBACK_CONFIRMATION_ARCHITECTURE.md) 1순위 항목 |
| 미완료 | 일반사용자/관리자/마스터 화면 차등 적용 | 현재는 정책만 저장되고 실제 화면 분기는 제한적 |
| 미완료 | 관리자 현황 위젯 강화 | 미출근, 출근 예정, 승인 대기, 예외 감지 등을 카드로 노출 필요 |
| 미완료 | LLM ON/OFF 정책의 런타임 반영 | 현재는 설정 저장 중심, 실제 라우팅 정책 반영은 후속 작업 |

### 6.2 피드백 + RAG / 학습 데이터

| 상태 | 목표 | 비고 |
|---|---|---|
| 미완료 | feedback session → `feedback_cases` RAG artifact adapter | committed/submitted 세션만 파생 인덱스로 저장 권장 |
| 미완료 | accepted_without_edit 기반 품질 랭킹 자동화 | 일별/주별 추이 리포트 가능 |
| 미완료 | 블로/클로드 세부 수정 diff 심화 | 현재는 승인/채택 중심, `field_edited`는 워커가 가장 깊음 |
| 미완료 | training/export 자동화 | analytics export는 준비됐지만 training dataset 연결은 아직 없음 |

### 6.3 스카팀 고도화

| 상태 | 목표 | 비고 |
|---|---|---|
| 미완료 | 스카 n8n node화 2차 | `store_resolution`, `analyze_unknown` 이관 |
| 미완료 | 스카 운영 명령 공용화 마감 | restart/launchd 계열은 로컬 fallback 유지하며 더 표준화 가능 |
| 미완료 | 스카 RAG retrieval 활용 강화 | 실패 복구/과거 해결사례 검색을 커맨더 의사결정에 반영 |
| 미완료 | 스카 예측 데이터셋 학습 루프 | feedback/RAG와 연결한 장기 품질 개선은 아직 후순위 |

### 6.4 플랫폼 장기 항목

| 상태 | 목표 | 비고 |
|---|---|---|
| 미완료 | 맥미니 이전 후 로컬 LLM 전략 | 기존 문서의 장기 로드맵 유지 |
| 미완료 | Grafana/Loki 또는 커스텀 시각화 대시보드 | 현재는 헬스/브리핑/텔레그램 중심 |
| 미완료 | KIS 실계좌 전환 판단 | 루나 성과 축적 후 결정 |
| 미완료 | Playwright 기반 업무 일부의 API 전환 | 스카 네이버/픽코 계열 장기 검토 |

---

## 7. 분야별 현재 평가

### 워커

- 상태: `진행 중`
- 올라온 것:
  - 웹 워크스페이스
  - 승인형 AI task flow
  - feedback layer 연결
  - AI 정책 저장/조회
- 남은 핵심:
  - 근태 확인 결과 창
  - 권한별 화면 차등
  - 실제 llm_mode 런타임 반영

### 스카

- 상태: `진행 중`
- 올라온 것:
  - 예측 엔진/feature store
  - 운영 안정화
  - read 명령 n8n bridge
  - forecast health
- 남은 핵심:
  - write/ops 계열 node화
  - retrieval-first 운영 보조
  - 장기적으로 feedback/RAG/forecast 연결

### 루나

- 상태: `운영 안정화 + 중기 고도화 대기`
- 올라온 것:
  - health/reporting 통합
  - n8n node 초안
  - 리스크/거래 리뷰 체계
- 남은 핵심:
  - 성과 누적 기반 학습 루프
  - 실계좌 전환 판단

### 블로

- 상태: `운영화 + 공용화 진행`
- 올라온 것:
  - n8n pipeline
  - curriculum planner
  - feedback layer 2차 연결
  - reporting-hub 연결
- 남은 핵심:
  - 세부 수정 피드백 심화
  - 장문 생성 품질/후속 QA 자동화

### 클로드 / 오케스트레이터

- 상태: `운영 안정 구간`
- 올라온 것:
  - health, reporting, feedback, n8n critical webhook 운영 경로
  - unified ops health / briefing / reporting health
- 남은 핵심:
  - team-bus와 운영 리포팅 경계 정리
  - feedback export를 장기 학습 루프와 연결

---

## 8. 다음 우선순위 추천

### 1순위

1. 워커 근태 확인 결과 창 구현
2. 근태 흐름을 `proposal_generated -> field_edited -> confirmed -> committed`로 연결
3. WorkerAIWorkspace 권한별 분기 적용

### 2순위

1. feedback → RAG adapter 추가
2. 스카 n8n node화 2차
3. 스카 RAG retrieval-first 활용 연결

### 3순위

1. feedback 주간 품질 자동화
2. reporting-hub 잔여 producer 정리
3. 플랫폼 장기 항목의 환경 전환 준비

---

## 9. 최근 구현 타임라인

### 2026-03-15

- shared health engine 마감과 통합 ops health/briefing 고도화
- reporting-hub fanout, payload schema, reporting health 구축
- 스카 운영 안정화와 n8n command/live webhook 경로 정리
- AI feedback layer를 worker/blog/claude 흐름에 실제 연결
- worker AI 정책 테이블/설정 UI 추가

### 2026-03-14

- shared intent engine 확장
- worker chat/approval/n8n 축 고도화
- 스카 예측 feature store 및 calibration 고도화

### 2026-03-04 이전

- 기존 문서의 초기 Phase 기반 구축은 유지한다.
- 다만 2026-03-15 이후의 실제 구현이 훨씬 많이 누적되어, 현재 기준 우선순위 판단은 본 문서를 기준으로 삼는 것이 맞다.

---

## 10. 유지 규칙

- 이후 세션에서는 새 기능을 구현할 때 이 문서에 반드시 반영한다.
- `완료` 항목은 날짜와 근거 파일을 남긴다.
- `진행 중` 항목은 “무엇이 올라왔고 무엇이 남았는지”를 함께 적는다.
- 노션 본문을 추후 수동 확인하면, 이 문서의 `수집 근거` 섹션과 관련 항목에 대조 반영한다.

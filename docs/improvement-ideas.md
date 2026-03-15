# 플랫폼 개발 추적 문서

> 마지막 업데이트: 2026-03-16
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
- 사용자 수동 제공 본문 반영:
  - 워커 자연어 대화형 업무 등록 아키텍처
  - 역할별 메인 화면 구상
  - WebSocket 기반 양방향 대화 전략
  - 맥미니 이관 21개 항목
  - 초기 전략문서의 미실행 백로그 분류
- 따라서 이번 문서는 `로컬 문서 + 실제 구현 + 커밋 이력 + 사용자 제공 노션 본문`을 병합한 기준 문서다.

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

### 노션 기준 제품 방향 반영

- 워커의 주 입력 채널은 `수동 폼`이 아니라 `자연어 대화`가 메인이어야 한다.
- 웹 UI는 `채팅 + 캔버스` 패턴을 중심으로 재구성하는 것이 맞다.
- 역할별 메인 화면은 분리한다.
  - 멤버: 업무 대화와 본인 업무
  - 관리자: 팀 현황 + 승인/예외
  - 마스터: 전체 팀 대시보드 + 팀장 봇 대화
- 업무 CRUD는 SQL 중심으로 유지하되, 비정형 검색은 이후 `pgvector/RAG`로 붙인다.
- n8n은 대화 자체보다 `업무 실행 오케스트레이션` 계층으로 쓰는 것이 더 적합하다.

---

## 3.1 노션 기반 전략 항목 해석

### 워커팀 v2 핵심 방향

| 상태 | 항목 | 해석 |
|---|---|---|
| 진행 중 | 자연어 대화형 업무 등록 | worker chat/approval 흐름이 이미 있으므로 방향성은 맞고, 아직 근태/일정 확인창 UX가 남음 |
| 진행 중 | 채팅 + 캔버스 UI | 현재 워커 웹과 AI surface가 있으나 완전한 동적 캔버스 UX는 아직 미완료 |
| 진행 중 | 역할별 메인 화면 | AI 정책 저장은 완료, 실제 레이아웃 분기는 후속 작업 |
| 진행 중 | 하이브리드 아키텍처 | `웹/API + n8n + DB` 구조는 이미 부분 구현, 완전한 워커 대화 실행 파이프라인은 아직 진행 중 |
| 미완료 | Agent-to-UI / Generative UI | 현재 설계 참고 수준이며 실제 렌더링 엔진은 미구현 |

### 노션의 미실행 전략 백로그 해석

- 노션에 있는 `1주차 초기 설계 86개`, `2~6주차 안정화 76개`, `맥미니 이관 21개`는 그대로 실행 대기 목록으로 보기보다 다음처럼 재분류하는 것이 맞다.
  - 이미 다른 구현으로 흡수된 항목
  - 아직 운영 검증이 덜 된 항목
  - 진짜 미실행 항목
- 본 문서에서는 실제 코드 기준으로 그 재분류 결과를 아래 미완료 섹션에 반영한다.

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
| 진행 중 | 2026-03-16 | 워커 확인 결과 창 UX | attendance, leave, schedules, employees, payroll, sales, projects, journals에 자연어 제안/수정/확정 흐름 연결 완료. 주요 메뉴는 `메뉴 내부 프롬프트 1개 + 하단 승인 리스트` 구조로 통일됨. 승인 카드와 유사 사례 카드도 프롬프트 재사용 흐름으로 연결됨 | 대시보드 운영 캔버스 추가 고도화, 시각 톤 마감 |
| 진행 중 | 2026-03-15 | 워커 권한별 화면 분기 | dashboard 역할 분기, 공용 채팅의 메뉴별 prompt/canvas 정책, 페이지 액션 정책까지 반영됨 | 마스터용 봇 대화 경험과 관리자용 현황 위젯 심화 |
| 진행 중 | 2026-03-15 | feedback analytics 운영화 | CLI, direct routing, 브리핑 요약까지 있음 | 주간 자동 리포트와 품질 경보 기준 튜닝 |
| 진행 중 | 2026-03-15 | reporting-hub 이관 마무리 | 주요 producer 대부분 이관 | team-bus/잔여 직결 발송 경로 전수 점검 |
| 진행 중 | 2026-03-15 | 스카 n8n node화 | read 명령과 bridge, workflow draft는 완료 | write/ops 계열 `store_resolution`, `analyze_unknown`, restart 계열 보수적 이관 |
| 진행 중 | 2026-03-15 | 스카 RAG 활용 | 저장/조회 adapter는 정리됨 | retrieval-first 운영 힌트, 실패 복구 사례 검색 연결 |

---

## 6. 미완료 개발 축

### 6.1 워커 / AI 입력 UX

| 상태 | 목표 | 비고 |
|---|---|---|
| 진행 중 | 자연어 대화형 업무 등록 메인 UX | 근태, 일정, 직원, 급여, 매출, 프로젝트, 업무일지에 확인 결과 창 기반 자연어 등록이 연결됨. 현재는 핵심 메뉴가 `메뉴 내부 프롬프트 1개 + 하단 승인 리스트` 구조까지 정리됐고, 승인 카드/유사 사례/대시보드/승인 inbox가 같은 프롬프트 흐름으로 연결됨 |
| 완료 | [bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)에 확인 결과 창 추가 | 자연어 제안, 수정, 승인/반려, 유사 사례 조회, feedback 기록까지 구현 완료. leave도 attendance 내부 흐름으로 통합 |
| 진행 중 | 일반사용자/관리자/마스터 화면 차등 적용 | dashboard 역할 분기, menu_policy 기반 메뉴 노출/접근/액션 제어, 메뉴별 프롬프트 노출 정책까지 반영됨. 마스터 전용 운영 대화 경험은 추가 고도화 여지 있음 |
| 미완료 | 관리자 현황 위젯 강화 | 미출근, 출근 예정, 승인 대기, 예외 감지 등을 카드로 노출 필요 |
| 완료 | LLM ON/OFF 정책의 런타임 반영 | `llm_mode=off|assist|full`이 chat-agent와 워커 공용 채팅 런타임에 적용됨 |
| 진행 중 | 채팅 + 캔버스 레이아웃 정착 | dashboard는 `프롬프트 + 운영 캔버스 + 최근 업무 큐`, 정형 메뉴는 `로컬 프롬프트 + 승인 리스트` 구조로 정리됨. 남은 것은 시각적 일관화와 마스터 캔버스 심화 |
| 미완료 | 봇 대화 API의 역할별 확장 | 마스터는 팀장 봇 대화, 관리자/멤버는 제한된 범위의 대화 UX 필요 |

### 6.2 피드백 + RAG / 학습 데이터

| 상태 | 목표 | 비고 |
|---|---|---|
| 완료 | feedback session → `feedback_cases` RAG artifact adapter | committed/submitted 세션을 정제해 `feedback_cases`로 적재하고, 워커 정형 업무 확인창에서 유사 사례 조회까지 연결됨 |
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
| 미완료 | 맥미니 이관 21개 항목 실행 | 노션 전략문서의 이관 체크리스트 기준. 실제 장비 도착 후 실행 |
| 미완료 | 백테스팅/시뮬레이션 고도화 | 로컬 LLM 및 맥미니 환경이 붙은 뒤 본격 진행하는 편이 맞음 |
| 미완료 | Grafana/Loki 또는 커스텀 시각화 대시보드 | 현재는 헬스/브리핑/텔레그램 중심 |
| 미완료 | KIS 실계좌 전환 판단 | 루나 성과 축적 후 결정 |
| 미완료 | Playwright 기반 업무 일부의 API 전환 | 스카 네이버/픽코 계열 장기 검토 |
| 미완료 | Agent-to-UI / Generative UI 실험 | 고정 폼이 아닌 동적 UI 생성 실험은 장기 과제 |

### 6.5 노션 전략문서 미실행 항목 정리

| 상태 | 목표 | 비고 |
|---|---|---|
| 재분류 필요 | 1주차 초기 설계 86개 | 상당수는 이미 다른 구조로 구현된 상태라 항목별 교차 검토 필요 |
| 재분류 필요 | 2~6주차 안정화 76개 | KPI/스트레스/장애 복구 테스트는 실제 운영 검증 항목으로 흡수하는 편이 맞음 |
| 미완료 | 단위/E2E/장애 주입 재검증 체계 | 노션 항목 중 실제로 아직 약한 부분은 이 축으로 모아 관리 필요 |

---

## 7. 분야별 현재 평가

### 워커

- 상태: `핵심 UX 1차 구현 완료, 2차 고도화 진행 중`
- 올라온 것:
  - 웹 워크스페이스
  - 승인형 AI task flow
  - feedback layer 연결
  - AI 정책 저장/조회
  - 자연어 채팅 기반 작업 intake
  - attendance/schedules/employees/payroll/sales/projects/journals 확인 결과 창
  - feedback -> RAG 적재와 유사 사례 retrieval
  - menu_policy 기반 메뉴 노출, 경로 접근, 페이지 액션, 공용 채팅 정책
- 남은 핵심:
  - 대화형 입력을 워커 기본 진입 UX로 더 끌어올리기
  - 관리자 현황 위젯과 마스터 봇 대화 고도화
  - 승인 리스트 시각적 완성도 향상
  - 채팅 + 캔버스 패턴 시각적 완성도 향상

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

### 맥미니 이전

- 상태: `대기`
- 올라온 것:
  - 장기 과제로만 남아 있고 실제 이관 작업은 아직 시작 전
- 남은 핵심:
  - 보안/런타임/데이터 복사/launchd/텔레그램/24시간 관찰까지 체크리스트 실행

---

## 8. 조정된 개발 우선순위

> 기준:
> - 맥미니 예상 도착: 2026년 4월 1주~2주
> - 3월 남은 기간에는 `현재 환경에서 구현 가능한 대부분의 작업`을 최대한 당긴다.
> - 맥미니 도착 후로 남기는 것은 `실제 이관 실행`과 `로컬 LLM 전략 검토` 두 가지뿐이다.

### P1. 3월 즉시 실행

1. 워커 자연어 대화형 입력을 메인 UX로 더 전면화
2. 채팅 + 캔버스 패턴의 동적 렌더링 품질 향상
3. leave/documents 등 남은 메뉴에 확인 결과 창 확장
4. 관리자 현황 위젯과 마스터 전용 봇 대화 경험 고도화
5. 메뉴 정책을 문서/운영 가이드와 완전히 동기화

이유:
- 노션의 워커 v2 방향과 가장 직접적으로 연결됨
- 이미 feedback layer와 ai_policy 토대가 있어 구현 효율이 높음
- 사용자가 바로 체감할 수 있음

### P2. 3월 병행 실행

1. feedback → RAG adapter 추가
2. 스카 n8n node화 2차
3. 스카 RAG retrieval-first 활용 연결
4. feedback 주간 품질 자동화
5. reporting-hub 잔여 producer 전수 마감
6. team-bus와 운영 리포팅 경계 정리

이유:
- 현재 구조를 더 똑똑하게 만드는 고도화 작업
- 운영 리스크는 상대적으로 낮고, 기존 공용 레이어를 재사용 가능
- 워커 UX 작업과 병렬로 진행 가능

### P3. 3월 말까지 실행 또는 준비

1. 맥미니 이관 체크리스트 구체화
2. secrets / DB / launchd / n8n 이전 절차 문서 확정
3. 24시간 관찰 체크리스트와 롤백 절차 정리
4. Agent-to-UI / Generative UI 실험 범위 정의
5. Grafana/Loki 또는 커스텀 시각화 대시보드 설계
6. Playwright 기반 업무의 API 전환 범위 정리

이유:
- 장비 도착 전까지 문서와 절차를 고정해야 실제 전환이 빨라짐
- 구현 가능한 설계와 준비 작업은 최대한 선반영하는 편이 유리함

### P4. 맥미니 도착 후 실행

1. 맥미니 이관 21개 항목 실제 실행
2. 로컬 LLM 전략 검토
3. 백테스팅/시뮬레이션 고도화

이유:
- 실제 장비와 새 운영 환경이 필요한 항목만 남긴다.

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

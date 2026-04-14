---
name: orchestrator-ops-playbook
description: Use when operating, debugging, or improving the orchestrator and OpenClaw stack in this repository, especially when working on mainbot queue flow, orchestrator runtime behavior, unified ops health, critical n8n webhook delivery, or briefing and batch formatting.
---

# Orchestrator Ops Playbook

이 스킬은 제이 오케스트레이터와 OpenClaw 운영 흐름을 다룰 때 사용한다.

주요 대상:

- `mainbot_queue`
- `orchestrator runtime`
- OpenClaw gateway
- `critical webhook`
- `/ops-health`
- 브리핑/배치 포맷

## 먼저 볼 파일

핵심 운영 경로:

- `bots/orchestrator/src/orchestrator.ts`
- `dist/ts-runtime/bots/orchestrator/src/orchestrator.js`
- `bots/orchestrator/src/mainbot.js` (legacy alias)
- `bots/orchestrator/src/router.js`
- `bots/orchestrator/src/filter.js`
- `bots/orchestrator/lib/batch-formatter.js`
- `bots/orchestrator/lib/night-handler.js`
- `bots/orchestrator/scripts/health-report.js`
- `bots/orchestrator/scripts/check-n8n-critical-path.js`
- `bots/orchestrator/scripts/reporting-health.js`

공용 계층:

- `packages/core/lib/reporting-hub.js`
- `packages/core/lib/health-core.js`
- `packages/core/lib/health-provider.js`
- `packages/core/lib/health-db.js`
- `packages/core/lib/message-envelope.js`

## 기본 원칙

- 오케스트레이터는 producer보다 consumer/orchestrator 성격이 강하다.
- 문제를 볼 때는 `queue 적체`, `gateway 상태`, `critical webhook`, `브리핑/배치 소비`를 분리해서 본다.
- `/ops-health`와 `/orchestrator-health`는 같은 신호를 보되, 통합 뷰와 전용 뷰의 역할을 섞지 않는다.
- reporting payload 문제는 문자열 첫 줄보다 structured payload를 우선 확인한다.

## 자주 보는 운영 흐름

### 1. 오케스트레이터 큐 소비

순서:

1. producer가 `mainbot_queue`에 적재
2. `orchestrator` runtime이 폴링
3. `filter.js`가 defer/batch 경로 결정
4. `batch-formatter.js`가 렌더링
5. gateway 또는 telegram 경로로 발송

문제가 생기면 먼저 본다.

- 큐 적체가 생겼는지
- payload title/summary/details가 비정상인지
- batch formatter가 fallback 문자열 파싱으로 떨어졌는지

### 2. critical webhook

확인 순서:

1. `n8n healthz`
2. resolved production webhook registration
3. probe가 실제 장애 알림으로 fanout되지 않는지
4. setup script 재적용 필요 여부

### 3. 통합 운영 헬스

- `/ops-health`
- `/ops-health summary`
- `/ops-health alerts`
- `/ops-health briefing`

위 4개는 같은 신호를 다른 밀도로 보여주는 것이므로, 뷰 간 불일치가 없는지 함께 본다.

## 검증 기본 세트

- `node --check bots/orchestrator/src/router.js`
- `node --check bots/orchestrator/lib/night-handler.js`
- `node bots/orchestrator/scripts/health-report.js --json`
- `node bots/orchestrator/scripts/check-n8n-critical-path.js`
- `node bots/orchestrator/scripts/reporting-health.js --summary`

## 흔한 함정

- gateway 문제를 mainbot queue 문제로 오해하는 경우
- `healthz ok`만 보고 critical webhook live path는 안 보는 경우
- 브리핑 스니펫 문제를 source signal 문제와 섞는 경우
- reporting payload warning을 단순 텍스트 포맷 문제로만 보는 경우

## 마무리 체크

- queue 적체와 gateway 상태를 분리해서 설명했는가
- critical webhook이 실제 live path 기준으로 정상인가
- `/ops-health`와 `/orchestrator-health`가 같은 현실을 보여주는가
- 브리핑/배치 포맷이 structured payload를 우선 사용하고 있는가

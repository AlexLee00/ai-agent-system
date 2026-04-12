---
name: ska-ops-playbook
description: Use when operating, debugging, or improving the Ska reservation stack in this repository, especially when working on naver-monitor, Pickko registration flow, Ska commander commands, n8n bridge integration, reservation RAG, or Ska health and launchd behavior.
---

# Ska Ops Playbook

이 스킬은 스카팀의 예약 운영 흐름을 다룰 때 사용한다.

주요 대상:

- `naver-monitor`
- Pickko 예약 등록/후속 처리
- 스카 커맨더
- `n8n` bridge / command workflow
- reservation RAG
- 스카 헬스/launchd

## 먼저 볼 파일

핵심 운영 경로:

- `bots/reservation/auto/monitors/naver-monitor.ts`
- `bots/reservation/auto/monitors/start-ops.sh`
- `dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js`
- `bots/reservation/src/ska.ts`
- `bots/reservation/lib/ska-command-queue.ts`
- `bots/reservation/lib/ska-command-handlers.ts`
- `bots/reservation/lib/ska-read-service.ts`
- `bots/reservation/scripts/health-report.ts`
- `dist/ts-runtime/bots/reservation/scripts/health-report.js`
- `bots/reservation/scripts/health-check.ts`

공용 계층:

- `packages/core/lib/reservation-rag.js`
- `packages/core/lib/n8n-runner.js`
- `packages/core/lib/intent-core.js`
- `packages/core/lib/intent-store.js`
- `packages/core/lib/health-provider.js`

n8n 관련:

- `bots/reservation/context/N8N_NODE_PLAN.md`
- `bots/reservation/context/N8N_COMMAND_CONTRACT.md`
- `bots/reservation/context/n8n-ska-command-workflow.json`
- `bots/reservation/n8n/setup-ska-command-workflow.ts`
- `dist/ts-runtime/bots/reservation/n8n/setup-ska-command-workflow.js`
- `bots/reservation/scripts/dashboard-server.ts`
- `dist/ts-runtime/bots/reservation/scripts/dashboard-server.js`
- `bots/reservation/scripts/check-n8n-command-path.ts`

## 기본 원칙

- 알림만 울리고 후속 처리(Pickko 등록/상태 전이)가 멈추는 경로를 가장 먼저 의심한다.
- `dev`와 `ops` 모드를 섞어 해석하지 않는다.
- 이미 DB에 있는 예약이라도 `pending` 또는 `failed`면 재처리 후보인지 확인한다.
- 스카 명령 read path는 `n8n bridge 우선, local fallback 유지` 원칙을 따른다.
- 운영 제어 명령은 로컬 fallback을 반드시 유지한다.

## 자주 보는 운영 흐름

### 1. 신규 예약 감지

순서:

1. `naver-monitor` 런타임이 예약 감지
2. DB 상태 생성/갱신
3. Pickko 실행 후보 판단
4. `pending -> processing -> completed` 상태 전이
5. RAG 저장

문제가 생기면 먼저 본다.

- 같은 예약이 중복 신규 알림으로 도는지
- `dev` 모드 문구가 운영 알림처럼 보이는지
- `pending` 예약이 재처리에서 빠지는지

### 2. 스카 커맨더 read 명령

대상:

- `query_reservations`
- `query_today_stats`
- `query_alerts`

확인 순서:

1. `ska-command-handlers.ts`
2. `ska-read-service.ts`
3. `dashboard-server` bridge endpoint
4. `n8n-runner.js`
5. `check-n8n-command-path.js`

### 3. 헬스/launchd

- 상시 서비스와 스케줄 작업을 구분한다.
- `kickstart` 전에 `bootstrap`이 필요한지 본다.
- false warning보다 실제 로그 활동성 정지 여부를 더 중요하게 본다.

## 검증 기본 세트

- `node --check bots/reservation/src/ska.ts`
- `node --check bots/reservation/lib/ska-command-handlers.ts`
- `node --check bots/reservation/lib/ska-read-service.ts`
- `node dist/ts-runtime/bots/reservation/scripts/health-report.js --json`
- `node dist/ts-runtime/bots/reservation/scripts/check-n8n-command-path.js`

필요 시:

- `/ska-health`
- `/ska-intents`
- `/ska-forecast`

## 흔한 함정

- `dev` 모드에서 감지만 하고 실제 Pickko 처리 없이 `pending`이 남는 경우
- 이미 DB에 있다고 신규 후보에서 제외해버려 재처리가 안 되는 경우
- `n8n healthz`만 보고 command webhook live path를 확인하지 않는 경우
- 스케줄형 launchd 작업을 `always running`으로 잘못 보는 경우

## 마무리 체크

- 예약 감지 후 실제 상태 전이가 이어지는가
- 중복 알림 없이 `pending/failed` 재처리가 되는가
- `n8n bridge`와 local fallback이 둘 다 살아 있는가
- health report가 false warning보다 실제 운영 신호를 우선 보여주는가

---
name: health-engine-operator
description: Use when creating, extending, reviewing, or debugging team health reports in this repository, especially when a team should use the shared health engine, expose --json health scripts, integrate with unified ops health, or align launchd, HTTP, file, and DB checks.
---

# Health Engine Operator

이 스킬은 이 저장소에서 `health-report`, `ops-health`, `launchd 상태`, `HTTP 경로`, `파일 stale`, `DB backlog`, `통합 운영 헬스`를 다룰 때 사용한다.

## 먼저 볼 파일

- `packages/core/HEALTH_ENGINE_PLAN.md`
- `packages/core/lib/health-core.js`
- `packages/core/lib/health-provider.js`
- `packages/core/lib/health-db.js`
- `packages/core/lib/health-runner.js`

헬스 consumer:

- `bots/orchestrator/scripts/health-report.js`
- `bots/orchestrator/src/router.js`
- `bots/orchestrator/lib/night-handler.js`

팀별 adapter 예시:

- `bots/investment/scripts/health-report.js`
- `bots/claude/scripts/health-report.js`
- `dist/ts-runtime/bots/reservation/scripts/health-report.js`
- `bots/blog/scripts/health-report.js`

## 기본 원칙

- 새 health 체크는 팀 로컬 프레임워크를 만들지 말고 공용 health engine을 우선 사용한다.
- 팀 스크립트는 thin adapter를 목표로 한다.
- 공용 계층이 맡는 것:
  - 포맷
  - decision
  - section builder
  - launchd provider
  - HTTP/JSON/file stale helper
  - DB backlog helper
  - CLI `--json` runner
- 팀별 script는 아래만 남긴다.
  - 어떤 서비스가 중요한지
  - 어떤 임계치가 중요한지
  - 팀 고유 business metric

## 새 팀 붙이는 절차

1. `<team>/scripts/health-report.js`를 만든다.
2. `runHealthCli()`로 `--json` 경로를 연다.
3. launchd, HTTP, file, DB 항목은 공용 provider/helper를 먼저 사용한다.
4. 팀 고유 metric만 로컬 함수로 남긴다.
5. 오케스트레이터 router에 direct route를 붙인다.
6. `/ops-health` 통합 집계에 추가한다.

## false warning 줄이는 기준

- 스케줄형 launchd 작업은 항상 running으로 보지 않는다.
- `healthz ok`와 `webhook registered`는 분리해서 본다.
- stale log나 오래된 backup 파일을 현재 장애로 오인하지 않는다.
- team health 판단은 핵심 서비스와 배치형 작업을 구분한다.

## 검증 기본 세트

- `node --check bots/<team>/scripts/health-report.js`
- `node bots/<team>/scripts/health-report.js --json`
- 오케스트레이터 소비 경로 확인:
  - `node bots/orchestrator/scripts/health-report.js --json`
  - `/ops-health`
  - `/ops-health summary`
  - `/ops-health alerts`

## 자주 보는 지점

### launchd drift

- `health-provider.js`의 service row builder를 우선 사용한다.
- 스케줄형 작업과 상시 서비스의 기준을 섞지 않는다.

### n8n 관련 health

- webhook 경로는 resolved live URL 기준으로 본다.
- check script와 team health report가 같은 helper를 쓰는지 확인한다.

### reporting / backlog signal

- reporting payload 경고, pending command, promotion backlog 같은 운영 품질 신호는 공용 DB/helper를 우선 사용한다.

## 마무리 체크

- team health script가 thin adapter 형태인가
- `--json` output이 안정적인가
- `/ops-health`와 아침 브리핑에 자연스럽게 반영되는가
- false positive를 만들 만한 기준이 없는가

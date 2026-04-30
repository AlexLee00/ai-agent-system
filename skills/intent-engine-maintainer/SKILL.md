---
name: intent-engine-maintainer
description: Use when extending, reviewing, or debugging the shared intent engine in this repository, especially when working on learned patterns, unrecognized phrase capture, auto-promotion, rollback, team intent reports, or shared intent-core and intent-store behavior.
---

# Intent Engine Maintainer

이 스킬은 이 저장소에서 `intent-core`, `intent-store`, `자동학습`, `미인식 명령`, `promotion`, `rollback`, `team intent report`를 다룰 때 사용한다.

## 먼저 볼 파일

- `packages/core/INTENT_ENGINE_PLAN.md`
- `packages/core/lib/intent-core.js`
- `packages/core/lib/intent-store.js`
- `bots/orchestrator/lib/intent-parser.js`
- `bots/orchestrator/src/router.js`

적용 대상:

- Claude: `bots/claude/src/claude-commander.js`
- Luna: `bots/investment/luna-commander.cjs`
- Ska: `bots/reservation/src/ska.ts`

## 기본 원칙

- intent 정책과 storage는 app 안에 다시 만들지 말고 core/store를 우선 쓴다.
- slash/keyword/handler switchboard는 앱 책임으로 남겨둔다.
- learned pattern, unknown capture, candidate/event persistence, report framing은 공용 계층을 재사용한다.
- 실행형 intent는 자동반영보다 안전정책을 우선한다.

## 작업 절차

### 1. 새 intent learning 경로 추가

1. 기존 앱이 어떤 schema를 쓰는지 확인한다.
2. `ensureIntentTables()`로 bootstrap이 되어 있는지 본다.
3. unknown phrase는 normalize 후 저장한다.
4. candidate/event는 공용 store helper로 적재한다.
5. auto-promotion은 `evaluateAutoPromoteDecision()` 기준으로만 판정한다.

### 2. 보고/운영 경로 수정

- `/unrec`
- `/promotions`
- `/promotions summary`
- `/promotions events`
- 팀별 `/luna-intents`, `/ska-intents`, `/claude-intents`

이런 리포트는 바깥 프레임과 섹션을 먼저 `intent-core`에서 찾고, router에서 문자열을 새로 만들지 않는다.

### 3. 롤백/수정

- learned pattern 파일을 직접 조작하기 전에 `intent-store`의 rollback/update helper를 우선 쓴다.
- 팀별 report/rollback 메타는 `getTeamIntentMeta()` 기준으로 맞춘다.

## 검증 기본 세트

- 관련 JS 수정 후: `node --check <file>`
- orchestrator routing 확인:
  - `/unrec`
  - `/unrec summary`
  - `/promotions pending`
  - `/promotions summary`
  - `/promotions events`
  - `/reporting-health`가 아니라 intent health는 `/intent-health`
- 팀별:
  - `/luna-intents`
  - `/ska-intents`
  - `/claude-intents`

## 흔한 함정

- schema 이름과 팀 이름을 섞지 않는다.
- learned pattern 파일 경로를 앱에서 다시 계산하지 않는다.
- 자동반영 기준을 앱 로컬 상수로 중복 선언하지 않는다.
- 실행형 intent를 query/status intent처럼 자동반영하지 않는다.

## 마무리 체크

- core/store helper를 우선 썼는가
- app 레이어는 routing/orchestration 중심으로 남았는가
- team meta와 threshold profile이 한 곳에서 관리되는가
- report/rollback 경로가 팀별로 어긋나지 않는가

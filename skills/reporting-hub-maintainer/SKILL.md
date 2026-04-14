---
name: reporting-hub-maintainer
description: Use when adding, migrating, reviewing, or debugging alerts and reports in this repository, especially when a producer should move onto the shared reporting-hub pipeline, use the standardized payload schema, or align with reporting health and briefing flows.
---

# Reporting Hub Maintainer

이 스킬은 이 저장소에서 `알림`, `리포트`, `브리핑 스니펫`, `mainbot_queue payload`, `alert publisher`, `reporting-hub fanout`을 다룰 때 사용한다.

## 먼저 볼 파일

- `packages/core/lib/reporting-hub.js`
- `packages/core/REPORTING_HUB_PLAN.md`
- `packages/core/REPORTING_INVENTORY.md`
- `bots/orchestrator/scripts/reporting-health.js`
- `bots/orchestrator/lib/night-handler.js`

팀별 producer를 만질 때는 관련 파일을 추가로 확인한다.

- Claude: `bots/claude/lib/reporter.js`, `bots/claude/lib/alert-publisher.ts`
- Luna: `bots/investment/team/reporter.js`, `bots/investment/shared/alert-publisher.ts`, `bots/investment/shared/report.js`
- Ska: `bots/reservation/lib/alert-client.ts`, `bots/reservation/lib/telegram.ts`
- Blog: `bots/blog/scripts/health-check.js`

## 기본 원칙

- 새 producer는 direct queue insert나 ad-hoc telegram send보다 `reporting-hub`를 우선 사용한다.
- 텍스트를 바로 이어붙이기보다 표준 payload를 만든 뒤 렌더링한다.
- payload는 아래 키를 우선 사용한다.
  - `title`
  - `summary`
  - `details`
  - `action`
  - `links`
- severity, dedupe, cooldown, quiet-hours, n8n escalation은 producer 안에서 새로 만들지 말고 허브 정책을 재사용한다.
- consumer가 첫 줄 문자열 파싱에 의존하지 않도록 structured payload를 유지한다.

## producer 이관 절차

1. producer가 지금 어디로 보내는지 확인한다.
   - queue
   - telegram
   - n8n
   - rag
2. `reporting-hub.js`의 기존 helper로 흡수 가능한지 본다.
3. notice 성격이면 `buildNoticeEvent`, report 성격이면 `buildReportEvent`, 브리핑이면 snippet 계열을 우선 검토한다.
4. payload를 표준 스키마로 맞춘다.
5. fanout은 severity 기반 공용 target 결정을 우선 사용한다.
6. consumer가 `payload.title`, `payload.summary`, `payload.details`를 실제로 읽는지 확인한다.
7. 변경 후 `REPORTING_INVENTORY.md`를 갱신한다.

## health 연동 절차

- payload validation warning이 생기면 `bots/orchestrator/scripts/reporting-health.js`와 `/reporting-health` 경로에서 바로 보여야 한다.
- 새 producer를 붙였으면 아래도 같이 점검한다.
  - `/reporting-health`
  - `/reporting-health summary`
  - `/reporting-health producers`
  - `/orchestrator-health`
  - 아침 브리핑 reporting snippet

## 자주 하는 작업

### 1. producer를 허브로 옮기기

- 기존 custom sender를 지우기 전에 현재 채널 조합을 기록한다.
- 허브 이관 후 같은 severity에서 채널이 줄거나 늘지 않는지 확인한다.

### 2. 서식 통일

- 제목은 한 줄로 짧게 유지한다.
- 요약은 핵심 수치/상태 1~2줄로 만든다.
- 상세는 `details[]`에 넣고, 액션은 `action` 또는 `links`로 분리한다.
- 영어 raw status나 `NaN`, `undefined`가 노출되지 않게 formatter 단계에서 막는다.

### 3. payload warning 줄이기

- warning이 나면 producer에서 타입과 키를 먼저 정리한다.
- 허브 자동 보정에 기대기보다 producer 자체를 수정한다.

## 검증 기본 세트

- 관련 JS 수정 후: `node --check <file>`
- reporting direct view 점검:
  - `node bots/orchestrator/scripts/reporting-health.js`
  - `node bots/orchestrator/scripts/reporting-health.js --summary`
  - `node bots/orchestrator/scripts/reporting-health.js --producers`
- consumer 확인이 필요하면 다음 파일도 함께 본다.
  - `bots/orchestrator/lib/batch-formatter.js`
  - `bots/orchestrator/src/filter.js`

## 마무리 체크

- producer가 shared payload schema를 쓰는가
- consumer가 structured payload를 실제로 쓰는가
- reporting health에서 warning이 새로 생기지 않는가
- inventory 문서가 최신인가

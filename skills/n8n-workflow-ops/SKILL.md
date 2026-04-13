---
name: n8n-workflow-ops
description: Use when creating, updating, reinstalling, or debugging n8n workflows in this repository, especially when workflows must be recreated safely, live webhook paths must be resolved from the registry, or health and setup scripts must be kept in sync.
---

# N8N Workflow Ops

이 스킬은 이 저장소에서 `n8n workflow`, `setup script`, `live webhook`, `healthz`, `registry path`, `workflow 재생성` 작업을 할 때 사용한다.

## 먼저 볼 파일

- `packages/core/lib/n8n-setup-client.js`
- `packages/core/lib/n8n-webhook-registry.js`
- `packages/core/lib/health-provider.js`

팀별 setup/diagnostic:

- Orchestrator: `bots/orchestrator/n8n/setup-n8n.js`, `bots/orchestrator/n8n/setup-ska-workflows.js`, `bots/orchestrator/scripts/check-n8n-critical-path.js`
- Worker: `bots/worker/n8n/setup-worker-workflows.js`, `bots/worker/scripts/check-n8n-intake-path.js`
- Blog: `bots/blog/n8n/setup-blog-workflows.js`, `bots/blog/scripts/check-n8n-pipeline-path.js`
- Ska command: `bots/reservation/n8n/setup-ska-command-workflow.ts`, `bots/reservation/scripts/check-n8n-command-path.ts`

## 기본 원칙

- workflow 수정 후에는 `기존 것이 있으면 스킵`하지 말고 안전하게 교체한다.
- 기본 흐름은 공용 setup client를 사용한다.
  - deactivate
  - archive
  - delete
  - recreate
  - activate
- production webhook 경로는 고정 문자열로 가정하지 말고 registry에서 확인한다.
- `healthz ok`와 `webhook registered`는 별개로 본다.
- 진단 스크립트, 헬스 리포트, setup 스크립트가 같은 경로 해석을 쓰도록 유지한다.

## 작업 절차

### 1. workflow 변경

1. 해당 팀의 setup script를 찾는다.
2. 공용 `n8n-setup-client.js`를 사용 중인지 확인한다.
3. 기존 workflow가 있으면 재생성 패턴을 따르는지 확인한다.
4. setup 후 live webhook 경로를 다시 점검한다.

### 2. webhook 문제 진단

아래 순서로 본다.

1. `healthz` 응답
2. workflow active 여부
3. `webhook_entity` 기반 production path 해석
4. resolved URL 실제 응답

`404 not registered`면 정적 `/webhook/foo`만 보지 말고 registry resolved URL을 먼저 확인한다.

### 3. 템플릿/알림 수정

- raw `{{ ... }}`나 `\n` 원문이 그대로 보이면 workflow 템플릿 표현식을 먼저 본다.
- DM/개인 chat id 하드코딩은 남기지 않는다.
- probe/health check 요청은 실제 장애 알림으로 fanout되지 않게 분기한다.

## 자주 하는 검증

- `node --check <setup-or-check-script>`
- orchestrator critical:
  - `node bots/orchestrator/scripts/check-n8n-critical-path.js`
- worker intake:
  - `node bots/worker/scripts/check-n8n-intake-path.js`
- blog pipeline:
  - `node bots/blog/scripts/check-n8n-pipeline-path.js`
- ska command:
  - `node dist/ts-runtime/bots/reservation/scripts/check-n8n-command-path.js`

## 흔한 함정

- workflow가 active여도 live webhook path가 정적 예상 경로와 다를 수 있다.
- setup script가 스킵 모드면 코드 수정이 n8n에 안 반영된다.
- 한글/공백 webhook 이름은 경로 문제를 만들 수 있으니 실제 production path를 다시 확인한다.
- health probe가 critical webhook으로 들어가면 실제 긴급 알림을 울릴 수 있다.

## 마무리 체크

- setup script가 공용 setup client를 쓰는가
- diagnostic/health가 resolved live URL 기준으로 보는가
- 개인 DM 또는 불필요한 채널이 남아 있지 않은가
- 템플릿 raw 값과 `NaN/undefined`가 외부로 노출되지 않는가

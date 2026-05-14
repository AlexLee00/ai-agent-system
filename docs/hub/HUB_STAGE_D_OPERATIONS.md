# Hub Stage D Operations

Stage D는 Hub를 production promotion 상태로 올리기 위한 운영 게이트다. 핵심 원칙은 `코드 준비 완료`와 `운영 인증 완료`를 분리하는 것이다.

## Safety Boundary

- PROTECTED 14 launchd는 Stage D 자동화가 restart, unload, bootout, kill 하지 않는다.
- Production DB restore는 별도 마스터 승인 없이는 금지한다.
- Live chaos는 기본 OFF이며 `--apply --confirm=hub-stage-d-live-chaos-1pct` 없이는 활성화하지 않는다.
- Sentry 전송은 `SENTRY_DSN`과 `HUB_SENTRY_CAPTURE_ENABLED=true`가 있을 때만 수행한다.
- 외부 프로젝트는 provider API key나 OAuth token을 보유하지 않고 Hub bearer token만 사용한다.

## Task Map

- D1 Blue-Green: `npm --prefix bots/hub run -s hub:bg-status`
- D2 Secrets Auto Rotate dry-run: `npm --prefix bots/hub run -s hub:secrets-monitor -- --dry-run --json`
- D2 Secrets Auto Rotate launchd/manual apply: `npm --prefix bots/hub run -s hub:secrets-monitor`
- D3 Self-Healing: `npm --prefix bots/hub run -s hub:stage-d-self-healing`
- D4 DRP Backup: `npm --prefix bots/hub run -s hub:stage-d-backup -- --plan --json`
- D4 Restore Drill: `npm --prefix bots/hub run -s hub:stage-d-restore-drill`
- D5 Live Chaos: `npm --prefix bots/hub run -s hub:stage-d-live-chaos`
- D6 Sentry: Hub error handler calls `captureHubError`; capture is disabled until env is set.
- D7 External Gateway: `npm --prefix bots/hub run -s llm:stage-d-external-gateway-canary`
- D8 Promotion Gate: `npm --prefix bots/hub run -s check:llm-stage-d`

## Promotion Evidence

`hub-stage-d-report` reports `productionCertified=false` until the following evidence is set and backed by operations data:

- `HUB_STAGE_D_SHADOW_DAYS >= 7`
- `HUB_STAGE_D_CANARY_PERCENT >= 1`
- `HUB_STAGE_D_UPTIME_99_9=true`
- `HUB_STAGE_D_LATENCY_LT_500MS=true`
- `HUB_STAGE_D_ERROR_RATE_LT_0_1=true`
- `HUB_STAGE_D_SELF_HEALING_GT_95=true`

This prevents accidental promotion labeling before the required Shadow/Canary window actually happened.

# Team Runtime Config Guide

## 목적

운영 중 자주 바뀌는 임계치, 재시도 횟수, 예측/리뷰 기준을 코드 수정 없이 팀별 설정 파일에서 관리하기 위한 가이드다.

## 현재 적용 팀

### Investment

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
- 적용 로더: [/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/shared/time-mode.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/time-mode.js)
- 운영에서 바꿀 수 있는 값 예:
  - `luna.minConfidence`
  - `luna.maxPosCount`
  - `luna.debateThresholds`
  - `nemesis.crypto / stockDomestic / stockOverseas`
  - `timeMode.ACTIVE / SLOWDOWN / NIGHT_AUTO`
  - `dynamicTpSlEnabled`

### Reservation

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/reservation/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/reservation/config.yaml)
- 적용 로더: [/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/runtime-config.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/runtime-config.ts)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/browser.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/browser.ts)
  - [/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.ts)
  - [/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts)
- 운영에서 바꿀 수 있는 값 예:
  - `browser.launchRetries`
  - `browser.launchRetryDelayMs`
  - `browser.navigationTimeoutMs`
  - `naverMonitor.maxRetries`
  - `naverMonitor.staleConfirmCount`
  - `naverMonitor.staleMinElapsedMs`
  - `kioskMonitor.errorTrackerThreshold`

### Ska

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/ska/config.json](/Users/alexlee/projects/ai-agent-system/bots/ska/config.json)
- 적용 로더:
  - Node: [/Users/alexlee/projects/ai-agent-system/bots/ska/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/runtime-config.js)
  - Python: [/Users/alexlee/projects/ai-agent-system/bots/ska/src/runtime_config.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/runtime_config.py)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
  - [/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py)
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)
- 운영에서 바꿀 수 있는 값 예:
  - `forecast.conditionAdjustmentWeight`
  - `forecast.sarimaPeriods`
  - `forecast.sarimaMaxIter`
  - `forecast.monthlyReviewGradeGood / Warn`
  - `rebecca.weeklyGradeGood / Warn`
  - `reviews.daily.*`
  - `reviews.weekly.*`

### Orchestrator

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
- 적용 로더: [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/runtime-config.js)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js)
- 운영에서 바꿀 수 있는 값 예:
  - `health.n8nHealthUrl`
  - `health.criticalWebhookUrl`
  - `health.httpTimeoutMs`
  - `health.webhookTimeoutMs`
  - `health.payloadWarningWithinHours`
  - `health.payloadWarningLimit`

### Claude / Dexter

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/claude/config.json](/Users/alexlee/projects/ai-agent-system/bots/claude/config.json)
- 적용 로더: [/Users/alexlee/projects/ai-agent-system/bots/claude/lib/config.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/config.js)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/resources.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/resources.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/patterns.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/patterns.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/n8n.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/n8n.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter-quickcheck.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter-quickcheck.js)
- 운영에서 바꿀 수 있는 값 예:
  - `thresholds.diskMinMB`
  - `thresholds.logMaxMB`
  - `thresholds.memMinFreeGB`
  - `patterns.patternDays`
  - `patterns.newErrorHours`
  - `patterns.errorThreshold / warnThreshold`
  - `n8n.healthUrl`
  - `n8n.criticalWebhookUrl`
  - `n8n.timeoutMs`
  - `quickcheck.alertCooldownMs`
  - `quickcheck.restartCooldownMs`
  - `quickcheck.maxRestarts`
  - `quickcheck.diskCriticalPercent`

### Blog

- 설정 파일: [/Users/alexlee/projects/ai-agent-system/bots/blog/config.json](/Users/alexlee/projects/ai-agent-system/bots/blog/config.json)
- 적용 로더: [/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.js)
- 적용 영역:
  - [/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-report.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-check.js](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-check.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/check-n8n-pipeline-path.js](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/check-n8n-pipeline-path.js)
- 운영에서 바꿀 수 있는 값 예:
  - `health.nodeServerHealthUrl`
  - `health.n8nHealthUrl`
  - `health.blogWebhookUrl`
  - `health.nodeServerTimeoutMs`
  - `health.n8nHealthTimeoutMs`
  - `health.webhookTimeoutMs`
  - `health.dailyLogStaleMs`
  - `generation.gemsMinChars`
  - `generation.posMinChars`
  - `generation.continueMaxTokens`
  - `generation.writerMaxRetries`
  - `generation.maestroWebhookTimeoutMs`
  - `generation.maestroHealthTimeoutMs`
  - `generation.maestroCircuitCooldownMs`

## 조회 방법

현재 팀별 운영 설정을 한 번에 확인:

```bash
node /Users/alexlee/projects/ai-agent-system/scripts/show-runtime-configs.js
```

## 운영 원칙

- 비밀값은 기존 `secrets.json`, `config.yaml`의 credential 영역에 둔다.
- 운영 중 자주 조정하는 값은 `runtime_config` 또는 `config.json`으로 뺀다.
- 새 팀에 같은 패턴을 적용할 때는 먼저:
  1. 운영 중 자주 바뀌는 숫자/임계치
  2. 재시도/타임아웃
  3. 리뷰 기준값
  순서로 옮긴다.

## 다음 후보

- `worker web UI retry/toast timings`
- `blog cache key / generation policy 상세 외부화`

이 팀들도 같은 패턴으로 점진적으로 옮길 수 있다.

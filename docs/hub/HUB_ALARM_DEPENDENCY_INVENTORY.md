# Hub Alarm Dependency Inventory

This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `legacy_gateway_compat` entries are compatibility shims or remaining migration targets.

- generated_at: 2026-04-27T01:54:24.024Z
- total_matches: 145
- unique_files: 94
- hub_alarm_native: 145
- legacy_gateway_compat: 0

## Files

### `README.md`
- L121 [hub_alarm_native]: `│       ├── hub-alarm-client.js   # Hub-routed Telegram alerts & Standing Orders`

### `bots/blog/__tests__/dpo-learning.test.ts`
- L18 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/dpo-self-rewarding.test.ts`
- L20 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/e2e/full-cycle.test.ts`
- L26 [hub_alarm_native]: `jest.mock('../../../../packages/core/lib/hub-alarm-client', () => ({`
- L36 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/__tests__/evolution-cycle.test.ts`
- L20 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/load/stress.test.ts`
- L26 [hub_alarm_native]: `jest.mock('../../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/omnichannel-campaign-planner.test.ts`
- L19 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/phase1-publish-reporter.test.ts`
- L18 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`
- L22 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/__tests__/phase6-self-rewarding.test.ts`
- L17 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/platform-orchestration.test.ts`
- L17 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/revenue-attribution.test.ts`
- L21 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/self-rewarding-rag.test.ts`
- L17 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/__tests__/signal-collectors.test.ts`
- L17 [hub_alarm_native]: `jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({`

### `bots/blog/lib/ab-testing.ts`
- L11 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/blo.ts`
- L95 [hub_alarm_native]: `const { postAlarm }                                 = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/commenter.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/curriculum-planner.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/evolution-cycle.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/img-gen-doctor.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/insta-crosspost.ts`
- L23 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/instagram-story.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/platform-orchestrator.ts`
- L16 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/publish-reporter.ts`
- L11 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/self-rewarding/marketing-dpo.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/signals/brand-mention-collector.ts`
- L11 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/lib/signals/competitor-monitor.ts`
- L12 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/scripts/auto-facebook-publish.ts`
- L23 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/scripts/auto-instagram-publish.ts`
- L31 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/blog/scripts/compute-attribution.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/__tests__/auto-dev-pipeline.test.ts`
- L77 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/__tests__/builder.test.ts`
- L21 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`
- L145 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/__tests__/codex-plan-notifier.test.ts`
- L39 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`
- L204 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/__tests__/commander.test.ts`
- L53 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/__tests__/e2e/full-flow.test.ts`
- L21 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': { postAlarm: async () => {} },`
- L22 [hub_alarm_native]: `'../../../../packages/core/lib/hub-alarm-client': { postAlarm: async () => {} },`
- L176 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': { postAlarm: async () => {} },`

### `bots/claude/__tests__/guardian.test.ts`
- L19 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`
- L194 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/__tests__/reviewer.test.ts`
- L26 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`
- L176 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

### `bots/claude/lib/auto-dev-pipeline.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/autofix.ts`
- L28 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/codex-plan-notifier.ts`
- L26 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/doctor.ts`
- L594 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`
- L904 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/mainbot-client.ts`
- L12 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/reporter.ts`
- L11 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/telegram-reporter.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/builder.ts`
- L25 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/guardian.ts`
- L28 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/quality-report.ts`
- L6 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/reviewer.ts`
- L25 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/tsconfig.json`
- L35 [hub_alarm_native]: `"../../packages/core/lib/hub-alarm-client.js",`

### `bots/darwin/__tests__/research-monitor-smoke.test.ts`
- L31 [hub_alarm_native]: `if (request === '../../../packages/core/lib/hub-alarm-client') {`

### `bots/darwin/__tests__/research-task-runner-smoke.test.ts`
- L27 [hub_alarm_native]: `if (request === '../../../packages/core/lib/hub-alarm-client') {`

### `bots/darwin/lib/applicator.ts`
- L95 [hub_alarm_native]: `const { postAlarm }: { postAlarm: (payload: AlarmPayload) => Promise<{ ok?: boolean } | null> } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/lib/event-reminders.ts`
- L8 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/lib/implementor.ts`
- L12 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/lib/research-monitor.ts`
- L65 [hub_alarm_native]: `const { postAlarm }: { postAlarm: (payload: AlarmPayload) => Promise<unknown> } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/lib/research-scanner.ts`
- L26 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/lib/verifier.ts`
- L12 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/darwin/scripts/darwin-weekly-ops-report.ts`
- L15 [hub_alarm_native]: `const { postAlarm } = require(path.join(PROJECT_ROOT, "packages/core/lib/hub-alarm-client"));`

### `bots/darwin/scripts/darwin-weekly-review.ts`
- L15 [hub_alarm_native]: `const { postAlarm } = require(path.join(PROJECT_ROOT, "packages/core/lib/hub-alarm-client"));`

### `bots/darwin/scripts/research-task-runner.ts`
- L4 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/lib/routes/alarm.ts`
- L229 [hub_alarm_native]: `const claimLeaseMinutes = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_CLAIM_LEASE_MINUTES || 15) || 15);`

### `bots/hub/scripts/alarm-digest-worker.ts`
- L8 [hub_alarm_native]: `const value = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_INTERVAL_MINUTES || 10) || 10);`
- L13 [hub_alarm_native]: `return Math.max(5, Number(process.env.HUB_ALARM_DIGEST_WINDOW_MINUTES || 240) || 240);`
- L17 [hub_alarm_native]: `return Math.min(1000, Math.max(10, Number(process.env.HUB_ALARM_DIGEST_LIMIT || 300) || 300));`

### `bots/hub/scripts/generate-hub-alarm-inventory.ts`
- L8 [hub_alarm_native]: `const outputMarkdownPath = path.join(projectRoot, 'docs', 'hub', 'HUB_ALARM_DEPENDENCY_INVENTORY.md');`
- L13 [hub_alarm_native]: `'hub-alarm-client',`
- L15 [hub_alarm_native]: `'HUB_ALARM_',`
- L20 [hub_alarm_native]: `if (match.includes('hub-alarm-client') || match.includes('HUB_ALARM_')) return 'hub_alarm_native';`
- L40 [hub_alarm_native]: `'!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',`

### `bots/hub/scripts/hub-alarm-delivery-acceptance-smoke.ts`
- L1 [hub_alarm_native]: `const { _testOnly_isHubAlarmDeliveryAccepted } = require('../../../packages/core/lib/hub-alarm-client.ts');`

### `bots/hub/scripts/hub-alarm-env-smoke.ts`
- L1 [hub_alarm_native]: `const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L26 [hub_alarm_native]: `HUB_ALARM_LEGACY_WEBHOOK_FALLBACK: 'true',`
- L35 [hub_alarm_native]: `HUB_ALARM_LEGACY_WEBHOOK_FALLBACK: null,`

### `bots/hub/scripts/hub-alarm-no-legacy-shim-smoke.ts`
- L20 [hub_alarm_native]: `const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L21 [hub_alarm_native]: `assert(typeof hubAlarmClient.postAlarm === 'function', 'expected hub-alarm-client postAlarm export');`
- L24 [hub_alarm_native]: `'expected delivery acceptance helper to be exported by hub-alarm-client',`

### `bots/hub/scripts/hub-postalarm-no-legacy-fallback-smoke.ts`
- L5 [hub_alarm_native]: `const CLIENT_PATH = require.resolve('../../../packages/core/lib/hub-alarm-client.ts');`
- L18 [hub_alarm_native]: `process.env.HUB_ALARM_RECENT_ALERTS_PATH = path.join(tempWorkspace, 'recent-alerts.json');`
- L21 [hub_alarm_native]: `process.env.HUB_ALARM_SKIP_DIRECT = 'false';`
- L23 [hub_alarm_native]: `delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;`
- L24 [hub_alarm_native]: `delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;`
- L48 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L65 [hub_alarm_native]: `process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = 'true';`
- L66 [hub_alarm_native]: `process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = 'smoke-hooks-token';`
- L93 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L132 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L149 [hub_alarm_native]: `const originalHubRecentAlertsPath = process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L150 [hub_alarm_native]: `const originalHubLegacyHooksToken = process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;`
- L151 [hub_alarm_native]: `const originalHubSkipDirect = process.env.HUB_ALARM_SKIP_DIRECT;`
- L152 [hub_alarm_native]: `const originalHubLegacyFallback = process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;`
- L161 [hub_alarm_native]: `if (originalHubRecentAlertsPath == null) delete process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L162 [hub_alarm_native]: `else process.env.HUB_ALARM_RECENT_ALERTS_PATH = originalHubRecentAlertsPath;`
- L163 [hub_alarm_native]: `if (originalHubLegacyHooksToken == null) delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;`
- L164 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = originalHubLegacyHooksToken;`
- L165 [hub_alarm_native]: `if (originalHubSkipDirect == null) delete process.env.HUB_ALARM_SKIP_DIRECT;`
- L166 [hub_alarm_native]: `else process.env.HUB_ALARM_SKIP_DIRECT = originalHubSkipDirect;`
- L167 [hub_alarm_native]: `if (originalHubLegacyFallback == null) delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;`
- L168 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = originalHubLegacyFallback;`

### `bots/hub/scripts/run-oauth-monitor.ts`
- L18 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`

### `bots/orchestrator/lib/steward/daily-summary.ts`
- L4 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/src/dashboard.ts`
- L11 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client') as {`

### `bots/orchestrator/src/router.ts`
- L105 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/src/steward.ts`
- L15 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/reservation/tsconfig.json`
- L23 [hub_alarm_native]: `"../../packages/core/lib/hub-alarm-client.ts",`

### `bots/sigma/ts/src/sigma-daily-report.ts`
- L19 [hub_alarm_native]: `const hubAlarm = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `bots/sigma/ts/src/sigma-weekly-review.ts`
- L22 [hub_alarm_native]: `const hubAlarm = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `bots/worker/lib/approval.ts`
- L17 [hub_alarm_native]: `const { postAlarm } = require(path.join(__dirname, '../../../packages/core/lib/hub-alarm-client'));`

### `docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md`
- L106 [hub_alarm_native]: `- `hub-alarm-client`가 retired webhook보다 우선되는 구조로 이동했다.`
- L541 [hub_alarm_native]: `- legacy alarm shim import를 `hub-alarm-client`로 팀별 이관한다.`
- L625 [hub_alarm_native]: `- `readRecentAlertSnapshot` import를 `hub-alarm-client`로 변경.`

### `packages/core/REPORTING_HUB_PLAN.md`
- L84 [hub_alarm_native]: `- canonical transport 자체 (`hub-alarm-client.ts`, `reporting-hub.ts`)`

### `packages/core/REPORTING_INVENTORY.md`
- L126 [hub_alarm_native]: `5. canonical transport (`hub-alarm-client.ts`, `reporting-hub.ts`) 바깥 non-blog current delivery는 사실상 1차 정리 완료 상태로 유지`

### `packages/core/lib/hub-alarm-client.js`
- L5 [hub_alarm_native]: `module.exports = loadTsSourceBridge(__dirname, 'hub-alarm-client');`

### `packages/core/lib/hub-alarm-client.ts`
- L2 [hub_alarm_native]: `* packages/core/lib/hub-alarm-client.js — Hub alarm 클라이언트`
- L14 [hub_alarm_native]: `const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 5000) || 5000);`
- L17 [hub_alarm_native]: `const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()`
- L267 [hub_alarm_native]: `signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),`
- L306 [hub_alarm_native]: `console.warn(`[hub-alarm-client] recent alert snapshot 저장 실패: ${(error as Error).message}`);`
- L339 [hub_alarm_native]: `console.warn('[hub-alarm-client] inline telegram 발송 실패: bot token/group id 미설정');`
- L368 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 429 — ${delayMs}ms 후 재시도`);`
- L379 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 실패: ${error.message}`);`
- L415 [hub_alarm_native]: `const hubDirectBlocked = _readBooleanEnv('HUB_ALARM_SKIP_DIRECT');`
- L437 [hub_alarm_native]: `console.warn(`[hub-alarm-client] hub alarm failed: ${hubResult.error}`);`

### `packages/core/lib/reporting-hub.ts`
- L3 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`

### `packages/core/lib/telegram-sender.ts`
- L31 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`

### `packages/core/scripts/publish-python-report.ts`
- L12 [hub_alarm_native]: `const { postAlarm } = require('../lib/hub-alarm-client');`

### `scripts/api-usage-report.ts`
- L30 [hub_alarm_native]: `const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');`

### `scripts/build-reservation-runtime.mjs`
- L16 [hub_alarm_native]: `'packages/core/lib/hub-alarm-client.js',`

### `scripts/build-ts-phase1.mjs`
- L57 [hub_alarm_native]: `path.join(root, 'packages/core/lib/hub-alarm-client.ts'),`

### `scripts/collect-kpi.ts`
- L16 [hub_alarm_native]: `const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));`

### `scripts/luna-transition-analysis.ts`
- L18 [hub_alarm_native]: `const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));`

### `scripts/run-graduation-analysis.ts`
- L18 [hub_alarm_native]: `const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));`

### `scripts/speed-test.ts`
- L42 [hub_alarm_native]: `const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');`

### `scripts/stability-dashboard.ts`
- L243 [hub_alarm_native]: `const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');`

### `scripts/weekly-stability-report.ts`
- L17 [hub_alarm_native]: `const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));`

### `scripts/weekly-team-report.ts`
- L15 [hub_alarm_native]: `const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');`

### `tsconfig.json`
- L20 [hub_alarm_native]: `"packages/core/lib/hub-alarm-client.js",`

# Hub Alarm Dependency Inventory

This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `legacy_openclaw_compat` entries are compatibility shims or remaining migration targets.

- generated_at: 2026-04-26T11:17:51.217Z
- total_matches: 268
- unique_files: 122
- hub_alarm_native: 113
- legacy_openclaw_compat: 155

## Files

### `README.md`
- L121 [legacy_openclaw_compat]: `│       ├── openclaw-client.js    # Telegram alerts & Standing Orders`

### `bots/blog/__tests__/dpo-learning.test.ts`
- L18 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/dpo-self-rewarding.test.ts`
- L20 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/e2e/full-cycle.test.ts`
- L26 [legacy_openclaw_compat]: `jest.mock('../../../../packages/core/lib/openclaw-client', () => ({`
- L36 [legacy_openclaw_compat]: `const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');`

### `bots/blog/__tests__/evolution-cycle.test.ts`
- L20 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/load/stress.test.ts`
- L26 [legacy_openclaw_compat]: `jest.mock('../../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/omnichannel-campaign-planner.test.ts`
- L19 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/phase1-publish-reporter.test.ts`
- L18 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`
- L22 [legacy_openclaw_compat]: `const { postAlarm } = require('../../../packages/core/lib/openclaw-client');`

### `bots/blog/__tests__/phase6-self-rewarding.test.ts`
- L17 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/platform-orchestration.test.ts`
- L17 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/revenue-attribution.test.ts`
- L21 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/self-rewarding-rag.test.ts`
- L17 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

### `bots/blog/__tests__/signal-collectors.test.ts`
- L17 [legacy_openclaw_compat]: `jest.mock('../../../packages/core/lib/openclaw-client', () => ({`

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
- L77 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/__tests__/builder.test.ts`
- L21 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`
- L145 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/__tests__/codex-plan-notifier.test.ts`
- L39 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`
- L204 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/__tests__/commander.test.ts`
- L53 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/__tests__/e2e/full-flow.test.ts`
- L21 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },`
- L22 [legacy_openclaw_compat]: `'../../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },`
- L176 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },`

### `bots/claude/__tests__/guardian.test.ts`
- L19 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`
- L194 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/__tests__/reviewer.test.ts`
- L26 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`
- L176 [legacy_openclaw_compat]: `'../../../packages/core/lib/openclaw-client': {`

### `bots/claude/lib/auto-dev-pipeline.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/autofix.ts`
- L28 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/lib/checks/openclaw.ts`
- L31 [legacy_openclaw_compat]: `const { LAUNCHD_AVAILABLE, OPENCLAW_PORT: ENV_OPENCLAW_PORT } = require('../../../../packages/core/lib/env');`
- L33 [legacy_openclaw_compat]: `const OPENCLAW_SERVICE = 'ai.openclaw.gateway';`
- L34 [legacy_openclaw_compat]: `const OPENCLAW_PORT    = ENV_OPENCLAW_PORT > 0 ? ENV_OPENCLAW_PORT : 18789;`
- L166 [legacy_openclaw_compat]: `const launchd = getLaunchdStatus(OPENCLAW_SERVICE);`
- L189 [legacy_openclaw_compat]: `const portInfo = getPortBindingInfo(OPENCLAW_PORT);`
- L193 [legacy_openclaw_compat]: `label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,`
- L199 [legacy_openclaw_compat]: `label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,`
- L205 [legacy_openclaw_compat]: `label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,`
- L254 [legacy_openclaw_compat]: `_restartService: OPENCLAW_SERVICE,`

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
- L35 [legacy_openclaw_compat]: `"../../packages/core/lib/openclaw-client.js",`

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

### `bots/hub/lib/routes/services.ts`
- L169 [legacy_openclaw_compat]: `openclaw_port: env.OPENCLAW_PORT,`

### `bots/hub/scripts/alarm-digest-worker.ts`
- L8 [hub_alarm_native]: `const value = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_INTERVAL_MINUTES || 10) || 10);`
- L13 [hub_alarm_native]: `return Math.max(5, Number(process.env.HUB_ALARM_DIGEST_WINDOW_MINUTES || 240) || 240);`
- L17 [hub_alarm_native]: `return Math.min(1000, Math.max(10, Number(process.env.HUB_ALARM_DIGEST_LIMIT || 300) || 300));`

### `bots/hub/scripts/claude-code-oauth-direct-smoke.ts`
- L22 [legacy_openclaw_compat]: `openclawAgent: process.env.OPENCLAW_AGENT || null`

### `bots/hub/scripts/generate-hub-alarm-inventory.ts`
- L8 [hub_alarm_native]: `const outputMarkdownPath = path.join(projectRoot, 'docs', 'hub', 'HUB_ALARM_DEPENDENCY_INVENTORY.md');`
- L11 [hub_alarm_native]: `'hub-alarm-client',`
- L12 [legacy_openclaw_compat]: `'openclaw-client',`
- L13 [hub_alarm_native]: `'HUB_ALARM_',`
- L14 [legacy_openclaw_compat]: `'OPENCLAW_',`
- L18 [hub_alarm_native]: `if (match.includes('hub-alarm-client') || match.includes('HUB_ALARM_')) return 'hub_alarm_native';`
- L19 [legacy_openclaw_compat]: `if (match.includes('openclaw-client') || match.includes('OPENCLAW_')) return 'legacy_openclaw_compat';`
- L38 [hub_alarm_native]: `'!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',`
- L40 [legacy_openclaw_compat]: `'!docs/hub/OPENCLAW_CLIENT_INVENTORY.md',`

### `bots/hub/scripts/hub-alarm-client-shim-smoke.ts`
- L1 [hub_alarm_native]: `const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L2 [legacy_openclaw_compat]: `const openClawShim = require('../../../packages/core/lib/openclaw-client.ts');`
- L9 [hub_alarm_native]: `assert(typeof hubAlarmClient.postAlarm === 'function', 'expected hub-alarm-client postAlarm export');`
- L10 [legacy_openclaw_compat]: `assert(typeof openClawShim.postAlarm === 'function', 'expected openclaw-client shim postAlarm export');`
- L11 [legacy_openclaw_compat]: `assert(openClawShim.postAlarm === hubAlarmClient.postAlarm, 'expected openclaw-client shim to re-export hub implementation');`

### `bots/hub/scripts/hub-alarm-env-smoke.ts`
- L1 [hub_alarm_native]: `const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L26 [hub_alarm_native]: `HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: 'true',`
- L27 [legacy_openclaw_compat]: `OPENCLAW_LEGACY_FALLBACK: null,`
- L31 [hub_alarm_native]: `'expected HUB_ALARM_LEGACY_OPENCLAW_FALLBACK=true to enable fallback',`
- L36 [hub_alarm_native]: `HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: null,`
- L37 [legacy_openclaw_compat]: `OPENCLAW_LEGACY_FALLBACK: 'true',`
- L41 [legacy_openclaw_compat]: `'expected legacy OPENCLAW_LEGACY_FALLBACK=true to remain compatible',`
- L46 [hub_alarm_native]: `HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: null,`
- L47 [legacy_openclaw_compat]: `OPENCLAW_LEGACY_FALLBACK: null,`

### `bots/hub/scripts/hub-alarm-import-transition-smoke.ts`
- L49 [legacy_openclaw_compat]: `'openclaw-client',`
- L60 [legacy_openclaw_compat]: `'migrated Hub alarm scopes must not import openclaw-client directly',`

### `bots/hub/scripts/l5-acceptance-smoke.ts`
- L37 [hub_alarm_native]: `HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK,`
- L38 [legacy_openclaw_compat]: `OPENCLAW_LEGACY_FALLBACK: process.env.OPENCLAW_LEGACY_FALLBACK,`
- L39 [legacy_openclaw_compat]: `OPENCLAW_PORT: process.env.OPENCLAW_PORT,`
- L53 [hub_alarm_native]: `process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK = 'false';`
- L54 [legacy_openclaw_compat]: `process.env.OPENCLAW_LEGACY_FALLBACK = 'false';`
- L55 [legacy_openclaw_compat]: `process.env.OPENCLAW_PORT = '18789';`

### `bots/hub/scripts/openclaw-hub-alarm-smoke.ts`
- L1 [hub_alarm_native]: `const { _testOnly_isHubAlarmDeliveryAccepted } = require('../../../packages/core/lib/hub-alarm-client.ts');`

### `bots/hub/scripts/openclaw-independence-smoke.ts`
- L5 [legacy_openclaw_compat]: `const OPENCLAW_GATEWAY_LABEL = 'ai.openclaw.gateway';`
- L11 [legacy_openclaw_compat]: `const gateway = ownership.getServiceOwnership(OPENCLAW_GATEWAY_LABEL);`
- L14 [legacy_openclaw_compat]: `assert(!coreLabels.includes(OPENCLAW_GATEWAY_LABEL), 'OpenClaw gateway must not be a Hub core service');`
- L15 [legacy_openclaw_compat]: `assert(!hubLabels.includes(OPENCLAW_GATEWAY_LABEL), 'OpenClaw gateway must not be part of Hub service readiness labels');`

### `bots/hub/scripts/openclaw-postalarm-fallback-smoke.ts`
- L6 [hub_alarm_native]: `const CLIENT_PATH = require.resolve('../../../packages/core/lib/hub-alarm-client.ts');`
- L17 [hub_alarm_native]: `process.env.HUB_ALARM_RECENT_ALERTS_PATH = path.join(tempWorkspace, 'recent-alerts.json');`
- L18 [hub_alarm_native]: `process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN = 'smoke-hooks-token';`
- L21 [hub_alarm_native]: `process.env.HUB_ALARM_SKIP_DIRECT = 'false';`
- L23 [legacy_openclaw_compat]: `delete process.env.OPENCLAW_WORKSPACE;`
- L24 [legacy_openclaw_compat]: `delete process.env.OPENCLAW_HOOKS_TOKEN;`
- L25 [legacy_openclaw_compat]: `delete process.env.OPENCLAW_CLIENT_SKIP_HUB_ALARM;`
- L26 [legacy_openclaw_compat]: `delete process.env.OPENCLAW_LEGACY_FALLBACK;`
- L50 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L67 [hub_alarm_native]: `process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK = 'true';`
- L101 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L144 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L161 [hub_alarm_native]: `const originalHubRecentAlertsPath = process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L162 [hub_alarm_native]: `const originalHubLegacyHooksToken = process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN;`
- L163 [hub_alarm_native]: `const originalHubSkipDirect = process.env.HUB_ALARM_SKIP_DIRECT;`
- L164 [hub_alarm_native]: `const originalHubLegacyFallback = process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK;`
- L165 [legacy_openclaw_compat]: `const originalOpenClawWorkspace = process.env.OPENCLAW_WORKSPACE;`
- L166 [legacy_openclaw_compat]: `const originalOpenClawHooksToken = process.env.OPENCLAW_HOOKS_TOKEN;`
- L167 [legacy_openclaw_compat]: `const originalOpenClawSkipHubAlarm = process.env.OPENCLAW_CLIENT_SKIP_HUB_ALARM;`
- L168 [legacy_openclaw_compat]: `const originalLegacyFallback = process.env.OPENCLAW_LEGACY_FALLBACK;`
- L177 [hub_alarm_native]: `if (originalHubRecentAlertsPath == null) delete process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L178 [hub_alarm_native]: `else process.env.HUB_ALARM_RECENT_ALERTS_PATH = originalHubRecentAlertsPath;`
- L179 [hub_alarm_native]: `if (originalHubLegacyHooksToken == null) delete process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN;`
- L180 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN = originalHubLegacyHooksToken;`
- L181 [hub_alarm_native]: `if (originalHubSkipDirect == null) delete process.env.HUB_ALARM_SKIP_DIRECT;`
- L182 [hub_alarm_native]: `else process.env.HUB_ALARM_SKIP_DIRECT = originalHubSkipDirect;`
- L183 [hub_alarm_native]: `if (originalHubLegacyFallback == null) delete process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK;`
- L184 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK = originalHubLegacyFallback;`
- L185 [legacy_openclaw_compat]: `if (originalOpenClawWorkspace == null) delete process.env.OPENCLAW_WORKSPACE;`
- L186 [legacy_openclaw_compat]: `else process.env.OPENCLAW_WORKSPACE = originalOpenClawWorkspace;`
- L187 [legacy_openclaw_compat]: `if (originalOpenClawHooksToken == null) delete process.env.OPENCLAW_HOOKS_TOKEN;`
- L188 [legacy_openclaw_compat]: `else process.env.OPENCLAW_HOOKS_TOKEN = originalOpenClawHooksToken;`
- L189 [legacy_openclaw_compat]: `if (originalOpenClawSkipHubAlarm == null) delete process.env.OPENCLAW_CLIENT_SKIP_HUB_ALARM;`
- L190 [legacy_openclaw_compat]: `else process.env.OPENCLAW_CLIENT_SKIP_HUB_ALARM = originalOpenClawSkipHubAlarm;`
- L191 [legacy_openclaw_compat]: `if (originalLegacyFallback == null) delete process.env.OPENCLAW_LEGACY_FALLBACK;`
- L192 [legacy_openclaw_compat]: `else process.env.OPENCLAW_LEGACY_FALLBACK = originalLegacyFallback;`

### `bots/hub/scripts/run-tests.js`
- L45 [hub_alarm_native]: `const alarmShimStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-client-shim-smoke.ts')]);`

### `bots/hub/scripts/runtime-workspace-independence-smoke.ts`
- L66 [legacy_openclaw_compat]: `OPENCLAW_WORKSPACE: null,`
- L69 [legacy_openclaw_compat]: `OPENCLAW_LOGS: null,`
- L81 [legacy_openclaw_compat]: `assert.equal(env.OPENCLAW_WORKSPACE, expectedWorkspace);`
- L98 [legacy_openclaw_compat]: `OPENCLAW_WORKSPACE: legacyWorkspace,`
- L102 [legacy_openclaw_compat]: `assert.equal(env.OPENCLAW_WORKSPACE, legacyWorkspace);`

### `bots/hub/scripts/telegram-pending-queue-migration-smoke.ts`
- L66 [legacy_openclaw_compat]: `OPENCLAW_WORKSPACE: legacyWorkspace,`

### `bots/hub/scripts/telegram-routing-readiness-report.ts`
- L152 [legacy_openclaw_compat]: `const legacyWorkspace = String(process.env.OPENCLAW_WORKSPACE || '').trim();`

### `bots/investment/scripts/pre-market-screen.ts`
- L34 [legacy_openclaw_compat]: `const OPENCLAW_DIR = join(homedir(), '.openclaw');`
- L37 [legacy_openclaw_compat]: `domestic: join(OPENCLAW_DIR, 'domestic-prescreened.json'),`
- L38 [legacy_openclaw_compat]: `overseas: join(OPENCLAW_DIR, 'overseas-prescreened.json'),`
- L39 [legacy_openclaw_compat]: `crypto:   join(OPENCLAW_DIR, 'crypto-prescreened.json'),`
- L155 [legacy_openclaw_compat]: `mkdirSync(OPENCLAW_DIR, { recursive: true });`

### `bots/orchestrator/lib/steward/daily-summary.ts`
- L4 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/src/dashboard.ts`
- L11 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client') as {`

### `bots/orchestrator/src/router.ts`
- L106 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/src/steward.ts`
- L16 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/reservation/context/ALERT_REPORT_CLEANUP_PLAN.md`
- L30 [legacy_openclaw_compat]: `- `packages/core/lib/openclaw-client*``

### `bots/reservation/src/bug-report.ts`
- L37 [legacy_openclaw_compat]: `const WORKSPACE    = process.env.OPENCLAW_WORKSPACE`

### `bots/reservation/tsconfig.json`
- L23 [legacy_openclaw_compat]: `"../../packages/core/lib/openclaw-client.ts",`

### `bots/sigma/docs/RESEARCH_V1.md`
- L30 [legacy_openclaw_compat]: `3. **Hermes에 `hermes claw migrate` 기능** — OpenClaw → Hermes 이주 공식 지원. **기존 `packages/core/lib/openclaw-client.*` 향후 Hermes 전환 경로 가능**. 단, 본 리모델링 범위는 아님 (시그마팀은 OpenClaw 경유 알림만 사용).`

### `bots/sigma/ts/src/sigma-daily-report.ts`
- L19 [hub_alarm_native]: `const openclaw = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `bots/sigma/ts/src/sigma-weekly-review.ts`
- L22 [hub_alarm_native]: `const openclaw = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `bots/worker/lib/approval.ts`
- L17 [hub_alarm_native]: `const { postAlarm } = require(path.join(__dirname, '../../../packages/core/lib/hub-alarm-client'));`

### `docs/SESSION_HANDOFF_2026-04-17.md`
- L2886 [legacy_openclaw_compat]: `- 토큰 우선순위 체인: runtime → env(OPENCLAW_BROWSER_TOKEN/GATEWAY_TOKEN) → config 파일`

### `docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md`
- L32 [legacy_openclaw_compat]: `1. **OpenClaw 분리**: `openclaw-client`, `.openclaw/workspace`, port `18789`, OpenClaw auth profile store는 모두 compatibility layer로 낮춘다.`
- L106 [hub_alarm_native]: `- `hub-alarm-client`가 OpenClaw webhook보다 우선되는 구조로 이동했다.`
- L118 [legacy_openclaw_compat]: `- `packages/core/lib/openclaw-client.ts`: 현재는 shim이지만 여전히 많은 팀 import가 남아 있다.`
- L119 [legacy_openclaw_compat]: `- `packages/core/lib/openclaw-client.legacy.js`: legacy loader.`
- L541 [hub_alarm_native]: `- `openclaw-client` import를 `hub-alarm-client`로 팀별 이관한다.`
- L542 [legacy_openclaw_compat]: `- `OPENCLAW_*` env는 `HUB_*` 이름을 우선하고 legacy fallback으로만 유지한다.`
- L589 [legacy_openclaw_compat]: `- `openclaw-client` shim은 compile-time compatibility만 남기고 network fallback은 기본 비활성화한다.`
- L590 [legacy_openclaw_compat]: `- `OPENCLAW_*` env fallback은 migration window 이후 제거한다.`
- L625 [hub_alarm_native]: `- `readRecentAlertSnapshot` import를 `hub-alarm-client`로 변경.`

### `docs/design/DESIGN_TEAM_RUNTIME_SELECTOR.md`
- L20 [legacy_openclaw_compat]: `OPENCLAW_AGENT`
- L216 [legacy_openclaw_compat]: `process.env.OPENCLAW_AGENT`

### `packages/core/REPORTING_HUB_PLAN.md`
- L84 [legacy_openclaw_compat]: `- canonical transport 자체 (`openclaw-client.ts`, `reporting-hub.ts`)`

### `packages/core/REPORTING_INVENTORY.md`
- L126 [legacy_openclaw_compat]: `5. canonical transport (`openclaw-client.ts`, `reporting-hub.ts`) 바깥 non-blog current delivery는 사실상 1차 정리 완료 상태로 유지`

### `packages/core/lib/env.ts`
- L138 [legacy_openclaw_compat]: `export const OPENCLAW_PORT = IS_OPS`
- L139 [legacy_openclaw_compat]: `? parseInt(process.env.OPENCLAW_PORT || '18789', 10)`
- L148 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`
- L153 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_LOGS`
- L157 [legacy_openclaw_compat]: `export const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || AI_AGENT_WORKSPACE;`
- L158 [legacy_openclaw_compat]: `export const OPENCLAW_LOGS = process.env.OPENCLAW_LOGS || AI_AGENT_LOGS;`

### `packages/core/lib/health-state-manager.ts`
- L13 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`

### `packages/core/lib/hub-alarm-client.js`
- L5 [hub_alarm_native]: `module.exports = loadTsSourceBridge(__dirname, 'hub-alarm-client');`

### `packages/core/lib/hub-alarm-client.ts`
- L2 [hub_alarm_native]: `* packages/core/lib/hub-alarm-client.js — Hub alarm 클라이언트`
- L5 [hub_alarm_native]: `* legacy OpenClaw webhook은 HUB_ALARM_LEGACY_OPENCLAW_FALLBACK=true일 때만 사용한다.`
- L16 [hub_alarm_native]: `const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 5000) || 5000);`
- L19 [hub_alarm_native]: `const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()`
- L20 [legacy_openclaw_compat]: `|| path.join(env.AI_AGENT_WORKSPACE || env.OPENCLAW_WORKSPACE, 'recent-alerts.json');`
- L166 [hub_alarm_native]: `|| process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN`
- L167 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_HOOKS_TOKEN`
- L287 [hub_alarm_native]: `return _readBooleanEnv('HUB_ALARM_LEGACY_OPENCLAW_FALLBACK', 'OPENCLAW_LEGACY_FALLBACK');`
- L324 [hub_alarm_native]: `signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),`
- L363 [hub_alarm_native]: `console.warn(`[hub-alarm-client] recent alert snapshot 저장 실패: ${(error as Error).message}`);`
- L396 [hub_alarm_native]: `console.warn('[hub-alarm-client] inline telegram 발송 실패: bot token/group id 미설정');`
- L425 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 429 — ${delayMs}ms 후 재시도`);`
- L436 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 실패: ${error.message}`);`
- L476 [hub_alarm_native]: `const hubDirectBlocked = _readBooleanEnv('HUB_ALARM_SKIP_DIRECT', 'OPENCLAW_CLIENT_SKIP_HUB_ALARM');`
- L491 [hub_alarm_native]: `console.warn(`[hub-alarm-client] hub alarm failed (legacy OpenClaw fallback disabled): ${hubResult.error}`);`
- L499 [hub_alarm_native]: `console.warn(`[hub-alarm-client] hub alarm legacy fallback: ${hubResult.error}`);`
- L514 [hub_alarm_native]: `console.warn('[hub-alarm-client] hooks_token 미설정');`
- L548 [hub_alarm_native]: `console.warn(`[hub-alarm-client] legacy webhook 실패: ${error.message}`);`
- L551 [hub_alarm_native]: `console.warn('[hub-alarm-client] legacy webhook curl 폴백 성공');`

### `packages/core/lib/intent-store.ts`
- L41 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`

### `packages/core/lib/llm-control/snapshot.ts`
- L12 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`

### `packages/core/lib/llm-timeouts.ts`
- L10 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`

### `packages/core/lib/openclaw-client.js`
- L3 [hub_alarm_native]: `module.exports = require('./hub-alarm-client');`

### `packages/core/lib/openclaw-client.legacy.js`
- L13 [legacy_openclaw_compat]: `const coreSourcePath = path.join(current, 'packages/core/lib/openclaw-client.ts');`
- L31 [legacy_openclaw_compat]: `path.join(__dirname, 'openclaw-client.ts'),`
- L32 [legacy_openclaw_compat]: `...(repoRoot ? [path.join(repoRoot, 'packages/core/lib/openclaw-client.ts')] : []),`
- L33 [legacy_openclaw_compat]: `path.resolve(__dirname, '../../../../packages/core/lib/openclaw-client.ts'),`
- L34 [legacy_openclaw_compat]: `path.resolve(__dirname, '../../../../../packages/core/lib/openclaw-client.ts'),`
- L35 [legacy_openclaw_compat]: `path.resolve(__dirname, '../../../../../../packages/core/lib/openclaw-client.ts'),`
- L42 [legacy_openclaw_compat]: `throw new Error(`Unable to locate openclaw-client.ts runtime source (checked: ${candidates.join(', ')})`);`

### `packages/core/lib/openclaw-client.ts`
- L4 [hub_alarm_native]: `* New code should import ./hub-alarm-client. This file stays in place so older`
- L13 [hub_alarm_native]: `} from './hub-alarm-client';`

### `packages/core/lib/reporting-hub.ts`
- L3 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`

### `packages/core/lib/telegram-sender.ts`
- L31 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`
- L211 [legacy_openclaw_compat]: `const LEGACY_WORKSPACE = process.env.OPENCLAW_WORKSPACE || '';`

### `packages/core/scripts/publish-python-report.ts`
- L15 [hub_alarm_native]: `const { postAlarm } = require('../lib/hub-alarm-client');`

### `packages/core/src/utils.ts`
- L18 [legacy_openclaw_compat]: `|| process.env.OPENCLAW_WORKSPACE`

### `scripts/api-usage-report.ts`
- L30 [legacy_openclaw_compat]: `const openclawClient = require('../packages/core/lib/openclaw-client');`

### `scripts/build-reservation-runtime.mjs`
- L16 [legacy_openclaw_compat]: `'packages/core/lib/openclaw-client.js',`

### `scripts/build-ts-phase1.mjs`
- L57 [legacy_openclaw_compat]: `path.join(root, 'packages/core/lib/openclaw-client.ts'),`

### `scripts/collect-kpi.ts`
- L16 [legacy_openclaw_compat]: `const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));`

### `scripts/launchd/ai.openclaw.gateway.plist`
- L11 [legacy_openclaw_compat]: `<key>OPENCLAW_GATEWAY_PORT</key>`
- L13 [legacy_openclaw_compat]: `<key>OPENCLAW_GATEWAY_TOKEN</key>`
- L15 [legacy_openclaw_compat]: `<key>OPENCLAW_LAUNCHD_LABEL</key>`
- L17 [legacy_openclaw_compat]: `<key>OPENCLAW_SERVICE_KIND</key>`
- L19 [legacy_openclaw_compat]: `<key>OPENCLAW_SERVICE_MARKER</key>`
- L21 [legacy_openclaw_compat]: `<key>OPENCLAW_SERVICE_VERSION</key>`
- L23 [legacy_openclaw_compat]: `<key>OPENCLAW_SYSTEMD_UNIT</key>`

### `scripts/lib/deployer.ts`
- L13 [legacy_openclaw_compat]: `const OPENCLAW_CONFIG = path.join(process.env.HOME, '.openclaw', 'openclaw.json');`
- L47 [legacy_openclaw_compat]: `const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));`

### `scripts/luna-transition-analysis.ts`
- L18 [legacy_openclaw_compat]: `const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));`

### `scripts/migrate/02-setup.sh`
- L161 [legacy_openclaw_compat]: `OPENCLAW_BIN="$(ls "$NODE_BIN_DIR/../lib/node_modules/openclaw/dist/index.js" 2>/dev/null || echo "")"`
- L163 [legacy_openclaw_compat]: `if [[ -n "$OPENCLAW_BIN" && -f "$PLIST" ]]; then`
- L176 [legacy_openclaw_compat]: `args[1] = '$OPENCLAW_BIN'`

### `scripts/migration/backup-verify.ts`
- L28 [legacy_openclaw_compat]: `const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');`
- L108 [legacy_openclaw_compat]: `const ocCheck = fs.existsSync(OPENCLAW_DIR);`
- L109 [legacy_openclaw_compat]: `record('~/.openclaw 존재', ocCheck ? 'pass' : 'fail', OPENCLAW_DIR);`
- L111 [legacy_openclaw_compat]: `const soulPath = path.join(OPENCLAW_DIR, 'agents', 'main', 'agent', 'SOUL.md');`

### `scripts/run-graduation-analysis.ts`
- L18 [legacy_openclaw_compat]: `const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));`

### `scripts/speed-test.ts`
- L41 [legacy_openclaw_compat]: `const openclawClient = require('../packages/core/lib/openclaw-client');`
- L44 [legacy_openclaw_compat]: `OPENCLAW_CONFIG,`
- L229 [legacy_openclaw_compat]: `const current = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'))?.agents?.defaults?.model?.primary;`
- L239 [legacy_openclaw_compat]: `const updated = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));`

### `scripts/stability-dashboard.ts`
- L243 [legacy_openclaw_compat]: `const openclawClient = require('../packages/core/lib/openclaw-client');`

### `scripts/weekly-stability-report.ts`
- L17 [legacy_openclaw_compat]: `const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));`

### `scripts/weekly-team-report.ts`
- L15 [legacy_openclaw_compat]: `const openclawClient = require('../packages/core/lib/openclaw-client');`

### `tsconfig.json`
- L20 [legacy_openclaw_compat]: `"packages/core/lib/openclaw-client.js",`

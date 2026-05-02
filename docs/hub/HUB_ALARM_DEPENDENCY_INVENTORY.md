# Hub Alarm Dependency Inventory

This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `retired_gateway_guard` entries are regression guards; `legacy_gateway_compat` entries are remaining migration targets and must stay at 0.

- generated_at: 2026-05-02T14:38:49.846Z
- total_matches: 290
- unique_files: 150
- hub_alarm_native: 277
- retired_gateway_guard: 13
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
- L98 [hub_alarm_native]: `const { postAlarm }                                 = require('../../../packages/core/lib/hub-alarm-client');`

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
- L141 [hub_alarm_native]: `'../../../packages/core/lib/hub-alarm-client': {`

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

### `bots/claude/scripts/auto-dev-watch.ts`
- L16 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/builder.ts`
- L24 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/guardian.ts`
- L28 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/quality-report.ts`
- L6 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/claude/src/reviewer.ts`
- L26 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

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

### `bots/hub/launchd/ai.hub.alarm-noise-report.plist`
- L27 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/hub/launchd/ai.hub.alarm-stale-auto-repair.plist`
- L27 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/hub/launchd/ai.hub.noisy-producer-auto-learn.plist`
- L26 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/hub/launchd/ai.hub.resource-api.plist`
- L38 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`
- L40 [hub_alarm_native]: `<key>HUB_ALARM_DISPATCH_MODE</key>`
- L42 [hub_alarm_native]: `<key>HUB_ALARM_LLM_CLASSIFIER_ENABLED</key>`
- L44 [hub_alarm_native]: `<key>HUB_ALARM_LLM_DAILY_LIMIT</key>`
- L46 [hub_alarm_native]: `<key>HUB_ALARM_CRITICAL_TYPE_ENABLED</key>`
- L48 [hub_alarm_native]: `<key>HUB_ALARM_INTERPRETER_ENABLED</key>`
- L50 [hub_alarm_native]: `<key>HUB_ALARM_INTERPRETER_FAIL_OPEN</key>`
- L52 [hub_alarm_native]: `<key>HUB_ALARM_INTERPRETER_LLM_DAILY_LIMIT</key>`
- L54 [hub_alarm_native]: `<key>HUB_ALARM_ENRICHMENT_ENABLED</key>`
- L56 [hub_alarm_native]: `<key>HUB_ALARM_ROUNDTABLE_ENABLED</key>`
- L58 [hub_alarm_native]: `<key>HUB_ALARM_ROUNDTABLE_DAILY_LIMIT</key>`
- L60 [hub_alarm_native]: `<key>HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD</key>`

### `bots/hub/launchd/ai.hub.roundtable-reflection.plist`
- L22 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/hub/launchd/ai.hub.severity-decay.plist`
- L22 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/hub/lib/alarm/alarm-enrichment.ts`
- L6 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_ENRICHMENT_ENABLED || '').trim().toLowerCase();`

### `bots/hub/lib/alarm/alarm-interpreter-router.ts`
- L10 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_INTERPRETER_ENABLED || '').trim().toLowerCase();`
- L15 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_INTERPRETER_FAIL_OPEN ?? 'true').trim().toLowerCase();`
- L25 [hub_alarm_native]: `const limit = Math.max(1, Number(process.env.HUB_ALARM_INTERPRETER_LLM_DAILY_LIMIT || 200) || 200);`

### `bots/hub/lib/alarm/alarm-roundtable-engine.ts`
- L13 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_ROUNDTABLE_ENABLED || '').trim().toLowerCase();`
- L23 [hub_alarm_native]: `const limit = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);`
- L81 [hub_alarm_native]: `const threshold = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD || 3) || 3);`

### `bots/hub/lib/alarm/auto-dev-incident.ts`
- L208 [hub_alarm_native]: `const dir = process.env.HUB_ALARM_AUTO_DEV_DIR || DEFAULT_AUTO_DEV_DIR;`

### `bots/hub/lib/alarm/classify-alarm-llm.ts`
- L13 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_LLM_CLASSIFIER_ENABLED || '').trim().toLowerCase();`
- L18 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_CRITICAL_TYPE_ENABLED || '').trim().toLowerCase();`
- L28 [hub_alarm_native]: `const limit = Math.max(1, Number(process.env.HUB_ALARM_LLM_DAILY_LIMIT || 100) || 100);`

### `bots/hub/lib/alarm/readiness.ts`
- L99 [hub_alarm_native]: `const classTopicsEnabled = isEnabled(process.env.HUB_ALARM_USE_CLASS_TOPICS)`

### `bots/hub/lib/alarm/suppression-rules.ts`
- L34 [hub_alarm_native]: `return String(process.env.HUB_ALARM_SUPPRESSION_RULES_PATH || '').trim()`

### `bots/hub/lib/alarm/templates.ts`
- L26 [hub_alarm_native]: `String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase(),`

### `bots/hub/lib/routes/alarm.ts`
- L77 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_DISPATCH_MODE || '').trim().toLowerCase();`
- L419 [hub_alarm_native]: `const claimLeaseMinutes = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_CLAIM_LEASE_MINUTES || 15) || 15);`

### `bots/hub/lib/routes/secrets.ts`
- L95 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase();`

### `bots/hub/scripts/alarm-activation-stage1-smoke.ts`
- L71 [hub_alarm_native]: `['HUB_ALARM_LLM_CLASSIFIER_ENABLED', 'true'],`
- L72 [hub_alarm_native]: `['HUB_ALARM_INTERPRETER_ENABLED', 'true'],`
- L73 [hub_alarm_native]: `['HUB_ALARM_ENRICHMENT_ENABLED', 'true'],`
- L74 [hub_alarm_native]: `['HUB_ALARM_CRITICAL_TYPE_ENABLED', 'true'],`
- L75 [hub_alarm_native]: `['HUB_ALARM_INTERPRETER_FAIL_OPEN', 'true'],`
- L82 [hub_alarm_native]: `const dispatchKeyIndex = text.indexOf('<key>HUB_ALARM_DISPATCH_MODE</key>');`
- L83 [hub_alarm_native]: `assert(dispatchKeyIndex >= 0, 'repo plist missing HUB_ALARM_DISPATCH_MODE');`
- L88 [hub_alarm_native]: `const roundtableKeyIndex = text.indexOf('<key>HUB_ALARM_ROUNDTABLE_ENABLED</key>');`
- L89 [hub_alarm_native]: `assert(roundtableKeyIndex >= 0, 'repo plist missing HUB_ALARM_ROUNDTABLE_ENABLED');`
- L154 [hub_alarm_native]: `HUB_ALARM_DISPATCH_MODE: 'shadow',`
- L155 [hub_alarm_native]: `HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',`
- L156 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_ENABLED: 'true',`
- L157 [hub_alarm_native]: `HUB_ALARM_ENRICHMENT_ENABLED: 'true',`
- L158 [hub_alarm_native]: `HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',`
- L159 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',`
- L160 [hub_alarm_native]: `HUB_ALARM_ROUNDTABLE_ENABLED: 'false',`

### `bots/hub/scripts/alarm-activation-stage2-smoke.ts`
- L121 [hub_alarm_native]: `HUB_ALARM_DISPATCH_MODE: 'supervised',`
- L122 [hub_alarm_native]: `HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',`
- L123 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_ENABLED: 'true',`
- L124 [hub_alarm_native]: `HUB_ALARM_ENRICHMENT_ENABLED: 'true',`
- L125 [hub_alarm_native]: `HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',`
- L126 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',`
- L127 [hub_alarm_native]: `HUB_ALARM_ROUNDTABLE_ENABLED: 'false',`
- L128 [hub_alarm_native]: `HUB_ALARM_USE_CLASS_TOPICS: 'true',`

### `bots/hub/scripts/alarm-activation-stage3-smoke.ts`
- L62 [hub_alarm_native]: `await withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: 'false' }, async () => {`
- L66 [hub_alarm_native]: `await withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: 'true' }, async () => {`
- L148 [hub_alarm_native]: `HUB_ALARM_DISPATCH_MODE: 'autonomous',`
- L149 [hub_alarm_native]: `HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',`
- L150 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_ENABLED: 'true',`
- L151 [hub_alarm_native]: `HUB_ALARM_ENRICHMENT_ENABLED: 'true',`
- L152 [hub_alarm_native]: `HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',`
- L153 [hub_alarm_native]: `HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',`
- L154 [hub_alarm_native]: `HUB_ALARM_ROUNDTABLE_ENABLED: 'true',`
- L155 [hub_alarm_native]: `HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: '10',`
- L156 [hub_alarm_native]: `HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD: '3',`
- L157 [hub_alarm_native]: `HUB_ALARM_USE_CLASS_TOPICS: 'true',`

### `bots/hub/scripts/alarm-auto-repair-stale-scan.ts`
- L5 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/alarm-autonomy-contract-smoke.ts`
- L26 [hub_alarm_native]: `const originalClassTopics = process.env.HUB_ALARM_USE_CLASS_TOPICS;`
- L33 [hub_alarm_native]: `const originalRulesPath = process.env.HUB_ALARM_SUPPRESSION_RULES_PATH;`
- L90 [hub_alarm_native]: `process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';`
- L118 [hub_alarm_native]: `process.env.HUB_ALARM_SUPPRESSION_RULES_PATH = path.join(tempRoot, 'rules.json');`
- L141 [hub_alarm_native]: `if (originalClassTopics == null) delete process.env.HUB_ALARM_USE_CLASS_TOPICS;`
- L142 [hub_alarm_native]: `else process.env.HUB_ALARM_USE_CLASS_TOPICS = originalClassTopics;`
- L147 [hub_alarm_native]: `if (originalRulesPath == null) delete process.env.HUB_ALARM_SUPPRESSION_RULES_PATH;`
- L148 [hub_alarm_native]: `else process.env.HUB_ALARM_SUPPRESSION_RULES_PATH = originalRulesPath;`

### `bots/hub/scripts/alarm-closure-cycle-smoke.ts`
- L144 [hub_alarm_native]: `process.env.HUB_ALARM_ROUNDTABLE_ENABLED = 'true';`
- L155 [hub_alarm_native]: `record(1, 'Roundtable shouldTrigger (critical)', true, 'HUB_ALARM_ROUNDTABLE_ENABLED=true, alarmType=critical → true');`

### `bots/hub/scripts/alarm-contract-audit.ts`
- L11 [hub_alarm_native]: `'packages/core/lib/hub-alarm-client.ts',`

### `bots/hub/scripts/alarm-digest-worker.ts`
- L8 [hub_alarm_native]: `const value = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_INTERVAL_MINUTES || 10) || 10);`
- L13 [hub_alarm_native]: `return Math.max(5, Number(process.env.HUB_ALARM_DIGEST_WINDOW_MINUTES || 240) || 240);`
- L17 [hub_alarm_native]: `return Math.min(1000, Math.max(10, Number(process.env.HUB_ALARM_DIGEST_LIMIT || 300) || 300));`

### `bots/hub/scripts/alarm-governor-smoke.ts`
- L43 [hub_alarm_native]: `autoDevDir: process.env.HUB_ALARM_AUTO_DEV_DIR,`
- L44 [hub_alarm_native]: `classTopics: process.env.HUB_ALARM_USE_CLASS_TOPICS,`
- L61 [hub_alarm_native]: `process.env.HUB_ALARM_AUTO_DEV_DIR = autoDevDir;`
- L62 [hub_alarm_native]: `process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';`
- L338 [hub_alarm_native]: `if (originals.autoDevDir == null) delete process.env.HUB_ALARM_AUTO_DEV_DIR;`
- L339 [hub_alarm_native]: `else process.env.HUB_ALARM_AUTO_DEV_DIR = originals.autoDevDir;`
- L340 [hub_alarm_native]: `if (originals.classTopics == null) delete process.env.HUB_ALARM_USE_CLASS_TOPICS;`
- L341 [hub_alarm_native]: `else process.env.HUB_ALARM_USE_CLASS_TOPICS = originals.classTopics;`

### `bots/hub/scripts/alarm-noise-report.ts`
- L5 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/alarm-roundtable-reflection.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/alarm-suppression-proposals.ts`
- L5 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/blog-alarm-dedup-smoke.ts`
- L20 [hub_alarm_native]: `// ── hub-alarm-client 유닛 테스트 (private 함수를 인라인 검증) ──────────────`

### `bots/hub/scripts/daily-metrics-digest.ts`
- L14 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/generate-hub-alarm-inventory.ts`
- L8 [hub_alarm_native]: `const outputMarkdownPath = path.join(projectRoot, 'docs', 'hub', 'HUB_ALARM_DEPENDENCY_INVENTORY.md');`
- L23 [hub_alarm_native]: `'hub-alarm-client',`
- L25 [hub_alarm_native]: `'HUB_ALARM_',`
- L34 [hub_alarm_native]: `if (match.includes('hub-alarm-client') || match.includes('HUB_ALARM_')) return 'hub_alarm_native';`
- L60 [hub_alarm_native]: `'!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',`
- L62 [retired_gateway_guard]: `'!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',`

### `bots/hub/scripts/hourly-status-digest.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

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
- L170 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`
- L189 [hub_alarm_native]: `const originalHubRecentAlertsPath = process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L190 [hub_alarm_native]: `const originalHubLegacyHooksToken = process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;`
- L191 [hub_alarm_native]: `const originalHubSkipDirect = process.env.HUB_ALARM_SKIP_DIRECT;`
- L192 [hub_alarm_native]: `const originalHubLegacyFallback = process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;`
- L202 [hub_alarm_native]: `if (originalHubRecentAlertsPath == null) delete process.env.HUB_ALARM_RECENT_ALERTS_PATH;`
- L203 [hub_alarm_native]: `else process.env.HUB_ALARM_RECENT_ALERTS_PATH = originalHubRecentAlertsPath;`
- L204 [hub_alarm_native]: `if (originalHubLegacyHooksToken == null) delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;`
- L205 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = originalHubLegacyHooksToken;`
- L206 [hub_alarm_native]: `if (originalHubSkipDirect == null) delete process.env.HUB_ALARM_SKIP_DIRECT;`
- L207 [hub_alarm_native]: `else process.env.HUB_ALARM_SKIP_DIRECT = originalHubSkipDirect;`
- L208 [hub_alarm_native]: `if (originalHubLegacyFallback == null) delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;`
- L209 [hub_alarm_native]: `else process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = originalHubLegacyFallback;`

### `bots/hub/scripts/hub-transition-completion-gate.ts`
- L48 [retired_gateway_guard]: `'OPENCLAW_BIN',`
- L52 [retired_gateway_guard]: `const RETIRED_GATEWAY_SOURCE_PATTERN = 'openclaw|legacy_gateway|18789|openclaw-gateway|OPENCLAW_BIN|execFile\\([^\\n]*openclaw|spawn\\([^\\n]*openclaw';`

### `bots/hub/scripts/incident-summary.ts`
- L14 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`
- L20 [hub_alarm_native]: `const AUTO_DEV_DIR = process.env.HUB_ALARM_AUTO_DEV_DIR`

### `bots/hub/scripts/launchd-alarm-class-topic-smoke.ts`
- L59 [hub_alarm_native]: `const value = envValueFromPlist(text, 'HUB_ALARM_USE_CLASS_TOPICS');`
- L67 [hub_alarm_native]: `reason: !ok ? 'HUB_ALARM_USE_CLASS_TOPICS_not_enabled'`

### `bots/hub/scripts/noisy-producer-auto-learn.ts`
- L19 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts`
- L19 [retired_gateway_guard]: `for (const marker of ['openclaw-gateway', 'OPENCLAW_BIN', '18789', 'execFile[^\\n]*openclaw', 'spawn[^\\n]*openclaw']) {`
- L28 [retired_gateway_guard]: `assert(legacySmoke.includes('RETIRED_GATEWAY_BIN_ENV'), 'legacy smoke must guard OPENCLAW_BIN');`

### `bots/hub/scripts/retired-gateway-residue-audit.ts`
- L28 [retired_gateway_guard]: `const outputMarkdownPath = path.join(repoRoot, 'docs', 'hub', 'OPENCLAW_RESIDUE_AUDIT.md');`
- L39 [retired_gateway_guard]: `'openclaw-client',`
- L81 [hub_alarm_native]: `if (file.startsWith('bots/hub/output/') || file === 'docs/hub/OPENCLAW_RESIDUE_AUDIT.md' || file === 'docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md') {`
- L117 [retired_gateway_guard]: `'!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',`
- L119 [hub_alarm_native]: `'!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',`

### `bots/hub/scripts/run-oauth-monitor.ts`
- L20 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');`

### `bots/hub/scripts/runtime-env-policy-smoke.ts`
- L22 [retired_gateway_guard]: `OPENCLAW_BIN: '/tmp/openclaw',`
- L31 [retired_gateway_guard]: `assert.equal(filtered.env.OPENCLAW_BIN, undefined);`
- L43 [retired_gateway_guard]: `assert.notEqual(childEnv.OPENCLAW_BIN, '/tmp/openclaw');`

### `bots/hub/scripts/severity-decay-runner.ts`
- L13 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/telegram-hub-secrets-smoke.ts`
- L16 [hub_alarm_native]: `HUB_ALARM_USE_CLASS_TOPICS: process.env.HUB_ALARM_USE_CLASS_TOPICS,`
- L52 [hub_alarm_native]: `delete process.env.HUB_ALARM_USE_CLASS_TOPICS;`

### `bots/hub/scripts/telegram-pending-queue-migration-smoke.ts`
- L69 [hub_alarm_native]: `HUB_ALARM_USE_CLASS_TOPICS: null,`

### `bots/hub/scripts/telegram-routing-readiness-report.ts`
- L106 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase();`

### `bots/hub/scripts/telegram-topic-routing-precedence-smoke.ts`
- L18 [hub_alarm_native]: `HUB_ALARM_USE_CLASS_TOPICS: process.env.HUB_ALARM_USE_CLASS_TOPICS,`
- L47 [hub_alarm_native]: `delete process.env.HUB_ALARM_USE_CLASS_TOPICS;`
- L98 [hub_alarm_native]: `process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';`

### `bots/hub/scripts/weekly-advisory-digest.ts`
- L14 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/weekly-audit-digest.ts`
- L14 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/hub/scripts/weekly-metrics-digest.ts`
- L14 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/investment/scripts/runtime-luna-launchd-cutover-preflight-pack.ts`
- L26 [hub_alarm_native]: `const hasTelegramRoute = Boolean(env.TELEGRAM_BOT_TOKEN || env.HUB_ALARM_TELEGRAM_ENABLED || env.TELEGRAM_ALARM_TOPIC_MAP);`

### `bots/orchestrator/launchd/ai.orchestrator.plist`
- L11 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/orchestrator/launchd/ai.steward.daily.plist`
- L11 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/orchestrator/launchd/ai.steward.hourly.plist`
- L11 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/orchestrator/launchd/ai.steward.weekly.plist`
- L11 [hub_alarm_native]: `<key>HUB_ALARM_USE_CLASS_TOPICS</key>`

### `bots/orchestrator/lib/steward/daily-summary.ts`
- L4 [hub_alarm_native]: `const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/lib/steward/telegram-manager.ts`
- L12 [hub_alarm_native]: `const EXPECTED_TOPICS = process.env.HUB_ALARM_USE_CLASS_TOPICS === 'false'`

### `bots/orchestrator/n8n/setup-n8n.ts`
- L40 [hub_alarm_native]: `const CLASS_TOPIC_MODE = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase() !== 'false'`
- L41 [hub_alarm_native]: `&& (String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim() !== '' || hubSecrets.telegram?.topic_alias_mode === 'class_topics');`

### `bots/orchestrator/n8n/setup-ska-workflows.ts`
- L41 [hub_alarm_native]: `const CLASS_TOPIC_MODE = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase() !== 'false'`
- L42 [hub_alarm_native]: `&& (String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim() !== '' || hubSecrets.telegram?.topic_alias_mode === 'class_topics');`

### `bots/orchestrator/src/dashboard.ts`
- L11 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client') as {`

### `bots/orchestrator/src/router.ts`
- L111 [hub_alarm_native]: `} = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/orchestrator/src/steward.ts`
- L15 [hub_alarm_native]: `const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');`

### `bots/reservation/tsconfig.json`
- L23 [hub_alarm_native]: `"../../packages/core/lib/hub-alarm-client.ts",`

### `bots/sigma/ts/src/sigma-daily-report.ts`
- L19 [hub_alarm_native]: `const hubAlarm = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `bots/sigma/ts/src/sigma-weekly-review.ts`
- L22 [hub_alarm_native]: `const hubAlarm = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));`

### `docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md`
- L106 [hub_alarm_native]: `- `hub-alarm-client`가 retired webhook보다 우선되는 구조로 이동했다.`
- L541 [hub_alarm_native]: `- legacy alarm shim import를 `hub-alarm-client`로 팀별 이관한다.`
- L625 [hub_alarm_native]: `- `readRecentAlertSnapshot` import를 `hub-alarm-client`로 변경.`

### `packages/core/REPORTING_HUB_PLAN.md`
- L80 [hub_alarm_native]: `- canonical transport 자체 (`hub-alarm-client.ts`, `reporting-hub.ts`)`

### `packages/core/REPORTING_INVENTORY.md`
- L121 [hub_alarm_native]: `5. canonical transport (`hub-alarm-client.ts`, `reporting-hub.ts`) 바깥 non-blog current delivery는 사실상 1차 정리 완료 상태로 유지`

### `packages/core/lib/alarm-producer-contract.ts`
- L10 [hub_alarm_native]: `const { postAlarm } = require('./hub-alarm-client');`

### `packages/core/lib/hub-alarm-client.js`
- L5 [hub_alarm_native]: `module.exports = loadTsSourceBridge(__dirname, 'hub-alarm-client');`

### `packages/core/lib/hub-alarm-client.ts`
- L2 [hub_alarm_native]: `* packages/core/lib/hub-alarm-client.js — Hub alarm 클라이언트`
- L15 [hub_alarm_native]: `const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 5000) || 5000);`
- L18 [hub_alarm_native]: `const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()`
- L175 [hub_alarm_native]: `const classMode = _readBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')`
- L177 [hub_alarm_native]: `&& !_readFalseBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS'));`
- L239 [hub_alarm_native]: `if (_readBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')) return true;`
- L240 [hub_alarm_native]: `if (_readFalseBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')) return false;`
- L512 [hub_alarm_native]: `signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),`
- L551 [hub_alarm_native]: `console.warn(`[hub-alarm-client] recent alert snapshot 저장 실패: ${(error as Error).message}`);`
- L584 [hub_alarm_native]: `console.warn('[hub-alarm-client] inline telegram 발송 실패: bot token/group id 미설정');`
- L613 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 429 — ${delayMs}ms 후 재시도`);`
- L624 [hub_alarm_native]: `console.warn(`[hub-alarm-client] inline telegram 실패: ${error.message}`);`
- L674 [hub_alarm_native]: `const hubDirectBlocked = _readBooleanEnv('HUB_ALARM_SKIP_DIRECT');`
- L702 [hub_alarm_native]: `console.warn(`[hub-alarm-client] hub alarm failed: ${hubResult.error}`);`

### `packages/core/lib/reporting-hub.ts`
- L3 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`

### `packages/core/lib/runtime-env-policy.ts`
- L9 [retired_gateway_guard]: `'OPENCLAW_',`

### `packages/core/lib/telegram-sender.ts`
- L31 [hub_alarm_native]: `const hubAlarmClient = require('./hub-alarm-client');`
- L128 [hub_alarm_native]: `const raw = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase();`
- L284 [hub_alarm_native]: `const raw = process.env.HUB_ALARM_USE_CLASS_TOPICS;`

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

### `scripts/pre-commit`
- L140 [retired_gateway_guard]: `'OPENCLAW_BIN'`

### `scripts/run-graduation-analysis.ts`
- L18 [hub_alarm_native]: `const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));`

### `scripts/setup-telegram-forum.ts`
- L26 [hub_alarm_native]: `const CLASS_TOPIC_MODE = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || 'true').trim().toLowerCase() !== 'false';`

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

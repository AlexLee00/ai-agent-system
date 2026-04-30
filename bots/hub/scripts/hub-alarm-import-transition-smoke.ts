const { spawnSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const MIGRATED_SCOPES = [
  'bots/orchestrator/src',
  'bots/orchestrator/lib/steward',
  'bots/darwin/lib',
  'bots/darwin/scripts',
  'bots/darwin/__tests__',
  'bots/claude/lib/reporter.ts',
  'bots/claude/lib/telegram-reporter.ts',
  'bots/claude/lib/auto-dev-pipeline.ts',
  'bots/claude/lib/mainbot-client.ts',
  'bots/claude/lib/codex-plan-notifier.ts',
  'bots/claude/lib/autofix.ts',
  'bots/claude/lib/doctor.ts',
  'bots/claude/src/builder.ts',
  'bots/claude/src/guardian.ts',
  'bots/claude/src/reviewer.ts',
  'bots/claude/src/quality-report.ts',
  'bots/blog/lib/ab-testing.ts',
  'bots/blog/lib/blo.ts',
  'bots/blog/lib/commenter.ts',
  'bots/blog/lib/curriculum-planner.ts',
  'bots/blog/lib/evolution-cycle.ts',
  'bots/blog/lib/img-gen-doctor.ts',
  'bots/blog/lib/insta-crosspost.ts',
  'bots/blog/lib/instagram-story.ts',
  'bots/blog/lib/platform-orchestrator.ts',
  'bots/blog/lib/publish-reporter.ts',
  'bots/blog/lib/self-rewarding/marketing-dpo.ts',
  'bots/blog/lib/signals/brand-mention-collector.ts',
  'bots/blog/lib/signals/competitor-monitor.ts',
  'bots/blog/__tests__',
  'bots/blog/scripts/auto-instagram-publish.ts',
  'bots/blog/scripts/auto-facebook-publish.ts',
  'bots/blog/scripts/compute-attribution.ts',
  'bots/sigma/ts/src/sigma-daily-report.ts',
  'bots/sigma/ts/src/sigma-weekly-review.ts',
  'packages/core/scripts',
  'scripts/api-usage-report.ts',
  'scripts/luna-transition-analysis.ts',
  'scripts/run-graduation-analysis.ts',
  'scripts/weekly-team-report.ts',
  'scripts/stability-dashboard.ts',
  'scripts/weekly-stability-report.ts',
  'scripts/collect-kpi.ts',
  'scripts/speed-test.ts',
  'scripts/build-ts-phase1.mjs',
  'scripts/build-reservation-runtime.mjs',
  'tsconfig.json',
  'bots/claude/tsconfig.json',
  'bots/reservation/tsconfig.json',
];

const MIGRATED_RUNTIME_SCOPES = [
  'bots/blog/lib/commenter.ts',
  'bots/blog/lib/richer.ts',
  'bots/blog/scripts/collect-views.ts',
  'bots/blog/lib/runtime-config.ts',
  'bots/blog/config.json',
  'scripts/api-usage-report.ts',
  'scripts/speed-test.ts',
];

function assertNoMatches({ pattern, scopes, message }) {
  const result = spawnSync('rg', [
    '-n',
    '-S',
    pattern,
    ...scopes,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const matches = String(result.stdout || '').trim();
  if (matches) {
    throw new Error([
      message,
      matches,
    ].join('\n'));
  }

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(String(result.stderr || '').trim() || `rg failed with status=${result.status}`);
  }
}

function main() {
  const legacyAlarmImportPattern = 'open' + 'claw-client';
  const retiredBrowserRuntimePattern = [
    'OPEN' + 'CLAW_WORKSPACE',
    'OPEN' + 'CLAW_BROWSER_TOKEN',
    'OPEN' + 'CLAW_GATEWAY_TOKEN',
    '~/.open' + 'claw/workspace/naver-profile',
  ].join('|');

  assertNoMatches({
    pattern: legacyAlarmImportPattern,
    scopes: MIGRATED_SCOPES,
    message: 'migrated Hub alarm scopes must not import the legacy alarm shim directly',
  });

  assertNoMatches({
    pattern: retiredBrowserRuntimePattern,
    scopes: MIGRATED_RUNTIME_SCOPES,
    message: 'migrated browser runtime scopes must not depend on retired gateway workspace/token defaults',
  });

  console.log(JSON.stringify({
    ok: true,
    migrated_scopes: MIGRATED_SCOPES,
    migrated_runtime_scopes: MIGRATED_RUNTIME_SCOPES,
    direct_legacy_alarm_client_imports: 0,
    legacy_gateway_runtime_defaults: 0,
  }, null, 2));
}

main();

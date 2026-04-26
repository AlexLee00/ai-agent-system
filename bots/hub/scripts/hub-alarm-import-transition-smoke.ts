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
  'bots/worker/lib/approval.ts',
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
  'bots/blog/scripts/auto-instagram-publish.ts',
  'bots/blog/scripts/auto-facebook-publish.ts',
  'bots/blog/scripts/compute-attribution.ts',
  'bots/sigma/ts/src/sigma-daily-report.ts',
  'bots/sigma/ts/src/sigma-weekly-review.ts',
  'packages/core/scripts',
];

const MIGRATED_RUNTIME_SCOPES = [
  'bots/blog/lib/commenter.ts',
  'bots/blog/lib/richer.ts',
  'bots/blog/scripts/collect-views.ts',
  'bots/blog/lib/runtime-config.ts',
  'bots/blog/config.json',
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
  assertNoMatches({
    pattern: 'openclaw-client',
    scopes: MIGRATED_SCOPES,
    message: 'migrated Hub alarm scopes must not import openclaw-client directly',
  });

  assertNoMatches({
    pattern: 'OPENCLAW_WORKSPACE|OPENCLAW_BROWSER_TOKEN|OPENCLAW_GATEWAY_TOKEN|~/.openclaw/workspace/naver-profile',
    scopes: MIGRATED_RUNTIME_SCOPES,
    message: 'migrated browser runtime scopes must not depend on OpenClaw workspace/token defaults',
  });

  console.log(JSON.stringify({
    ok: true,
    migrated_scopes: MIGRATED_SCOPES,
    migrated_runtime_scopes: MIGRATED_RUNTIME_SCOPES,
    direct_openclaw_client_imports: 0,
    openclaw_runtime_defaults: 0,
  }, null, 2));
}

main();

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RETIRED_GATEWAY_ID = 'open' + 'claw';
const RETIRED_GATEWAY_WORD = 'Open' + 'Claw';
const RETIRED_GATEWAY_LABEL = ['ai', RETIRED_GATEWAY_ID].join('.');

const CLAUDE_RUNTIME_FILES = [
  'bots/claude/lib/runtime-paths.ts',
  'bots/claude/lib/runtime-paths.js',
  'bots/claude/lib/config.ts',
  'bots/claude/lib/auto-dev-pipeline.ts',
  'bots/claude/lib/codex-plan-notifier.ts',
  'bots/claude/lib/dexter-mode.ts',
  'bots/claude/lib/ai-analyst.ts',
  'bots/claude/lib/bug-report.ts',
  'bots/claude/lib/mainbot-client.ts',
  'bots/claude/lib/claude-lead-brain.ts',
  'bots/claude/lib/autofix.ts',
  'bots/claude/lib/checks/self-diagnosis.ts',
  'bots/claude/lib/checks/team-leads.ts',
  'bots/claude/lib/checks/network.ts',
  'bots/claude/lib/checks/logs.ts',
  'bots/claude/lib/checks/bots.ts',
  'bots/claude/lib/checks/error-logs.ts',
  ['bots/claude/lib/checks', `${RETIRED_GATEWAY_ID}.ts`].join('/'),
  'bots/claude/lib/archer/config.ts',
  'bots/claude/lib/daily-report.ts',
  'bots/claude/scripts/claude-daily-report.ts',
  'bots/claude/scripts/claude-weekly-review.ts',
  'bots/claude/scripts/health-dashboard-server.ts',
  'bots/claude/scripts/health-report.ts',
  'bots/claude/scripts/migrate.ts',
  'bots/claude/scripts/team-check.ts',
  'bots/claude/src/claude-commander.ts',
  'bots/claude/src/dexter.ts',
  'bots/claude/src/dexter-quickcheck.ts',
  'bots/claude/launchd/ai.claude.commander.plist',
  'bots/claude/launchd/ai.claude.health-dashboard.plist',
];

const FORBIDDEN_ACTIVE_PATTERNS = [
  new RegExp(`[/\\\\]\\.${RETIRED_GATEWAY_ID}([/\\\\]|$)`, 'i'),
  new RegExp('OPEN' + 'CLAW_WORKSPACE'),
  new RegExp('OPEN' + 'CLAW_LOGS'),
  new RegExp(RETIRED_GATEWAY_LABEL.replace(/\./g, '\\.'), 'i'),
  new RegExp(`${RETIRED_GATEWAY_ID}-model-sync`, 'i'),
  new RegExp(RETIRED_GATEWAY_WORD, 'i'),
  new RegExp(RETIRED_GATEWAY_ID, 'i'),
];

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function assertNoLegacyRuntimeReference(relPath: string): void {
  const findings = readRepoFile(relPath)
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => FORBIDDEN_ACTIVE_PATTERNS.some((pattern) => pattern.test(line)));

  assert.equal(
    findings.length,
    0,
    [
      `${relPath} must stay on Hub-native runtime paths and not reference active retired-gateway runtime`,
      ...findings.map(({ line, number }) => `${number}: ${line}`),
    ].join('\n'),
  );
}

function main(): void {
  for (const relPath of CLAUDE_RUNTIME_FILES) {
    assertNoLegacyRuntimeReference(relPath);
  }

  console.log(JSON.stringify({
    ok: true,
    claude_runtime_legacy_gateway_isolated: true,
    checked_files: CLAUDE_RUNTIME_FILES.length,
  }));
}

main();

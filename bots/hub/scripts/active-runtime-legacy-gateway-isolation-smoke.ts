import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RETIRED_GATEWAY_ID = 'open' + 'claw';
const RETIRED_GATEWAY_WORD = 'Open' + 'Claw';
const RETIRED_GATEWAY_LABEL = ['ai', RETIRED_GATEWAY_ID, 'gateway'].join('.');

const ACTIVE_RUNTIME_FILES = [
  'bots/orchestrator/src/router.ts',
  'bots/orchestrator/src/steward.ts',
  'bots/orchestrator/lib/night-handler.ts',
  'bots/orchestrator/lib/steward/retired-ingress-session-manager.ts',
  'bots/orchestrator/scripts/health-report.ts',
  'bots/orchestrator/scripts/check-jay-gateway-primary.ts',
  'bots/orchestrator/scripts/prepare-jay-gateway-switch.ts',
  'bots/orchestrator/scripts/log-jay-gateway-experiment.ts',
  'bots/orchestrator/scripts/tune-jay-gateway-concurrency.ts',
  'bots/orchestrator/scripts/prune-jay-gateway-fallbacks.ts',
  'bots/orchestrator/src/dashboard.ts',
  'bots/orchestrator/launchd/ai.orchestrator.plist',
  'bots/reservation/launchd/ai.ska.commander.plist',
  'bots/reservation/launchd/ai.ska.dashboard.plist',
  'bots/reservation/auto/monitors/run-kiosk-monitor.sh',
  'bots/reservation/auto/monitors/run-today-audit.sh',
  'bots/reservation/auto/monitors/start-ops.sh',
  'bots/reservation/auto/scheduled/run-audit.sh',
  'bots/reservation/auto/scheduled/run-daily-summary.sh',
  'bots/reservation/auto/scheduled/run-pay-scan.sh',
  'bots/reservation/manual/admin/run-verify.sh',
];

const FORBIDDEN_RUNTIME_PATTERNS = [
  new RegExp(`[/\\\\]\\.${RETIRED_GATEWAY_ID}([/\\\\]|$)`, 'i'),
  new RegExp('OPEN' + 'CLAW_WORKSPACE'),
  new RegExp('OPEN' + 'CLAW_LOGS'),
  new RegExp(`${RETIRED_GATEWAY_ID}\\.json`, 'i'),
  new RegExp(`${RETIRED_GATEWAY_WORD} gateway`, 'i'),
  new RegExp(`${RETIRED_GATEWAY_WORD} main ingress`, 'i'),
  new RegExp(RETIRED_GATEWAY_LABEL.replace(/\./g, '\\.'), 'i'),
  new RegExp(`get${RETIRED_GATEWAY_WORD}GatewayModelState`),
  new RegExp('retired-ingress-session-manager'),
  new RegExp(`${RETIRED_GATEWAY_ID}-config`),
];

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function assertNoRetiredRuntimePath(relPath: string): void {
  const lines = readRepoFile(relPath).split('\n');
  const findings = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => FORBIDDEN_RUNTIME_PATTERNS.some((pattern) => pattern.test(line)));

  assert.equal(
    findings.length,
    0,
    [
      `${relPath} must not depend on active retired-gateway runtime paths/config`,
      ...findings.map(({ line, number }) => `${number}: ${line}`),
    ].join('\n'),
  );
}

function main(): void {
  for (const relPath of ACTIVE_RUNTIME_FILES) {
    assertNoRetiredRuntimePath(relPath);
  }

  console.log(JSON.stringify({
    ok: true,
    active_runtime_legacy_gateway_isolated: true,
    checked_files: ACTIVE_RUNTIME_FILES.length,
  }));
}

main();

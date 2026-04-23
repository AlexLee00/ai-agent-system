#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPositionStrategyRemediationDecision } from './runtime-position-strategy-remediation.ts';

export function runPositionStrategyRemediationSmoke() {
  const ready = buildPositionStrategyRemediationDecision({
    status: 'position_strategy_hygiene_attention',
    recommendedExchange: 'kis_overseas',
    duplicateManagedScopes: 3,
    orphanProfiles: 10,
    unmatchedManaged: 0,
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --json --exchange=kis_overseas',
    retireDryRunCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --json --exchange=kis_overseas',
  }, {
    historyCount: 4,
    ageMinutes: 12,
    stale: false,
    current: { status: 'position_strategy_remediation_ready' },
    statusChanged: false,
    delta: { duplicateManaged: 0, orphanProfiles: -1, unmatchedManaged: 0 },
  });
  assert.equal(ready.status, 'position_strategy_remediation_ready');
  assert.match(ready.headline, /focus kis_overseas/);
  assert.match(ready.actionItems.join('\n'), /history count 4/);
  assert.match(ready.actionItems.join('\n'), /age 12m \/ stale no/);
  assert.match(ready.actionItems.join('\n'), /remediation history/);
  assert.match(ready.actionItems.join('\n'), /normalize dry-run/);

  const clear = buildPositionStrategyRemediationDecision({
    status: 'position_strategy_hygiene_ok',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
  }, {
    historyCount: 2,
    ageMinutes: 85,
    stale: true,
    current: { status: 'position_strategy_remediation_clear' },
    statusChanged: false,
    delta: { duplicateManaged: 0, orphanProfiles: 0, unmatchedManaged: 0 },
  });
  assert.equal(clear.status, 'position_strategy_remediation_clear');
  assert.match(clear.actionItems.join('\n'), /history count 2/);
  assert.match(clear.actionItems.join('\n'), /stale yes/);

  const unavailable = buildPositionStrategyRemediationDecision(null);
  assert.equal(unavailable.status, 'position_strategy_remediation_unavailable');

  return {
    ok: true,
    readyStatus: ready.status,
    clearStatus: clear.status,
    unavailableStatus: unavailable.status,
  };
}

async function main() {
  const result = runPositionStrategyRemediationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy remediation smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy remediation smoke 실패:',
  });
}

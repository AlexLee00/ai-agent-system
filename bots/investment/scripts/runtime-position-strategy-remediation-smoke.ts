#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPositionStrategyRemediationActions,
  buildPositionStrategyRemediationDecision,
  buildPositionStrategyRemediationRefreshState,
  runPositionStrategyRemediation,
} from './runtime-position-strategy-remediation.ts';

export function runPositionStrategyRemediationSmoke() {
  const ready = buildPositionStrategyRemediationDecision({
    status: 'position_strategy_hygiene_attention',
    recommendedExchange: 'kis_overseas',
    duplicateManagedScopes: 3,
    orphanProfiles: 10,
    unmatchedManaged: 0,
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
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
  const readyRefresh = buildPositionStrategyRemediationRefreshState({
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
  }, {
    stale: false,
    current: { status: 'position_strategy_remediation_ready' },
  });
  assert.equal(readyRefresh.needed, false);
  assert.equal(readyRefresh.command, null);
  const readyActions = buildPositionStrategyRemediationActions({
    status: 'position_strategy_hygiene_attention',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --json --exchange=kis_overseas',
    normalizeApplyCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --apply --json --exchange=kis_overseas',
    retireDryRunCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --json --exchange=kis_overseas',
    retireApplyCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --apply --json --exchange=kis_overseas',
  }, readyRefresh);
  assert.match(readyActions.nextCommand, /runtime:position-strategy-remediation/);

  const clear = buildPositionStrategyRemediationDecision({
    status: 'position_strategy_hygiene_ok',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
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
  assert.match(clear.actionItems.join('\n'), /history refresh recommended/);
  assert.match(clear.headline, /history stale/);
  assert.match(clear.actionItems.join('\n'), /stale yes/);
  const staleRefresh = buildPositionStrategyRemediationRefreshState({
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
  }, {
    stale: true,
    current: { status: 'position_strategy_remediation_clear' },
  });
  assert.equal(staleRefresh.needed, true);
  assert.match(staleRefresh.reason, /history refresh recommended/);
  assert.match(staleRefresh.command, /runtime:position-strategy-remediation-refresh/);
  const staleActions = buildPositionStrategyRemediationActions({
    status: 'position_strategy_hygiene_ok',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
  }, staleRefresh);
  assert.match(staleActions.nextCommand, /runtime:position-strategy-remediation-refresh/);

  const missingHistory = buildPositionStrategyRemediationDecision({
    status: 'position_strategy_hygiene_attention',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --json',
    retireDryRunCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --json',
  }, null);
  assert.match(missingHistory.headline, /history unavailable/);
  assert.match(missingHistory.actionItems.join('\n'), /history unavailable \/ refresh required/);
  assert.match(missingHistory.actionItems.join('\n'), /history refresh required/);
  const missingRefresh = buildPositionStrategyRemediationRefreshState({
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
  }, null);
  assert.equal(missingRefresh.needed, true);
  assert.match(missingRefresh.reason, /history refresh required/);
  assert.match(missingRefresh.command, /runtime:position-strategy-remediation-refresh/);
  const missingActions = buildPositionStrategyRemediationActions({
    status: 'position_strategy_hygiene_attention',
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --json',
    retireDryRunCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --json',
  }, missingRefresh);
  assert.match(missingActions.nextCommand, /runtime:position-strategy-remediation-refresh/);

  const unavailable = buildPositionStrategyRemediationDecision(null);
  assert.equal(unavailable.status, 'position_strategy_remediation_unavailable');
  const unavailableActions = buildPositionStrategyRemediationActions(null, missingRefresh);
  assert.match(unavailableActions.nextCommand, /runtime:position-strategy-remediation-refresh/);

  return {
    ok: true,
    readyStatus: ready.status,
    clearStatus: clear.status,
    missingHistoryStatus: missingHistory.status,
    unavailableStatus: unavailable.status,
    nextCommands: {
      ready: readyActions.nextCommand,
      stale: staleActions.nextCommand,
      missing: missingActions.nextCommand,
      unavailable: unavailableActions.nextCommand,
    },
  };
}

async function main() {
  const smokeResult = runPositionStrategyRemediationSmoke();
  const contractResult = await runPositionStrategyRemediationContractSmoke();
  const result = {
    ...smokeResult,
    contract: contractResult,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy remediation smoke ok');
}

export async function runPositionStrategyRemediationContractSmoke() {
  const result = await runPositionStrategyRemediation({ json: true });
  assert.equal(result.ok, true);
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'remediationNextCommandTransition'));
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'remediationTrend'));
  return {
    ok: true,
    hasTransitionField: Object.prototype.hasOwnProperty.call(result, 'remediationNextCommandTransition'),
    hasTrendField: Object.prototype.hasOwnProperty.call(result, 'remediationTrend'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy remediation smoke 실패:',
  });
}

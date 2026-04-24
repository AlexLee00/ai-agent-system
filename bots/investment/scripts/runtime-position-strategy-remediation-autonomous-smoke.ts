#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionStrategyRemediation } from './runtime-position-strategy-remediation.ts';

function buildMockRemediationPlan() {
  return {
    status: 'position_strategy_hygiene_attention',
    recommendedExchange: 'binance',
    recommendedExchangeCount: 3,
    duplicateManagedScopes: 4,
    orphanProfiles: 2,
    unmatchedManaged: 1,
    remediationReportCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json',
    remediationAutonomousApplyCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation:autonomous',
    remediationHistoryCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-history -- --json',
    remediationRefreshCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation-refresh -- --if-stale --json',
    hygieneReportCommand: 'npm --prefix /tmp run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --json',
    normalizeApplyCommand: 'npm --prefix /tmp run runtime:normalize-duplicate-strategy-profiles -- --apply --json',
    retireDryRunCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --json',
    retireApplyCommand: 'npm --prefix /tmp run runtime:retire-orphan-strategy-profiles -- --apply --json',
  };
}

function buildMockHygiene({
  duplicateSafe = true,
  orphanSafe = false,
  duplicateManaged = 4,
  orphanProfiles = 2,
  unmatchedManaged = 1,
} = {}) {
  return {
    ok: true,
    decision: {
      status: 'position_strategy_hygiene_attention',
      headline: 'mock hygiene attention',
      actionItems: [],
    },
    audit: {
      duplicateManagedProfileScopes: duplicateManaged,
      orphanProfiles,
      unmatchedManagedPositions: unmatchedManaged,
    },
    duplicateNormalization: {
      decision: {
        safeToApply: duplicateSafe === true,
      },
      rows: [],
    },
    orphanRetirement: {
      decision: {
        safeToApply: orphanSafe === true,
      },
      rows: [],
    },
    remediationPlan: buildMockRemediationPlan(),
  };
}

function buildMockHistory({ count = 3 } = {}) {
  return {
    ok: true,
    file: '/tmp/mock-remediation-history.jsonl',
    historyCount: count,
    current: { status: 'position_strategy_remediation_ready', nextCommand: 'npm --prefix /tmp run runtime:position-strategy-remediation -- --json' },
    previous: null,
    lastRecordedAt: new Date().toISOString(),
    ageMinutes: 1,
    stale: false,
    statusChanged: false,
    nextCommandChanged: false,
    nextCommandTransition: { previous: null, current: null },
    delta: {
      duplicateManaged: 0,
      orphanProfiles: 0,
      unmatchedManaged: 0,
    },
  };
}

function buildSafeHistoryLines(
  count = 2,
  {
    duplicate = true,
    orphan = false,
    recommendedExchange = 'binance',
  } = {},
) {
  return Array.from({ length: Math.max(0, count) }, () => ({
    recommendedExchange,
    safeToApply: { duplicate: duplicate === true, orphan: orphan === true },
  }));
}

export async function runPositionStrategyRemediationAutonomousSmoke() {
  let normalizeCalls = 0;
  let retireCalls = 0;

  const blockedStable = await runPositionStrategyRemediation({
    json: true,
    autonomousApply: true,
    stableCycles: 3,
    safeCycles: 2,
    hygiene: buildMockHygiene(),
    remediationHistory: buildMockHistory({ count: 1 }),
    remediationHistoryLines: buildSafeHistoryLines(2),
    normalizeApply: async () => {
      normalizeCalls += 1;
      return { ok: true, retired: 1 };
    },
    retireApply: async () => {
      retireCalls += 1;
      return { ok: true, retired: 1 };
    },
    postApplyHygieneLoader: async () => buildMockHygiene({ duplicateManaged: 3, orphanProfiles: 1, unmatchedManaged: 1 }),
  });
  assert.equal(blockedStable.remediationAutonomousStatus, 'autonomous_action_blocked_by_safety');
  assert.match(String(blockedStable.remediationAutonomousReason || ''), /history_not_enough_cycles:1\/3/);
  assert.equal(normalizeCalls, 0);
  assert.equal(retireCalls, 0);

  const executed = await runPositionStrategyRemediation({
    json: true,
    autonomousApply: true,
    stableCycles: 3,
    safeCycles: 3,
    hygiene: buildMockHygiene({ duplicateSafe: true, orphanSafe: false, duplicateManaged: 5, orphanProfiles: 2, unmatchedManaged: 1 }),
    remediationHistory: buildMockHistory({ count: 5 }),
    remediationHistoryLines: buildSafeHistoryLines(2),
    normalizeApply: async () => {
      normalizeCalls += 1;
      return { ok: true, retired: 2 };
    },
    retireApply: async () => {
      retireCalls += 1;
      return { ok: true, retired: 0 };
    },
    postApplyHygieneLoader: async () => buildMockHygiene({ duplicateManaged: 3, orphanProfiles: 1, unmatchedManaged: 1 }),
  });
  assert.equal(executed.remediationAutonomousStatus, 'autonomous_action_executed');
  assert.equal(executed.remediationAutonomousVerify?.ok, true);
  assert.equal(normalizeCalls > 0, true);

  const blockedActionSpecificSafe = await runPositionStrategyRemediation({
    json: true,
    autonomousApply: true,
    stableCycles: 3,
    safeCycles: 3,
    hygiene: buildMockHygiene({ duplicateSafe: true, orphanSafe: false, duplicateManaged: 5, orphanProfiles: 2, unmatchedManaged: 1 }),
    remediationHistory: buildMockHistory({ count: 5 }),
    remediationHistoryLines: buildSafeHistoryLines(2, { duplicate: false, orphan: true }),
    normalizeApply: async () => {
      normalizeCalls += 1;
      return { ok: true, retired: 1 };
    },
    retireApply: async () => {
      retireCalls += 1;
      return { ok: true, retired: 1 };
    },
    postApplyHygieneLoader: async () => buildMockHygiene({ duplicateManaged: 3, orphanProfiles: 1, unmatchedManaged: 1 }),
  });
  assert.equal(blockedActionSpecificSafe.remediationAutonomousStatus, 'autonomous_action_blocked_by_safety');
  assert.match(String(blockedActionSpecificSafe.remediationAutonomousReason || ''), /safe_to_apply_not_stable:duplicate=1\/3,orphan=0\/3/);

  const applyFailedNoop = await runPositionStrategyRemediation({
    json: true,
    autonomousApply: true,
    stableCycles: 2,
    safeCycles: 2,
    hygiene: buildMockHygiene({ duplicateSafe: true, orphanSafe: false, duplicateManaged: 4, orphanProfiles: 2, unmatchedManaged: 1 }),
    remediationHistory: buildMockHistory({ count: 4 }),
    remediationHistoryLines: buildSafeHistoryLines(1, { duplicate: true, orphan: false }),
    normalizeApply: async () => ({ ok: false, error: 'mock_apply_failed', retired: 0 }),
    retireApply: async () => ({ ok: true, retired: 0 }),
    postApplyHygieneLoader: async () => buildMockHygiene({ duplicateManaged: 4, orphanProfiles: 2, unmatchedManaged: 1 }),
  });
  assert.equal(applyFailedNoop.remediationAutonomousStatus, 'autonomous_action_failed');
  assert.equal(applyFailedNoop.remediationAutonomousReason, 'post_apply_verification_failed');
  assert.equal(applyFailedNoop.remediationAutonomousVerify?.ok, false);
  assert.equal(applyFailedNoop.remediationAutonomousVerify?.actionChecks?.duplicate?.resultOk, false);

  const verifyFailed = await runPositionStrategyRemediation({
    json: true,
    autonomousApply: true,
    stableCycles: 2,
    safeCycles: 2,
    hygiene: buildMockHygiene({ duplicateSafe: true, orphanSafe: false, duplicateManaged: 4, orphanProfiles: 2, unmatchedManaged: 1 }),
    remediationHistory: buildMockHistory({ count: 4 }),
    remediationHistoryLines: buildSafeHistoryLines(1),
    normalizeApply: async () => ({ ok: true, retired: 1 }),
    retireApply: async () => ({ ok: true, retired: 0 }),
    postApplyHygieneLoader: async () => buildMockHygiene({ duplicateManaged: 6, orphanProfiles: 3, unmatchedManaged: 2 }),
  });
  assert.equal(verifyFailed.remediationAutonomousStatus, 'autonomous_action_failed');
  assert.equal(verifyFailed.remediationAutonomousReason, 'post_apply_verification_failed');
  assert.equal(verifyFailed.remediationAutonomousVerify?.ok, false);

  return {
    ok: true,
    blockedReason: blockedStable.remediationAutonomousReason,
    executedStatus: executed.remediationAutonomousStatus,
    blockedActionSpecificSafeReason: blockedActionSpecificSafe.remediationAutonomousReason,
    applyFailedNoopStatus: applyFailedNoop.remediationAutonomousStatus,
    verifyFailedStatus: verifyFailed.remediationAutonomousStatus,
    autonomousApplyCommand: executed.remediationActionAutonomousApplyCommand || executed.remediationCommands?.autonomousApply || null,
  };
}

async function main() {
  const result = await runPositionStrategyRemediationAutonomousSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy remediation autonomous smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy remediation autonomous smoke 실패:',
  });
}

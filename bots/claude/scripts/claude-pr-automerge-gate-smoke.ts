#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const gate = require('../lib/pr-automerge-gate.ts');

async function main() {
  const originalAutomerge = process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
  delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;

  try {
    const protectedFixtures = [
      ['crypto', 'bots/investment/markets/binance/executor.ts'],
      ['money', 'bots/investment/scripts/runtime-luna-approved-signal-executor.ts'],
      ['secrets', 'bots/hub/secrets/oauth.json'],
      ['launchd', 'bots/claude/launchd/ai.claude.refactor-cycle.plist'],
      ['security', 'bots/claude/src/guardian.ts'],
    ];
    for (const [label, file] of protectedFixtures) {
      const notices = [];
      const result = await gate.evaluatePrAutomergeGate({
        prNumber: 10,
        changedFiles: [file],
        score: 100,
        ciGreen: true,
        actor: 'human-reviewer',
      }, {
        notifyFn: async (alert) => notices.push(alert),
      });
      assert.strictEqual(result.verdict, 'blocked_protected', `${label} should block`);
      assert.strictEqual(result.mergeEligible, false);
      assert.strictEqual(result.protectedMatches.length, 1);
      assert.strictEqual(notices.length, 1);
    }

    const eligible = await gate.evaluatePrAutomergeGate({
      prNumber: 11,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 90,
      ciGreen: true,
      actor: 'alexlee',
    });
    assert.strictEqual(eligible.mergeEligible, true);
    assert.strictEqual(eligible.verdict, 'merge_noop');
    assert.strictEqual(eligible.mergeResult.merged, false);
    assert.strictEqual(eligible.mergeResult.reason, 'automerge_disabled');

    const botActor = await gate.evaluatePrAutomergeGate({
      prNumber: 12,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 100,
      ciGreen: true,
      actor: 'github-actions[bot]',
    });
    assert.strictEqual(botActor.verdict, 'blocked_self_trigger');

    const budget = await gate.evaluatePrAutomergeGate({
      prNumber: 13,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 100,
      ciGreen: true,
      actor: 'alexlee',
      maxBudgetUsd: 1,
      cycleBudgetReport: {
        skipped: false,
        ok: false,
        metrics: { costUsd: 1.5 },
        blockers: [{ type: 'cost_budget', costUsd: 1.5, limit: 1 }],
      },
    });
    assert.strictEqual(budget.verdict, 'blocked_budget');
    assert.strictEqual(budget.budgetBlockers.length >= 1, true);

    let mergeCalls = 0;
    const underThreshold = await gate.evaluatePrAutomergeGate({
      prNumber: 14,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 89,
      ciGreen: true,
      actor: 'alexlee',
    }, {
      mergePR: () => { mergeCalls += 1; return { ok: true, merged: true }; },
    });
    assert.strictEqual(underThreshold.verdict, 'blocked_threshold');
    assert.strictEqual(mergeCalls, 0);

    const ciRed = await gate.evaluatePrAutomergeGate({
      prNumber: 15,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 100,
      ciGreen: false,
      actor: 'alexlee',
    }, {
      mergePR: () => { mergeCalls += 1; return { ok: true, merged: true }; },
    });
    assert.strictEqual(ciRed.verdict, 'blocked_ci');
    assert.strictEqual(mergeCalls, 0);

    const mergeFailureNotices = [];
    const mergeFailure = await gate.evaluatePrAutomergeGate({
      prNumber: 16,
      changedFiles: ['bots/claude/lib/safe-helper.ts'],
      score: 100,
      ciGreen: true,
      actor: 'alexlee',
    }, {
      mergePR: () => ({ ok: false, merged: false, error: 'gh failed' }),
      notifyFn: async (alert) => mergeFailureNotices.push(alert),
    });
    assert.strictEqual(mergeFailure.verdict, 'merge_failed');
    assert.strictEqual(mergeFailure.blockedReason, 'merge_failed');
    assert.strictEqual(mergeFailure.mergeEligible, true);
    assert.strictEqual(mergeFailureNotices.length, 1);

    const rollbackSkipped = await gate.maybeCreateRollbackRevertPR({
      mergeResult: { merged: false, reason: 'automerge_disabled' },
      postMergeFailure: { reason: 'dexter_failed' },
    });
    assert.strictEqual(rollbackSkipped.skipped, true);
    assert.strictEqual(rollbackSkipped.reason, 'merge_not_applied');

    let rollbackCalled = false;
    const rollback = await gate.maybeCreateRollbackRevertPR({
      mergeResult: { merged: true },
      postMergeFailure: { reason: 'dexter_failed' },
      mergeCommit: 'abc1234',
      branch: 'claude/revert-abc123',
    }, {
      createRevertPR: (input) => {
        rollbackCalled = true;
        assert.strictEqual(input.mergeCommit, 'abc1234');
        return { ok: true, prNumber: 99 };
      },
    });
    assert.strictEqual(rollbackCalled, true);
    assert.strictEqual(rollback.ok, true);

    console.log(JSON.stringify({
      ok: true,
      checked: [
        'protected_blocks',
        'env_off_merge_noop',
        'self_trigger_block',
        'budget_block',
        'threshold_and_ci_no_merge',
        'merge_failure_fail_closed',
        'rollback_revert_gate',
      ],
    }, null, 2));
  } finally {
    if (originalAutomerge === undefined) delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
    else process.env.CLAUDE_PR_AUTOMERGE_ENABLED = originalAutomerge;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

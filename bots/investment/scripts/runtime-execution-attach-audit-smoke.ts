#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildExecutionAttachDecision,
  getExecutionAttachMeta,
  summarizeExecutionAttachRows,
} from './runtime-execution-attach-audit.ts';

function row({ status = 'complete', missing = [], executionAttach = null } = {}) {
  return {
    score: { status, score: status === 'complete' ? 100 : 55, missing },
    executionAttach,
    envelope: {
      linkage: {
        hasTrade: true,
        hasJournal: true,
        hasStrategyProfile: status === 'complete',
        hasStrategyRoute: true,
        hasExecutionPlan: true,
        hasResponsibilityPlan: true,
        hasRegime: true,
      },
      strategy: {
        setupType: status === 'complete' ? 'breakout' : 'unattributed_execution_tracking',
      },
    },
  };
}

export function runExecutionAttachAuditSmoke() {
  const parsedAttach = getExecutionAttachMeta({
    block_meta: JSON.stringify({
      executionAttach: {
        ok: false,
        status: 'error',
        error: 'missing open position',
      },
    }),
  });
  assert.equal(parsedAttach?.status, 'error');

  const summary = summarizeExecutionAttachRows([
    row({ executionAttach: { ok: true, status: 'attached' } }),
    row({
      status: 'partial',
      missing: ['strategyProfile', 'signal', 'agentConsensus'],
      executionAttach: { ok: false, status: 'error' },
    }),
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.attachTrackedCount, 2);
  assert.equal(summary.attachOkCount, 1);
  assert.equal(summary.attachErrorCount, 1);
  assert.equal(summary.byAttachStatus.attached, 1);
  assert.equal(summary.byAttachStatus.error, 1);

  const decision = buildExecutionAttachDecision(summary, { days: 7, limit: 25, exchange: 'binance' });
  assert.equal(decision.status, 'execution_attach_error');
  assert.match(decision.headline, /실패/);
  assert.match(decision.actionItems.join('\n'), /execution attach 실패 1건/);
  assert.match(decision.backfillDryRunCommand, /runtime:execution-attach-backfill/);
  assert.match(decision.backfillDryRunCommand, /--exchange=binance/);

  const recovered = summarizeExecutionAttachRows([
    row({ status: 'partial', missing: ['strategyProfile', 'signal', 'agentConsensus'] }),
  ]);
  assert.equal(buildExecutionAttachDecision(recovered).status, 'execution_attach_recovered_partial');

  const actionable = summarizeExecutionAttachRows([
    row({ status: 'partial', missing: ['executionPlan'] }),
  ]);
  const actionableDecision = buildExecutionAttachDecision(actionable, { days: 7, limit: 25 });
  assert.equal(actionableDecision.status, 'execution_attach_partial');
  assert.match(actionableDecision.actionItems.join('\n'), /복구 후보 확인/);
  assert.match(actionableDecision.backfillWriteCommand, /--write/);

  return {
    ok: true,
    status: decision.status,
    attachTrackedCount: summary.attachTrackedCount,
    attachErrorCount: summary.attachErrorCount,
    recoveredStatus: buildExecutionAttachDecision(recovered).status,
    actionableStatus: actionableDecision.status,
  };
}

async function main() {
  const result = runExecutionAttachAuditSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime execution attach audit smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime execution attach audit smoke 실패:',
  });
}

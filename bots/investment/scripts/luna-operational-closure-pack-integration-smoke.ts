#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaOperationalClosurePackFromReports } from '../shared/luna-operational-closure-pack.ts';

export async function runLunaOperationalClosurePackIntegrationSmoke() {
  const pack = buildLunaOperationalClosurePackFromReports({
    closure: {
      ok: false,
      operationalStatus: 'code_complete_operational_blocked',
      hardBlockers: ['reconcile:UTK/USDT:manual_ack_required', 'reconcile:LUNC/USDT:manual_reconcile_required'],
    },
    reconcile: {
      status: 'reconcile_blockers_present',
      summary: { total: 2, hard: 2 },
      blockers: [
        {
          id: 'sig-ack',
          symbol: 'UTK/USDT',
          action: 'BUY',
          blockCode: 'manual_reconcile_required',
          resolutionClass: 'manual_ack_required',
          severity: 'hard_block',
          identifiers: { clientOrderId: 'cid-ack', recoveryErrorCode: 'binance_order_lookup_not_found' },
        },
        {
          id: 'sig-manual',
          symbol: 'LUNC/USDT',
          action: 'BUY',
          blockCode: 'manual_reconcile_required',
          resolutionClass: 'manual_reconcile_required',
          severity: 'hard_block',
          identifiers: {},
        },
      ],
    },
    liveFire: { status: 'blocked', blockers: ['manual_reconcile_tasks:2'] },
    sevenDay: { pendingReasons: ['fired 1/5'] },
    fullIntegration: { outstandingTasks: ['skill_library 0건'] },
    busHygiene: {
      ok: true,
      status: 'agent_message_bus_hygiene_clear',
      before: {
        staleCount: 12,
        rows: [
          { to_agent: 'all', message_type: 'broadcast', stale_count: '5' },
          { to_agent: 'argos', message_type: 'query', stale_count: '7' },
        ],
      },
      action: { dryRun: true },
    },
    voyager: { status: 'pending_observation', pendingReason: 'insufficient_natural_data: reflexion 4/5' },
    curriculum: { status: 'curriculum_bootstrap_plan_ready', toCreate: 3, dryRun: true },
  });
  assert.equal(pack.status, 'operational_blocked');
  assert.equal(pack.manualTasks.length, 1);
  assert.equal(pack.safeAckCandidates.length, 1);
  assert.equal(pack.hygieneTasks[0].classification.safeExpire, 7);
  assert.equal(pack.hygieneTasks[0].classification.reviewRequired, 5);
  assert.equal(pack.curriculumTasks.length, 1);
  assert.ok(pack.pendingObservation.some((item) => item.includes('7day')));
  return { ok: true, pack };
}

async function main() {
  const result = await runLunaOperationalClosurePackIntegrationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna operational closure pack integration smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna operational closure pack integration smoke 실패:',
  });
}

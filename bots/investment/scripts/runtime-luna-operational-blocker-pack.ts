#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaOperationalClosurePackFromReports } from '../shared/luna-operational-closure-pack.ts';
import { buildLunaReconcileBlockerReport } from './luna-reconcile-blocker-report.ts';
import { buildLunaLiveFireFinalGate } from './luna-live-fire-final-gate.ts';
import { runLuna7DayReport } from './runtime-luna-7day-report.ts';
import { runLuna100PercentCompletionReport } from './runtime-luna-100-percent-completion-report.ts';
import { runAgentMessageBusHygiene } from './runtime-agent-message-bus-hygiene.ts';
import { runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { buildLunaFullIntegrationClosureGateFromReports } from './runtime-luna-full-integration-closure-gate.ts';
import { buildLunaReconcileEvidencePack } from './runtime-luna-reconcile-evidence-pack.ts';
import { buildLunaReconcileAckPreflight } from './luna-reconcile-ack-preflight.ts';
import { runLunaCurriculumBootstrap } from './runtime-luna-curriculum-bootstrap.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function buildLunaOperationalBlockerPack({
  exchange = 'binance',
  hours = 24,
  days = 7,
  validationFixture = false,
} = {}) {
  const [fullIntegration, reconcile, liveFire, sevenDay, busHygiene, voyager, reconcileEvidence, ackPreflight, curriculum] = await Promise.all([
    runLuna100PercentCompletionReport({ outputFile: null }),
    buildLunaReconcileBlockerReport({ exchange, hours }),
    buildLunaLiveFireFinalGate({ exchange, hours: Math.min(hours, 24), liveLookup: false, withPositionParity: true }),
    runLuna7DayReport({ days }),
    runAgentMessageBusHygiene({ staleHours: 6, limit: 100, apply: false, dryRun: true, suppressAlert: true }),
    runVoyagerSkillAutoExtractionVerify({ validationFixture }),
    buildLunaReconcileEvidencePack({ exchange, hours, limit: 100 }),
    buildLunaReconcileAckPreflight({ exchange, hours, limit: 100, liveLookup: false }),
    runLunaCurriculumBootstrap({ market: 'any', apply: false }),
  ]);
  const closure = buildLunaFullIntegrationClosureGateFromReports({
    fullIntegration,
    reconcile,
    liveFire,
    sevenDay,
    posttrade: { ok: true, status: 'not_rechecked_by_blocker_pack', blockers: [] },
    memory: { status: 'not_rechecked_by_blocker_pack', readiness: { blockers: [], warnings: [] } },
    busHygiene,
    voyager,
    reconcileEvidence,
    ackPreflight,
    curriculum,
  });
  return buildLunaOperationalClosurePackFromReports({
    closure,
    reconcile,
    liveFire,
    sevenDay,
    fullIntegration,
    busHygiene,
    voyager,
    curriculum,
    reconcileEvidence,
    ackPreflight,
  });
}

export async function runLunaOperationalBlockerPackSmoke() {
  const pack = buildLunaOperationalClosurePackFromReports({
    closure: {
      ok: false,
      codeComplete: true,
      operationalStatus: 'code_complete_operational_blocked',
      hardBlockers: ['reconcile:LUNC/USDT:manual_reconcile_required'],
    },
    reconcile: {
      status: 'reconcile_blockers_present',
      summary: { total: 3, hard: 2, acknowledged: 1 },
      blockers: [
        {
          id: 'sig-1',
          symbol: 'LUNC/USDT',
          action: 'BUY',
          blockCode: 'manual_reconcile_required',
          resolutionClass: 'manual_reconcile_required',
          severity: 'hard_block',
          identifiers: {},
        },
        {
          id: 'sig-2',
          symbol: 'UTK/USDT',
          action: 'BUY',
          blockCode: 'manual_reconcile_required',
          resolutionClass: 'manual_ack_required',
          severity: 'hard_block',
          identifiers: { clientOrderId: 'client-1', recoveryErrorCode: 'binance_order_lookup_not_found' },
        },
        {
          id: 'sig-3',
          symbol: 'BTC/USDT',
          blockCode: 'manual_reconcile_required',
          resolutionClass: 'acknowledged',
          severity: 'acknowledged',
          acked: true,
          reconcileAck: { ackedAt: '2026-01-01T00:00:00Z', ackedBy: 'smoke' },
        },
      ],
    },
    liveFire: { status: 'blocked', blockers: ['manual_reconcile_tasks:2'] },
    sevenDay: { pendingReasons: ['fired 1/5'] },
    fullIntegration: { outstandingTasks: ['skill_library 0건'] },
    busHygiene: { ok: true, status: 'agent_message_bus_hygiene_clear', before: { staleCount: 2, staleHours: 6, rows: [] }, action: { dryRun: true } },
    voyager: { status: 'pending_observation', pendingReason: 'insufficient_natural_data: reflexion 4/5', validationFixture: { fixtureUsed: true, productionSkillPromoted: false } },
    curriculum: { status: 'curriculum_bootstrap_plan_ready', toCreate: 1, dryRun: true },
  });
  assert.equal(pack.ok, false);
  assert.equal(pack.status, 'operational_blocked');
  assert.equal(pack.manualTasks.length, 1);
  assert.equal(pack.safeAckCandidates.length, 1);
  assert.equal(pack.safeAckCandidates[0].safeAck, false);
  assert.equal(pack.acknowledgedHistory.length, 1);
  assert.equal(pack.hygieneTasks.length, 1);
  assert.equal(pack.curriculumTasks.length, 1);
  assert.ok(pack.pendingObservation.some((item) => item.includes('7day')));
  return { ok: true, pack };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const result = smoke ? await runLunaOperationalBlockerPackSmoke() : await buildLunaOperationalBlockerPack({
    exchange: argValue('--exchange', 'binance'),
    hours: Number(argValue('--hours', 24)),
    days: Number(argValue('--days', 7)),
    validationFixture: hasFlag('--validation-fixture'),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna operational blocker pack smoke ok');
  else {
    console.log(`${result.status} ok=${result.ok}`);
    console.log(`manualTasks=${result.manualTasks.length} safeAckCandidates=${result.safeAckCandidates.length} hygieneTasks=${result.hygieneTasks.length}`);
    console.log(`next=${result.nextActions[0] || 'none'}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna operational blocker pack 실패:',
  });
}

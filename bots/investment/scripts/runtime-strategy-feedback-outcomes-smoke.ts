#!/usr/bin/env node
// @ts-nocheck

import {
  aggregateStrategyFeedbackOutcomeRows,
  buildDecision,
  normalizeStrategyFeedbackOutcomeRow,
} from './runtime-strategy-feedback-outcomes.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildSyntheticRawRows() {
  return [
    {
      execution_kind: 'partial_adjust',
      incident_link: 'partial_adjust:profit_lock_candidate:family_bias=downweight_by_win_rate:family=momentum_rotation:winRate=24.2:avgPnl=33.3',
      strategy_family: 'momentum_rotation',
      total: 2,
      closed: 2,
      wins: 1,
      avg_pnl_percent: '1.5',
      pnl_net: '12.5',
      latest_created_at: 100,
    },
    {
      execution_kind: 'partial_adjust',
      incident_link: 'partial_adjust:profit_lock_candidate:family_bias=downweight_by_win_rate:family=momentum_rotation:winRate=26.1:avgPnl=30.2',
      strategy_family: 'momentum_rotation',
      total: 1,
      closed: 1,
      wins: 0,
      avg_pnl_percent: '-3',
      pnl_net: '-4',
      latest_created_at: 200,
    },
    {
      execution_kind: 'strategy_exit',
      incident_link: 'strategy_exit:strategy_break:family_bias=downweight_by_pnl:family=breakout:winRate=20:avgPnl=-4',
      strategy_family: 'breakout',
      total: 1,
      closed: 1,
      wins: 0,
      avg_pnl_percent: '-5',
      pnl_net: '-7',
      latest_created_at: 150,
    },
  ];
}

export function runStrategyFeedbackOutcomeSmoke() {
  const rows = aggregateStrategyFeedbackOutcomeRows(
    buildSyntheticRawRows().map(normalizeStrategyFeedbackOutcomeRow),
  );
  const momentum = rows.find((row) =>
    row.familyBias === 'downweight_by_win_rate'
    && row.family === 'momentum_rotation'
    && row.executionKind === 'partial_adjust',
  );
  const breakout = rows.find((row) =>
    row.familyBias === 'downweight_by_pnl'
    && row.family === 'breakout'
    && row.executionKind === 'strategy_exit',
  );

  assert(rows.length === 2, `expected 2 normalized buckets, got ${rows.length}`);
  assert(momentum, 'missing normalized momentum partial-adjust bucket');
  assert(momentum.total === 3, `expected momentum total 3, got ${momentum.total}`);
  assert(momentum.closed === 3, `expected momentum closed 3, got ${momentum.closed}`);
  assert(momentum.wins === 1, `expected momentum wins 1, got ${momentum.wins}`);
  assert(Math.abs(momentum.avgPnlPercent - 0) < 0.0001, `expected weighted avg pnl 0, got ${momentum.avgPnlPercent}`);
  assert(Math.abs(momentum.pnlNet - 8.5) < 0.0001, `expected pnl net 8.5, got ${momentum.pnlNet}`);
  assert(momentum.latestCreatedAt === 200, `expected latestCreatedAt 200, got ${momentum.latestCreatedAt}`);
  assert(breakout?.avgPnlPercent === -5, `expected breakout avg -5, got ${breakout?.avgPnlPercent}`);

  const waiting = buildDecision([], {
    feedbackSignals: 0,
    taggedFeedbackSignals: 0,
    taggedTrades: 0,
    taggedJournals: 0,
    activeFeedbackCandidates: 2,
  });
  const telemetryGap = buildDecision([], {
    feedbackSignals: 1,
    taggedFeedbackSignals: 1,
    taggedTrades: 1,
    taggedJournals: 0,
    activeFeedbackCandidates: 0,
  });

  assert(
    waiting.status === 'strategy_feedback_outcome_waiting_execution',
    `expected waiting execution status, got ${waiting.status}`,
  );
  assert(
    telemetryGap.status === 'strategy_feedback_outcome_telemetry_gap',
    `expected telemetry gap status, got ${telemetryGap.status}`,
  );

  return {
    ok: true,
    buckets: rows.length,
    waitingStatus: waiting.status,
    telemetryGapStatus: telemetryGap.status,
    rows,
  };
}

async function main() {
  const result = runStrategyFeedbackOutcomeSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`strategy feedback outcome smoke ok: ${result.buckets} buckets`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ strategy feedback outcome smoke 실패:',
  });
}

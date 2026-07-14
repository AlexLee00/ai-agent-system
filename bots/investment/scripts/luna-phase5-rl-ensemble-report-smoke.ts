#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  RL_ENSEMBLE_REPORT_SQL,
  buildMatchedTradeOutcomesSql,
  buildRlEnsembleReport,
} from './luna-phase5-rl-ensemble-report.ts';
import {
  buildLunaOutcomeSelectionSql,
  isolateLunaOutcomeOutliers,
} from '../shared/luna-data-contracts.ts';
import * as db from '../shared/db/core.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES } from './luna-data-contract-boundary-fixtures.ts';

function fixtureRows() {
  return Array.from({ length: 40 }, (_, index) => {
    const joined = index < 37;
    const model = index < 32 ? 'model-a' : 'model-b';
    const action = index % 3 === 0 ? 'sell' : 'buy';
    const realizedReward = joined ? (action === 'buy' ? 0.2 : -0.15) : null;
    return {
      id: index + 1,
      symbol: 'BTC/USDT',
      observed_at: `2026-07-13T00:00:${String(index).padStart(2, '0')}.000Z`,
      ensemble_model: model,
      action_type: action,
      action_size_pct: 0.1,
      reward_estimate: action === 'buy' ? 0.18 : -0.12,
      algorithm_votes: [
        { algorithm: 'ppo', action, score: action === 'buy' ? 0.16 : -0.1 },
        { algorithm: 'dqn', action: 'hold', score: 0 },
      ],
      outcome_source: joined ? 'trade_journal' : null,
      outcome_unit: joined ? 'return_fraction' : null,
      actual_action_type: joined ? action : null,
      actual_action_size_pct: joined ? 0.12 : null,
      realized_reward: realizedReward,
      is_paper: joined,
      rl_source_exact: index < 2,
      entry_trigger_signal_exact: index < 3,
    };
  });
}

export async function runLunaPhase5RlEnsembleReportSmoke() {
  assert.doesNotMatch(RL_ENSEMBLE_REPORT_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
  assert.doesNotMatch(RL_ENSEMBLE_REPORT_SQL, /(?:entry_time|executed_at|candle_ts)[^\n]*= e\.observed_at/);
  assert.match(RL_ENSEMBLE_REPORT_SQL, /outcomeLineage'->>'tradeJournalId/);
  assert.match(RL_ENSEMBLE_REPORT_SQL, /outcomeLineage'->>'tradeId/);
  assert.match(RL_ENSEMBLE_REPORT_SQL, /outcomeLineage'->>'strategySignalId/);
  assert.match(RL_ENSEMBLE_REPORT_SQL, /outcomeLineage'->>'entryTriggerId/);
  assert.match(RL_ENSEMBLE_REPORT_SQL, /ORDER BY e\.observed_at DESC, e\.id DESC/);
  const candidateRecordsetSql = `
    SELECT candidate_key, priority, outcome_source, actual_action_type,
           actual_action_size_pct, realized_reward, outcome_unit, is_paper
      FROM jsonb_to_recordset($1::jsonb) AS candidate(
        candidate_key text,
        priority integer,
        outcome_source text,
        actual_action_type text,
        actual_action_size_pct double precision,
        realized_reward double precision,
        outcome_unit text,
        is_paper boolean
      )
  `;
  const ambiguousSelection = await db.query(
    buildLunaOutcomeSelectionSql(candidateRecordsetSql),
    [JSON.stringify(LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.ambiguousOutcomeCandidates)],
  );
  assert.equal(ambiguousSelection[0].outcome_status, 'ambiguous_key_excluded');
  assert.equal(ambiguousSelection[0].outcome_source, null);
  assert.equal(ambiguousSelection[0].outcome_candidate_count, 2);
  const uniqueSelection = await db.query(
    buildLunaOutcomeSelectionSql(candidateRecordsetSql),
    [JSON.stringify(LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.uniqueOutcomeCandidates)],
  );
  assert.equal(uniqueSelection[0].outcome_status, 'matched');
  assert.equal(uniqueSelection[0].outcome_source, 'trade_journal');
  assert.equal(uniqueSelection[0].outcome_candidate_count, 1);
  const ambiguousReport = buildRlEnsembleReport([{
    id: 'ambiguous-1',
    outcome_status: 'ambiguous_key_excluded',
    outcome_candidate_count: 2,
  }]);
  assert.equal(ambiguousReport.joinAudit.joinableRows, 0);
  assert.equal(ambiguousReport.joinAudit.ambiguousKeyExcludedRows, 1);
  const partialCloseReport = buildRlEnsembleReport([{
    id: 'partial-close-1',
    trades_partial_close_excluded: true,
  }]);
  assert.equal(partialCloseReport.joinAudit.partialCloseExcludedRows, 1);

  const rawJoinRows = await db.query(`
    WITH raw_trades AS (
      SELECT id, signal_id, symbol, side, paper, exchange, executed_at::timestamp,
             realized_pnl_pct, matched_buy_id, amount
        FROM jsonb_to_recordset($1::jsonb) AS trade(
          id text,
          signal_id text,
          symbol text,
          side text,
          paper boolean,
          exchange text,
          executed_at text,
          realized_pnl_pct double precision,
          matched_buy_id text,
          amount double precision
        )
    ), matched_trade_outcomes AS (
      ${buildMatchedTradeOutcomesSql('raw_trades')}
    )
    SELECT entry_trade_id, actual_action_type, realized_reward, outcome_trade_id,
           outcome_unit, outcome_status
      FROM matched_trade_outcomes
     WHERE actual_action_type = 'buy'
     ORDER BY entry_trade_id
  `, [JSON.stringify(LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.tradeOutcomeRows)]);
  assert.equal(rawJoinRows.length, 4);
  const partialOutcome = rawJoinRows.find((row) => row.entry_trade_id === 'buy-partial');
  const unitOutcome = rawJoinRows.find((row) => row.entry_trade_id === 'buy-unit');
  assert.equal(unitOutcome.realized_reward, 0.05);
  assert.equal(unitOutcome.outcome_trade_id, 'sell-unit');
  assert.ok(Math.abs(partialOutcome.realized_reward - 0.01) < 1e-12);
  assert.equal(partialOutcome.outcome_trade_id, 'sell-partial-1,sell-partial-2');
  const incompleteOutcome = rawJoinRows.find((row) => row.entry_trade_id === 'buy-incomplete');
  assert.equal(incompleteOutcome.realized_reward, null);
  assert.equal(incompleteOutcome.outcome_status, 'partial_close_excluded');
  const multiLotOutcome = rawJoinRows.find((row) => row.entry_trade_id === 'buy-multi-1');
  assert.equal(multiLotOutcome.realized_reward, null);
  assert.equal(multiLotOutcome.outcome_unit, 'return_fraction');
  assert.equal(multiLotOutcome.outcome_status, 'multi_lot_excluded');

  const report = buildRlEnsembleReport(fixtureRows(), { minGroupN: 30 });
  assert.equal(Object.keys(report)[0], 'joinAudit');
  assert.equal(report.joinAudit.totalRows, 40);
  assert.equal(report.joinAudit.joinableRows, 37);
  assert.equal(report.joinAudit.unjoinableRows, 3);
  assert.equal(report.joinAudit.sourceMatches.trade_journal, 37);
  assert.equal(report.joinAudit.entryTriggerSignalExactRows, 3);
  assert.equal(report.overall.status, undefined);
  assert.equal(report.overall.rewardError, undefined);
  assert.equal(report.overall.policyScoreEvaluation.unit_mismatch, 'policy_score');
  assert.equal(report.overall.policyScoreEvaluation.byOutcomeUnit.length, 1);
  assert.equal(report.overall.policyScoreEvaluation.byOutcomeUnit[0].outcome_unit, 'return_fraction');
  assert.equal(report.overall.policyScoreEvaluation.byOutcomeUnit[0].spearmanRankCorrelation, 1);
  assert.equal(report.overall.policyScoreEvaluation.byOutcomeUnit[0].directionMatchRate, 1);
  assert.deepEqual(report.overall.outcomeUnitStatuses, [{
    outcome_unit: 'return_fraction',
    n: 37,
    status: 'sufficient',
  }]);
  assert.equal(
    report.byEnsembleModel.find((row) => row.group === 'model-a')
      .policyScoreEvaluation.byOutcomeUnit[0].status,
    'sufficient',
  );
  assert.equal(
    report.byEnsembleModel.find((row) => row.group === 'model-b')
      .policyScoreEvaluation.byOutcomeUnit[0].status,
    'insufficient',
  );
  assert.equal(
    report.byAlgorithmVote.find((row) => row.group === 'ppo')
      .policyScoreEvaluation.byOutcomeUnit[0].status,
    'sufficient',
  );
  assert.ok(report.summary.includes('exact join'));

  const mixedUnits = buildRlEnsembleReport(
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.mixedOutcomeRows,
    { minGroupN: 2 },
  );
  assert.deepEqual(
    mixedUnits.overall.policyScoreEvaluation.byOutcomeUnit.map((row) => row.outcome_unit),
    ['r_multiple', 'return_fraction'],
  );
  assert.equal(mixedUnits.overall.policyScoreEvaluation.byOutcomeUnit.every((row) => row.n === 2), true);
  assert.equal(mixedUnits.overall.policyScoreEvaluation.byOutcomeUnit.every((row) => row.spearmanRankCorrelation === 1), true);

  const outlierIsolation = isolateLunaOutcomeOutliers(
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.outlierOutcomeRows,
  );
  assert.deepEqual(
    outlierIsolation.excluded.map((row) => row.id).sort(),
    ['fraction-7', 'r-7'],
  );
  assert.equal(outlierIsolation.audit.excludedRows, 2);
  assert.equal(outlierIsolation.audit.byOutcomeUnit.every((row) => row.excludedRows === 1), true);
  const outlierReport = buildRlEnsembleReport(
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.outlierOutcomeRows,
    { minGroupN: 5 },
  );
  assert.equal(outlierReport.joinAudit.outlierExcludedRows, 2);
  assert.equal(outlierReport.overall.rawOutcomeN, 14);
  assert.equal(outlierReport.overall.n, 12);

  const zeroMadIsolation = isolateLunaOutcomeOutliers(
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.zeroMadOutlierOutcomeRows,
  );
  assert.deepEqual(
    zeroMadIsolation.excluded.map((row) => row.id),
    ['zero-mad-outlier'],
  );
  assert.equal(zeroMadIsolation.audit.excludedRows, 1);
  assert.equal(zeroMadIsolation.audit.byOutcomeUnit[0].mad, 0);
  const zeroMadReport = buildRlEnsembleReport(
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.zeroMadOutlierOutcomeRows,
    { minGroupN: 5 },
  );
  assert.equal(zeroMadReport.joinAudit.outlierExcludedRows, 1);
  assert.equal(zeroMadReport.overall.rawOutcomeN, 6);
  assert.equal(zeroMadReport.overall.n, 5);

  const splitGateRows = [
    ...Array.from({ length: 15 }, (_, index) => ({
      reward_estimate: index + 1,
      realized_reward: index + 1,
      outcome_unit: 'r_multiple',
      outcome_source: 'luna_strategy_signal_outcomes',
    })),
    ...Array.from({ length: 15 }, (_, index) => ({
      reward_estimate: (index + 1) / 100,
      realized_reward: (index + 1) / 100,
      outcome_unit: 'return_fraction',
      outcome_source: 'trades',
    })),
  ];
  const splitGate = buildRlEnsembleReport(splitGateRows, { minGroupN: 30 });
  assert.equal(splitGate.overall.n, 30);
  assert.equal(splitGate.overall.status, undefined);
  assert.deepEqual(
    splitGate.overall.outcomeUnitStatuses,
    [
      { outcome_unit: 'r_multiple', n: 15, status: 'insufficient' },
      { outcome_unit: 'return_fraction', n: 15, status: 'insufficient' },
    ],
  );

  const insufficient = buildRlEnsembleReport(fixtureRows().slice(0, 10), { minGroupN: 30 });
  assert.equal(insufficient.overall.policyScoreEvaluation.byOutcomeUnit[0].status, 'insufficient');
  return {
    ok: true,
    totalRows: report.joinAudit.totalRows,
    joinableRows: report.joinAudit.joinableRows,
    sufficientModel: 'model-a',
    insufficientModel: 'model-b',
  };
}

async function main() {
  console.log(JSON.stringify(await runLunaPhase5RlEnsembleReportSmoke(), null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna phase5 RL ensemble report smoke failed:',
  });
}

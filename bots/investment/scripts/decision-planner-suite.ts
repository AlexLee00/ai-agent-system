// @ts-nocheck
import { createPipelineSession, recordNodeResult } from '../shared/node-runner.ts';
import { getNodeRuns } from '../shared/pipeline-db.ts';
import { getInvestmentNode } from '../nodes/index.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';
import { buildDecisionBridgeMeta, loadDecisionPlannerCompact } from '../shared/pipeline-decision-runner.ts';

const DEFAULT_CASES = [
  { market: 'binance', symbol: 'BTC/USDT', researchOnly: true, regime: 'volatile', atrRatio: 0.03, fearGreed: 88, volumeRatio: 1.2, consecutiveLosses: 0, symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] },
  { market: 'kis', symbol: '005930', researchOnly: false, regime: 'ranging', atrRatio: 0.012, fearGreed: 52, volumeRatio: 0.9, consecutiveLosses: 0, symbols: ['005930', '000660', '035420'] },
  { market: 'kis_overseas', symbol: 'AAPL', researchOnly: false, regime: 'trending_bull', atrRatio: 0.02, fearGreed: 60, volumeRatio: 1.1, consecutiveLosses: 1, symbols: ['AAPL', 'TSM', 'MU'] },
];

async function runCase(input) {
  const l01Node = getInvestmentNode('L01');
  const l10Node = getInvestmentNode('L10');
  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market: input.market,
    symbols: input.symbols,
    triggerType: 'manual',
    triggerRef: 'decision-planner-suite',
    meta: {
      runner: 'decision-planner-suite',
      suite_market: input.market,
    },
  });

  const plannerContext = buildPreScreenPlannerContext({
    market: input.market,
    researchOnly: Boolean(input.researchOnly),
    regimeSnapshot: { regime: input.regime, atrRatio: input.atrRatio },
    runtimeSignals: {
      fearGreed: input.fearGreed,
      volumeRatio: input.volumeRatio,
      consecutiveLosses: input.consecutiveLosses,
    },
  });

  await recordNodeResult(l01Node, {
    sessionId,
    market: input.market,
    meta: { runner: 'decision-planner-suite', synthetic: true },
    storeArtifact: false,
  }, {
    market: input.market,
    source: 'decision_planner_suite',
    symbols: input.symbols,
    planner_context: plannerContext,
  });

  const plannerCompact = await loadDecisionPlannerCompact(sessionId);
  const bridgeMeta = await buildDecisionBridgeMeta({
    sessionId,
    market: input.market,
    symbol: input.symbol,
    stage: 'fusion',
    planner: plannerCompact,
  });

  await recordNodeResult(l10Node, {
    sessionId,
    market: input.market,
    symbol: input.symbol,
    meta: bridgeMeta,
    storeArtifact: false,
  }, {
    market: input.market,
    symbol: input.symbol,
    synthetic: true,
    planner_compact: plannerCompact,
  });

  const nodeRuns = await getNodeRuns(sessionId);
  const l10Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L10');
  return {
    sessionId,
    market: input.market,
    symbol: input.symbol,
    plannerCompact,
    plannerInMeta: Boolean(l10Run?.metadata?.planner),
    stage: l10Run?.metadata?.stage || null,
  };
}

async function main() {
  const results = [];
  for (const item of DEFAULT_CASES) {
    results.push(await runCase(item));
  }

  const summary = {
    total: results.length,
    passed: results.filter((row) => row.plannerCompact && row.plannerInMeta).length,
    failed: results.filter((row) => !(row.plannerCompact && row.plannerInMeta)).length,
  };

  const payload = {
    ok: summary.failed === 0,
    summary,
    results,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Decision planner suite: ${summary.passed}/${summary.total}`);
  for (const row of results) {
    console.log(`${row.market} | ${row.symbol} | planner=${row.plannerCompact ? 'ok' : 'missing'} | meta=${row.plannerInMeta ? 'ok' : 'missing'} | stage=${row.stage || 'n/a'}`);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});

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
  const l14Node = getInvestmentNode('L14');
  const l21Node = getInvestmentNode('L21');
  const l30Node = getInvestmentNode('L30');
  const l32Node = getInvestmentNode('L32');
  const l33Node = getInvestmentNode('L33');
  const l34Node = getInvestmentNode('L34');
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

  await recordNodeResult(l14Node, {
    sessionId,
    market: input.market,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: input.market,
      stage: 'portfolio',
      planner: plannerCompact,
    }),
    storeArtifact: false,
  }, {
    market: input.market,
    synthetic: true,
    planner_compact: plannerCompact,
    portfolioDecision: {
      decisions: [
        {
          symbol: input.symbol,
          action: 'BUY',
          confidence: 0.62,
          amount_usdt: input.market === 'binance' ? 100 : 500,
          reasoning: 'synthetic portfolio decision',
        },
      ],
      portfolio_view: 'synthetic',
      risk_level: 'LOW',
    },
  });

  await recordNodeResult(l21Node, {
    sessionId,
    market: input.market,
    symbol: input.symbol,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: input.market,
      symbol: input.symbol,
      stage: 'risk',
      planner: plannerCompact,
    }),
    storeArtifact: false,
  }, {
    market: input.market,
    symbol: input.symbol,
    synthetic: true,
    planner_compact: plannerCompact,
    risk: {
      approved: true,
      adjustedAmount: input.market === 'binance' ? 100 : 500,
      reason: null,
    },
  });

  for (const node of [l30Node, l32Node, l33Node, l34Node]) {
    await recordNodeResult(node, {
      sessionId,
      market: input.market,
      symbol: input.symbol,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: input.market,
        symbol: input.symbol,
        stage: node.id === 'L34' ? 'journal' : 'execute',
        planner: plannerCompact,
      }),
      storeArtifact: false,
    }, {
      market: input.market,
      symbol: input.symbol,
      synthetic: true,
      planner_compact: plannerCompact,
      node_id: node.id,
    });
  }

  const nodeRuns = await getNodeRuns(sessionId);
  const l10Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L10');
  const l14Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L14');
  const l21Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L21');
  const l30Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L30');
  const l32Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L32');
  const l33Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L33');
  const l34Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L34');
  return {
    sessionId,
    market: input.market,
    symbol: input.symbol,
    plannerCompact,
    l10PlannerInMeta: Boolean(l10Run?.metadata?.planner),
    l14PlannerInMeta: Boolean(l14Run?.metadata?.planner),
    l21PlannerInMeta: Boolean(l21Run?.metadata?.planner),
    l30PlannerInMeta: Boolean(l30Run?.metadata?.planner),
    l32PlannerInMeta: Boolean(l32Run?.metadata?.planner),
    l33PlannerInMeta: Boolean(l33Run?.metadata?.planner),
    l34PlannerInMeta: Boolean(l34Run?.metadata?.planner),
    stages: {
      l10: l10Run?.metadata?.stage || null,
      l14: l14Run?.metadata?.stage || null,
      l21: l21Run?.metadata?.stage || null,
      l30: l30Run?.metadata?.stage || null,
      l32: l32Run?.metadata?.stage || null,
      l33: l33Run?.metadata?.stage || null,
      l34: l34Run?.metadata?.stage || null,
    },
  };
}

async function main() {
  const results = [];
  for (const item of DEFAULT_CASES) {
    results.push(await runCase(item));
  }

  const summary = {
    total: results.length,
    passed: results.filter((row) => row.plannerCompact && row.l10PlannerInMeta && row.l14PlannerInMeta && row.l21PlannerInMeta && row.l30PlannerInMeta && row.l32PlannerInMeta && row.l33PlannerInMeta && row.l34PlannerInMeta).length,
    failed: results.filter((row) => !(row.plannerCompact && row.l10PlannerInMeta && row.l14PlannerInMeta && row.l21PlannerInMeta && row.l30PlannerInMeta && row.l32PlannerInMeta && row.l33PlannerInMeta && row.l34PlannerInMeta)).length,
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
    console.log(`${row.market} | ${row.symbol} | planner=${row.plannerCompact ? 'ok' : 'missing'} | l10=${row.l10PlannerInMeta ? 'ok' : 'missing'} | l14=${row.l14PlannerInMeta ? 'ok' : 'missing'} | l21=${row.l21PlannerInMeta ? 'ok' : 'missing'} | l30=${row.l30PlannerInMeta ? 'ok' : 'missing'} | l32=${row.l32PlannerInMeta ? 'ok' : 'missing'} | l33=${row.l33PlannerInMeta ? 'ok' : 'missing'} | l34=${row.l34PlannerInMeta ? 'ok' : 'missing'} | stages=${row.stages.l10 || 'n/a'}/${row.stages.l14 || 'n/a'}/${row.stages.l21 || 'n/a'}/${row.stages.l30 || 'n/a'}/${row.stages.l32 || 'n/a'}/${row.stages.l33 || 'n/a'}/${row.stages.l34 || 'n/a'}`);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});

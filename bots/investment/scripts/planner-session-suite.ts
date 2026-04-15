// @ts-nocheck
import { createPipelineSession } from '../shared/node-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';
import { buildPreScreenPlannerCompact } from '../shared/pre-screen-planner-report.ts';

const DEFAULT_CASES = [
  { market: 'binance', researchOnly: true, regime: 'volatile', atrRatio: 0.03, fearGreed: 88, volumeRatio: 1.2, consecutiveLosses: 0, symbolCount: 3 },
  { market: 'kis', researchOnly: false, regime: 'ranging', atrRatio: 0.012, fearGreed: 52, volumeRatio: 0.9, consecutiveLosses: 0, symbolCount: 3 },
  { market: 'kis_overseas', researchOnly: false, regime: 'trending_bull', atrRatio: 0.02, fearGreed: 60, volumeRatio: 1.1, consecutiveLosses: 1, symbolCount: 3 },
];

function syntheticSymbols(market, count = 3) {
  const presets = {
    binance: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
    kis: ['005930', '000660', '035420', '047040'],
    kis_overseas: ['AAPL', 'TSM', 'MU', 'JBLU'],
  };
  return (presets[market] || ['BTC/USDT']).slice(0, count);
}

async function createPlannerSession(input) {
  const plannerContext = buildPreScreenPlannerContext({
    market: input.market,
    researchOnly: Boolean(input.researchOnly),
    regimeSnapshot: {
      regime: input.regime,
      atrRatio: input.atrRatio,
    },
    runtimeSignals: {
      fearGreed: input.fearGreed,
      volumeRatio: input.volumeRatio,
      consecutiveLosses: input.consecutiveLosses,
    },
  });

  const payload = {
    market: input.market,
    source: 'planner_session_suite',
    symbols: syntheticSymbols(input.market, input.symbolCount),
    planner_context: plannerContext,
  };
  const compact = buildPreScreenPlannerCompact(payload);
  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market: input.market,
    symbols: payload.symbols,
    triggerType: 'manual',
    triggerRef: 'planner-session-suite',
    meta: {
      runner: 'planner-session-suite',
      planner_market: compact.market || 'unknown',
      planner_time_mode: compact.timeMode || 'unknown',
      planner_trade_mode: compact.tradeMode || 'normal',
      planner_mode: compact.mode || 'unknown',
      planner_should_analyze: Boolean(compact.shouldAnalyze),
      planner_research_depth: Number(compact.researchDepth || 0),
      planner_skip_reason: compact.skipReason || null,
      planner_research_only: Boolean(compact.researchOnly),
      planner_symbol_count: Number(compact.symbolCount || 0),
    },
  });

  await finishPipelineRun(sessionId, {
    status: 'completed',
    meta: {
      completed_node: 'PLANNER_SUITE',
    },
  });

  return {
    sessionId,
    market: input.market,
    compact,
  };
}

async function main() {
  const results = [];
  for (const item of DEFAULT_CASES) {
    results.push(await createPlannerSession(item));
  }

  const payload = {
    ok: true,
    total: results.length,
    results,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Planner session suite: ${results.length}`);
  for (const row of results) {
    console.log(`${row.market} | mode=${row.compact.mode} | trade=${row.compact.tradeMode} | time=${row.compact.timeMode} | depth=${row.compact.researchDepth} | analyze=${row.compact.shouldAnalyze ? 'yes' : 'no'}`);
  }
}

main().catch((error) => {
  const payload = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.error(`planner-session-suite failed: ${payload.error}`);
  process.exitCode = 1;
});

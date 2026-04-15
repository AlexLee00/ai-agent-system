// @ts-nocheck
import { createPipelineSession } from '../shared/node-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';
import { buildPreScreenPlannerCompact, buildPreScreenPlannerReport } from '../shared/pre-screen-planner-report.ts';

function parseArgs(argv = []) {
  const args = {
    market: 'binance',
    researchOnly: false,
    regime: 'ranging',
    atrRatio: 0.02,
    fearGreed: 50,
    volumeRatio: 1,
    consecutiveLosses: 0,
    symbolCount: 3,
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--research-only') args.researchOnly = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || args.market);
    else if (raw.startsWith('--regime=')) args.regime = String(raw.split('=').slice(1).join('=') || args.regime);
    else if (raw.startsWith('--atr-ratio=')) args.atrRatio = Number(raw.split('=').slice(1).join('=') || args.atrRatio);
    else if (raw.startsWith('--fear-greed=')) args.fearGreed = Number(raw.split('=').slice(1).join('=') || args.fearGreed);
    else if (raw.startsWith('--volume-ratio=')) args.volumeRatio = Number(raw.split('=').slice(1).join('=') || args.volumeRatio);
    else if (raw.startsWith('--consecutive-losses=')) args.consecutiveLosses = Number(raw.split('=').slice(1).join('=') || args.consecutiveLosses);
    else if (raw.startsWith('--symbol-count=')) args.symbolCount = Math.max(1, Number(raw.split('=').slice(1).join('=') || args.symbolCount));
  }

  return args;
}

function buildSyntheticSymbols(market, count = 3) {
  const presets = {
    binance: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
    kis: ['005930', '000660', '035420', '047040'],
    kis_overseas: ['AAPL', 'TSM', 'MU', 'JBLU'],
  };
  return (presets[market] || ['BTC/USDT']).slice(0, count);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plannerContext = buildPreScreenPlannerContext({
    market: args.market,
    researchOnly: args.researchOnly,
    regimeSnapshot: {
      regime: args.regime,
      atrRatio: args.atrRatio,
    },
    runtimeSignals: {
      fearGreed: args.fearGreed,
      volumeRatio: args.volumeRatio,
      consecutiveLosses: args.consecutiveLosses,
    },
  });

  const payload = {
    market: args.market,
    source: 'planner_session_smoke',
    symbols: buildSyntheticSymbols(args.market, args.symbolCount),
    planner_context: plannerContext,
  };

  const compact = buildPreScreenPlannerCompact(payload);
  const report = buildPreScreenPlannerReport(payload);
  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market: args.market,
    symbols: payload.symbols,
    triggerType: 'manual',
    triggerRef: 'planner-session-smoke',
    meta: {
      runner: 'planner-session-smoke',
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
      completed_node: 'PLANNER_SMOKE',
      planner_report: report.text,
    },
  });

  const out = {
    ok: true,
    sessionId,
    compact,
    report,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`planner session smoke ok: ${sessionId}`);
  console.log(report.text);
}

main().catch((error) => {
  const payload = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.error(`planner-session-smoke failed: ${payload.error}`);
  process.exitCode = 1;
});

// @ts-nocheck
import { createPipelineSession, recordNodeResult } from '../shared/node-runner.ts';
import { getNodeRuns } from '../shared/pipeline-db.ts';
import { getInvestmentNode } from '../nodes/index.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';
import { buildDecisionBridgeMeta, loadDecisionPlannerCompact } from '../shared/pipeline-decision-runner.ts';

async function main() {
  const market = 'binance';
  const symbol = 'BTC/USDT';
  const l01Node = getInvestmentNode('L01');
  const l10Node = getInvestmentNode('L10');

  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market,
    symbols: [symbol],
    triggerType: 'manual',
    triggerRef: 'decision-planner-smoke',
    meta: {
      runner: 'decision-planner-smoke',
    },
  });

  const plannerContext = buildPreScreenPlannerContext({
    market,
    researchOnly: true,
    regimeSnapshot: { regime: 'volatile', atrRatio: 0.03 },
    runtimeSignals: { fearGreed: 88, volumeRatio: 1.2, consecutiveLosses: 0 },
  });

  const l01Payload = {
    market,
    source: 'decision_planner_smoke',
    symbols: [symbol, 'ETH/USDT', 'SOL/USDT'],
    planner_context: plannerContext,
  };

  await recordNodeResult(l01Node, {
    sessionId,
    market,
    meta: {
      runner: 'decision-planner-smoke',
      synthetic: true,
    },
    storeArtifact: false,
  }, l01Payload);

  const plannerCompact = await loadDecisionPlannerCompact(sessionId);
  const bridgeMeta = await buildDecisionBridgeMeta({
    sessionId,
    market,
    symbol,
    stage: 'fusion',
    planner: plannerCompact,
  });

  await recordNodeResult(l10Node, {
    sessionId,
    market,
    symbol,
    meta: bridgeMeta,
    storeArtifact: false,
  }, {
    symbol,
    market,
    synthetic: true,
    planner_compact: plannerCompact,
  });

  const nodeRuns = await getNodeRuns(sessionId);
  const l10Run = [...nodeRuns].reverse().find((row) => row.node_id === 'L10');

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    plannerCompact,
    bridgeMeta,
    l10Meta: l10Run?.metadata || null,
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});

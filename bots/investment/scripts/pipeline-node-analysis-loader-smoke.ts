#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  createPipelineRun,
  finishNodeRun,
  finishPipelineRun,
  startNodeRun,
} from '../shared/pipeline-db.ts';
import { loadAnalysesForSession } from '../nodes/helpers.ts';
import { shouldRunStockIntradayDecisionLlm } from '../shared/stock-intraday-llm-policy.ts';

export async function runPipelineNodeAnalysisLoaderSmoke() {
  const symbol = '005380';
  const sessionId = await createPipelineRun({
    pipeline: 'pipeline-node-analysis-loader-smoke',
    market: 'kis',
    symbols: [symbol],
    triggerType: 'smoke',
    meta: { smoke: true },
  });

  try {
    const technicalRunId = await startNodeRun({
      sessionId,
      nodeId: 'L02',
      nodeType: 'collect',
      symbol,
      metadata: { smoke: true },
    });
    await finishNodeRun(technicalRunId, {
      status: 'completed',
      metadata: {
        inline_payload: {
          signal: 'BUY',
          confidence: 0.4,
          reasoning: 'smoke technical presignal',
        },
      },
    });

    const marketFlowRunId = await startNodeRun({
      sessionId,
      nodeId: 'L04',
      nodeType: 'collect',
      symbol,
      metadata: { smoke: true },
    });
    await finishNodeRun(marketFlowRunId, {
      status: 'completed',
      metadata: {
        inline_payload: {
          analyses: [{
            symbol,
            analyst: 'market_flow',
            signal: 'BUY',
            confidence: 0.43,
            reasoning: 'smoke market flow presignal',
          }],
        },
      },
    });

    const loaded = await loadAnalysesForSession(sessionId, symbol, 'kis');
    const analysts = loaded.analyses.map((item) => item.analyst).sort();
    assert.equal(loaded.source, 'artifacts');
    assert.deepEqual(analysts, ['market_flow', 'ta_mtf']);

    const prefilter = shouldRunStockIntradayDecisionLlm({
      market: 'kis',
      symbol,
      analyses: loaded.analyses,
      env: {
        LUNA_STOCK_INTRADAY_DECISION_PREFILTER_ENABLED: 'true',
      },
    });
    assert.equal(prefilter.run, true);
    assert.equal(prefilter.reason, 'actionable_presignal');
    assert.equal(prefilter.support.role, 'flow');

    await finishPipelineRun(sessionId, {
      status: 'completed',
      meta: { smokeCompleted: true },
    });

    return {
      ok: true,
      smoke: 'pipeline-node-analysis-loader',
      sessionId,
      symbol,
      analysts,
      prefilter,
    };
  } catch (error) {
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: { smokeError: error?.message || String(error) },
    }).catch(() => null);
    throw error;
  }
}

async function main() {
  const result = await runPipelineNodeAnalysisLoaderSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('pipeline node analysis loader smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ pipeline node analysis loader smoke 실패:',
  });
}

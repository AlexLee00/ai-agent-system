// @ts-nocheck
import { getNodeRuns, getPipelineRun } from './pipeline-db.ts';
import { loadLatestNodePayload } from '../nodes/helpers.ts';
import { buildPreScreenPlannerCompact } from './pre-screen-planner-report.ts';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const elixirBridge = _require('../../../packages/core/lib/elixir-bridge');

export async function buildDecisionBridgeMeta({ sessionId, market, symbol = null, stage, regime = null, planner = null }) {
  const meta = { bridge: 'luna_orchestrate', stage };
  if (planner) meta.planner = planner;
  try {
    const bridgePayload = await elixirBridge.createOrchestrationBridgePayload({
      market,
      symbol,
      stage,
      sessionId,
      regime,
    });
    return {
      ...meta,
      bridge_payload: bridgePayload.serialized,
      bridge_payload_version: 1,
    };
  } catch (error) {
    return {
      ...meta,
      bridge_payload_error: error.message,
    };
  }
}

export async function loadDecisionPlannerCompact(sessionId) {
  let payload = null;
  const latest = await loadLatestNodePayload(sessionId, 'L01').catch(() => null);
  if (latest?.payload) {
    payload = latest.payload;
  } else {
    const runs = await getNodeRuns(sessionId).catch(() => []);
    const l01Run = [...runs]
      .filter((row) => row.node_id === 'L01')
      .sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0))[0];
    payload = l01Run?.metadata?.inline_payload || null;
  }
  if (!payload) {
    const pipelineRun = await getPipelineRun(sessionId).catch(() => null);
    if (pipelineRun?.meta?.planner_payload) {
      payload = pipelineRun.meta.planner_payload;
    } else if (pipelineRun?.meta?.planner_context) {
      payload = {
        market: pipelineRun?.market || 'unknown',
        symbols: Array.isArray(pipelineRun?.symbols) ? pipelineRun.symbols : [],
        source: 'pipeline_meta',
        planner_context: pipelineRun.meta.planner_context,
      };
    }
  }
  if (!payload) return null;
  const compact = buildPreScreenPlannerCompact(payload);
  if (!compact) return null;
  if (compact.market === 'unknown' && compact.timeMode === 'unknown' && compact.mode === 'unknown') {
    return null;
  }
  return compact;
}

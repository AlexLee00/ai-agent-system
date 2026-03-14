import { createPipelineSession, runNode } from './node-runner.js';
import { getInvestmentNode } from '../nodes/index.js';

const COLLECT_NODE_SETS = {
  binance: ['L06', 'L02', 'L03', 'L04', 'L05'],
  kis: ['L06', 'L02', 'L03', 'L04'],
  kis_overseas: ['L06', 'L02', 'L03', 'L04'],
};

const COLLECT_CONCURRENCY_LIMIT = {
  binance: 6,
  kis: 4,
  kis_overseas: 4,
};

export async function runMarketCollectPipeline({
  market,
  symbols,
  triggerType = 'cycle',
  triggerRef = null,
  meta = {},
} = {}) {
  const startedAt = Date.now();
  const nodeIds = COLLECT_NODE_SETS[market];
  if (!nodeIds) throw new Error(`지원하지 않는 market: ${market}`);

  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market,
    symbols,
    triggerType,
    triggerRef,
    meta,
  });

  const summaries = [];
  const portfolioNode = getInvestmentNode('L06');
  if (portfolioNode) {
    try {
      const result = await runNode(portfolioNode, {
        sessionId,
        market,
        meta: { stage: 'collect', ...meta },
      });
      summaries.push({ nodeId: 'L06', status: 'completed', symbol: null, outputRef: result.outputRef });
    } catch (err) {
      summaries.push({ nodeId: 'L06', status: 'failed', symbol: null, error: err.message });
    }
  }

  const perSymbolNodes = nodeIds.filter(nodeId => nodeId !== 'L06');
  const tasks = [];
  for (const symbol of symbols) {
    for (const nodeId of perSymbolNodes) {
      const node = getInvestmentNode(nodeId);
      if (!node) continue;
      tasks.push(async () => (
        runNode(node, {
          sessionId,
          market,
          symbol,
          meta: { stage: 'collect', ...meta },
          // Collect nodes already persist their real analysis into DB.
          // Skip RAG artifacts here to avoid search/store storms on wide universes.
          storeArtifact: false,
        }).then(result => ({
          nodeId,
          status: 'completed',
          symbol,
          outputRef: result.outputRef,
        })).catch(err => ({
          nodeId,
          status: 'failed',
          symbol,
          error: err.message,
        }))
      ));
    }
  }

  summaries.push(...await runWithConcurrencyLimit(tasks, COLLECT_CONCURRENCY_LIMIT[market] || 4));

  const totalTasks = tasks.length + (portfolioNode ? 1 : 0);
  const failedTasks = summaries.filter(item => item.status === 'failed').length;
  const metrics = {
    durationMs: Date.now() - startedAt,
    symbolCount: symbols.length,
    perSymbolNodeCount: perSymbolNodes.length,
    totalTasks,
    failedTasks,
    failureRate: totalTasks > 0 ? failedTasks / totalTasks : 0,
    concurrencyLimit: COLLECT_CONCURRENCY_LIMIT[market] || 4,
    ragArtifactsSkipped: tasks.length,
    overloadDetected: tasks.length >= 40,
    warnings: buildCollectWarnings({
      tasks,
      symbols,
      failedTasks,
      totalTasks,
      limit: COLLECT_CONCURRENCY_LIMIT[market] || 4,
    }),
  };

  return { sessionId, market, symbols, summaries, metrics };
}

export function summarizeNodeStatuses(summaries = []) {
  const counts = new Map();
  for (const item of summaries) {
    const key = `${item.nodeId}:${item.status}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(' | ');
}

export default {
  runMarketCollectPipeline,
  summarizeNodeStatuses,
};

async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function buildCollectWarnings({ tasks, symbols, failedTasks, totalTasks, limit }) {
  const warnings = [];
  if (symbols.length >= 20) warnings.push('wide_universe');
  if (tasks.length >= 40) warnings.push('collect_overload_detected');
  if (limit <= 4 && tasks.length >= 30) warnings.push('concurrency_guard_active');
  if (failedTasks > 0 && totalTasks > 0 && failedTasks / totalTasks >= 0.2) warnings.push('collect_failure_rate_high');
  return warnings;
}

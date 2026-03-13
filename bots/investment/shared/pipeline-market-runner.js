import { createPipelineSession, runNode } from './node-runner.js';
import { getInvestmentNode } from '../nodes/index.js';

const COLLECT_NODE_SETS = {
  binance: ['L06', 'L02', 'L03', 'L04', 'L05'],
  kis: ['L06', 'L02', 'L03', 'L04'],
  kis_overseas: ['L06', 'L02', 'L03', 'L04'],
};

export async function runMarketCollectPipeline({
  market,
  symbols,
  triggerType = 'cycle',
  triggerRef = null,
  meta = {},
} = {}) {
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
      tasks.push(
        runNode(node, {
          sessionId,
          market,
          symbol,
          meta: { stage: 'collect', ...meta },
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
      );
    }
  }

  summaries.push(...await Promise.all(tasks));
  return { sessionId, market, symbols, summaries };
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

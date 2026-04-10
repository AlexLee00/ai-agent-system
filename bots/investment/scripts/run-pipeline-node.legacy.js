import { finishPipelineRun, getNodeRuns, initPipelineSchema } from '../shared/pipeline-db.js';
import { createPipelineSession, runNode } from '../shared/node-runner.js';
import { getInvestmentNode, INVESTMENT_NODES } from '../nodes/index.js';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=');
    out[key] = rawValue === undefined ? true : rawValue;
  }
  return out;
}

function normalizeSymbols(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function usage() {
  console.log([
    'usage: node scripts/run-pipeline-node.js --node=L01 --market=binance [--symbol=BTC/USDT] [--symbols=A,B] [--trigger=manual]',
    `available nodes: ${INVESTMENT_NODES.map(node => node.id).join(', ')}`,
  ].join('\n'));
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const node = getInvestmentNode(args.node);
  const market = args.market || 'binance';
  const symbol = args.symbol || null;
  const symbols = normalizeSymbols(args.symbols);

  if (!node) {
    usage();
    throw new Error(`알 수 없는 node: ${args.node || '(없음)'}`);
  }

  if (!symbol && !symbols.length && ['L02', 'L03', 'L05'].includes(node.id)) {
    throw new Error(`${node.id}는 --symbol 필요`);
  }

  let sessionId = args['session-id'] || args.session_id || null;
  if (!sessionId) {
    sessionId = await createPipelineSession({
      pipeline: 'luna_pipeline',
      market,
      symbols: symbol ? [symbol] : symbols,
      triggerType: args.trigger || 'manual',
      triggerRef: args.trigger_ref || null,
      meta: {
        runner: 'run-pipeline-node',
        requested_node: node.id,
      },
    });
  } else {
    await initPipelineSchema();
  }

  let status = 'completed';
  try {
    const result = await runNode(node, {
      sessionId,
      market,
      symbol,
      meta: {
        symbols,
        trigger: args.trigger || 'manual',
      },
    });

    if (!args['session-id'] && !args.session_id) {
      await finishPipelineRun(sessionId, {
        status: 'completed',
        meta: {
          completed_node: node.id,
          output_ref: result.outputRef,
        },
      });
    }

    const nodeRuns = await getNodeRuns(sessionId);
    console.log(JSON.stringify({
      ok: true,
      session_id: sessionId,
      node_id: node.id,
      market,
      symbol,
      output_ref: result.outputRef,
      result: result.result,
      node_runs: nodeRuns,
    }, null, 2));
  } catch (err) {
    status = 'failed';
    if (!args['session-id'] && !args.session_id) {
      await finishPipelineRun(sessionId, {
        status,
        meta: {
          failed_node: node.id,
          error: err.message,
        },
      });
    }
    throw err;
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

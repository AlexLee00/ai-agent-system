#!/usr/bin/env node
// @ts-nocheck
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getMarketRegime, getMarketSnapshot, getOrderBook } from './tools/market-snapshot.ts';

const subscriptions = new Map();

export const MARKETDATA_MCP_TOOLS = [
  {
    name: 'subscribe_market_data',
    description: 'Register a market-data subscription in the parallel MCP runtime.',
  },
  {
    name: 'unsubscribe_market_data',
    description: 'Remove a market-data subscription from the parallel MCP runtime.',
  },
  {
    name: 'get_market_snapshot',
    description: 'Return a deterministic market snapshot for a market/symbol/timeframe.',
  },
  {
    name: 'get_market_regime',
    description: 'Return a deterministic market regime summary for a market/symbol.',
  },
  {
    name: 'get_order_book',
    description: 'Return a deterministic order-book snapshot for a market/symbol.',
  },
];

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function subscriptionKey(args = {}) {
  return `${args.market || 'binance'}:${String(args.symbol || 'BTC/USDT').toUpperCase()}:${args.timeframe || '1h'}`;
}

export function callMarketdataTool(name, args = {}) {
  if (name === 'subscribe_market_data') {
    const key = subscriptionKey(args);
    const value = { key, args, subscribedAt: new Date().toISOString(), mode: 'parallel_shadow' };
    subscriptions.set(key, value);
    return { ok: true, subscribed: true, subscription: value, count: subscriptions.size };
  }
  if (name === 'unsubscribe_market_data') {
    const key = subscriptionKey(args);
    const removed = subscriptions.delete(key);
    return { ok: true, unsubscribed: removed, key, count: subscriptions.size };
  }
  if (name === 'get_market_snapshot') return getMarketSnapshot(args);
  if (name === 'get_market_regime') return getMarketRegime(args);
  if (name === 'get_order_book') return getOrderBook(args);
  throw new Error(`unknown_tool:${name}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MARKETDATA_MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: callMarketdataTool(name, args) }] } };
  }
  if (MARKETDATA_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: callMarketdataTool(method, params) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

export function createMarketdataMcpServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'luna-marketdata-mcp',
          mode: 'parallel_shadow',
          subscriptions: subscriptions.size,
          checkedAt: new Date().toISOString(),
        });
      }
      if (req.method === 'POST' && (req.url === '/' || req.url === '/rpc')) {
        return json(res, 200, await handleRpc(await readBody(req)));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message || String(error) });
    }
  });
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function startServer({ port = null, host = '127.0.0.1' } = {}) {
  const server = createMarketdataMcpServer();
  const listenPort = Number(port ?? argValue('--port', process.env.LUNA_MARKETDATA_MCP_PORT || 4088));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

async function main() {
  const { port, host } = await startServer();
  console.log(JSON.stringify({ ok: true, service: 'luna-marketdata-mcp', host, port }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`luna-marketdata-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}

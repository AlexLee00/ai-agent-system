#!/usr/bin/env node
// @ts-nocheck
'use strict';

const http = require('node:http');
const {
  buildCancelPipelineStatus,
  buildReservationSyncCheck,
  buildSkaRuntimeContractStatus,
} = require('../../../lib/ska-ops-read-service');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4098;

const SKA_OPS_MCP_TOOLS = [
  {
    name: 'cancel-pipeline-status',
    description: 'Return read-only SKA cancel pipeline status, retry queue depth, and migration state.',
  },
  {
    name: 'reservation-sync-check',
    description: 'Compare reservation DB rows with a fresh, complete Pickko monitor snapshot. Read-only advisory.',
  },
  {
    name: 'runtime-contract-status',
    description: 'Report read-only SKA monitor config drift, snapshot freshness, reservation date hygiene, and historical raw-feed status.',
  },
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function callSkaOpsTool(name, args = {}, deps = {}) {
  if (name === 'cancel-pipeline-status') {
    return buildCancelPipelineStatus(args, deps);
  }
  if (name === 'reservation-sync-check') {
    return buildReservationSyncCheck(args, deps);
  }
  if (name === 'runtime-contract-status') {
    return buildSkaRuntimeContractStatus(args, deps);
  }
  throw new Error(`unknown_tool:${name}`);
}

async function handleRpc(body, deps = {}) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: SKA_OPS_MCP_TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: await callSkaOpsTool(name, args, deps) }] } };
  }
  if (SKA_OPS_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: await callSkaOpsTool(method, params, deps) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

function createSkaOpsMcpServer({ deps = {} } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'ska-ops-mcp',
          mode: 'read_only',
        });
      }
      if (req.method === 'POST' && (req.url === '/' || req.url === '/rpc')) {
        return json(res, 200, await handleRpc(await readBody(req), deps));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error).slice(0, 500) });
    }
  });
}

async function startServer({ port = null, host = DEFAULT_HOST, deps = {} } = {}) {
  const server = createSkaOpsMcpServer({ deps });
  const listenPort = Number(port ?? argValue('--port', process.env.SKA_OPS_MCP_PORT || DEFAULT_PORT));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

function installShutdownHandlers(server) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const forceExit = setTimeout(() => process.exit(0), 5000);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function main() {
  const { server, port, host } = await startServer();
  installShutdownHandlers(server);
  console.log(JSON.stringify({ ok: true, service: 'ska-ops-mcp', host, port, mode: 'read_only' }));
}

module.exports = {
  SKA_OPS_MCP_TOOLS,
  callSkaOpsTool,
  createSkaOpsMcpServer,
  handleRpc,
  installShutdownHandlers,
  startServer,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`ska-ops-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}

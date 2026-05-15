#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runLunaLlmHotPathAudit } from '../../../scripts/runtime-luna-llm-hotpath-audit.ts';
import {
  buildLunaBottleneckAutonomyReport,
  buildLunaBottleneckAutonomyFixtureReport,
} from '../../../scripts/runtime-luna-bottleneck-autonomy-operator.ts';
import { buildLunaDiscoveryFunnelReport } from '../../../scripts/runtime-luna-discovery-funnel-report.ts';
import { buildLunaLiveFireFinalGate } from '../../../scripts/luna-live-fire-final-gate.ts';
import { buildMarketdataRealtimeConnectivityReport } from '../../../scripts/runtime-marketdata-realtime-connectivity.ts';
import {
  buildPhase5GeneticAlphaRows,
  buildPhase5McpBridgeRows,
  buildPhase5RlEnsembleRows,
} from '../../../shared/luna-phase5-codex-p3.ts';

export const LUNA_OPS_MCP_TOOLS = [
  {
    name: 'luna_status',
    description: 'Return the read-only Luna bottleneck status summary.',
  },
  {
    name: 'luna_bottlenecks',
    description: 'Return the current bottleneck report with safe fix candidates.',
  },
  {
    name: 'luna_llm_usage',
    description: 'Return LLM hot-path usage and suspicious-call diagnostics.',
  },
  {
    name: 'luna_guardrails',
    description: 'Return live-fire final gate and marketdata guardrail state.',
  },
  {
    name: 'luna_apply_plan',
    description: 'Return safe operator commands; never executes apply commands.',
  },
  {
    name: 'luna_discovery_funnel',
    description: 'Return the Luna discovery-to-entry funnel report.',
  },
  {
    name: 'luna_phase5_mcp_bridge',
    description: 'Return the read-only Phase 5 A2A-to-MCP tool manifest.',
  },
  {
    name: 'luna_phase5_shadow_plan',
    description: 'Return Phase 5 RL ensemble and Genetic Alpha shadow candidates; never executes trades.',
  },
];

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readOnlyApplyPlan(report = {}) {
  return {
    ok: true,
    mode: 'read_only_plan',
    noLiveTradeExecution: true,
    protectedPidPolicy: report.protected6?.policy || 'never unload/restart/kill protected services',
    safeFixCandidates: report.safeFixCandidates || [],
    commands: report.commands || {},
  };
}

export async function callLunaOpsTool(name, args = {}) {
  const hours = Math.max(1, Number(args.hours || 6) || 6);
  const fixture = args.fixture === true;
  if (name === 'luna_status' || name === 'luna_bottlenecks') {
    const report = fixture
      ? buildLunaBottleneckAutonomyFixtureReport()
      : await buildLunaBottleneckAutonomyReport({
          hours,
          includeRealtime: args.includeRealtime !== false,
          includeFinalGate: args.includeFinalGate !== false,
          includePostLive: args.includePostLive !== false,
        });
    if (name === 'luna_status') {
      return {
        ok: report.ok,
        status: report.status,
        generatedAt: report.generatedAt,
        hardBlockers: report.hardBlockers || [],
        bottlenecks: report.bottlenecks || [],
        warnings: report.warnings || [],
        safeFixCount: (report.safeFixCandidates || []).length,
        protected6: report.protected6,
      };
    }
    return report;
  }
  if (name === 'luna_llm_usage') {
    return runLunaLlmHotPathAudit({ hours, limit: Math.max(1, Math.min(100, Number(args.limit || 30) || 30)) });
  }
  if (name === 'luna_guardrails') {
    const [finalGate, marketdata] = await Promise.all([
      buildLunaLiveFireFinalGate({ hours }),
      buildMarketdataRealtimeConnectivityReport({
        timeoutMs: 2500,
        realtimeWaitMs: 2500,
        realtimePollMs: 750,
      }),
    ]);
    return { ok: finalGate.ok === true && marketdata.ok === true, finalGate, marketdata };
  }
  if (name === 'luna_apply_plan') {
    const report = fixture
      ? buildLunaBottleneckAutonomyFixtureReport()
      : await buildLunaBottleneckAutonomyReport({
          hours,
          includeRealtime: args.includeRealtime !== false,
          includeFinalGate: args.includeFinalGate !== false,
          includePostLive: args.includePostLive !== false,
        });
    return readOnlyApplyPlan(report);
  }
  if (name === 'luna_discovery_funnel') {
    return buildLunaDiscoveryFunnelReport({ hours, market: args.market || 'all' });
  }
  if (name === 'luna_phase5_mcp_bridge') {
    const rows = buildPhase5McpBridgeRows({ fixture: args.fixture === true });
    return {
      ok: true,
      mode: 'read_only_shadow_manifest',
      toolCount: rows.length,
      directTradeAllowed: false,
      protectedPidMutationAllowed: false,
      rows,
    };
  }
  if (name === 'luna_phase5_shadow_plan') {
    const limit = Math.max(1, Math.min(100, Number(args.limit || 50) || 50));
    const fixtureMode = args.fixture === true;
    const [mcpRows, rlRows, geneticRows] = await Promise.all([
      Promise.resolve(buildPhase5McpBridgeRows({ fixture: fixtureMode })),
      buildPhase5RlEnsembleRows({ fixture: fixtureMode, limit, market: args.market || null }),
      buildPhase5GeneticAlphaRows({ fixture: fixtureMode, limit, market: args.market || null }),
    ]);
    return {
      ok: true,
      mode: 'shadow_plan_only',
      noLiveTradeExecution: true,
      directTradeAllowed: false,
      summary: {
        mcpTools: mcpRows.length,
        rlRows: rlRows.length,
        geneticRows: geneticRows.length,
        liveMutation: false,
      },
      rows: { mcp: mcpRows, rl: rlRows, genetic: geneticRows },
    };
  }
  throw new Error(`unknown_tool:${name}`);
}

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: LUNA_OPS_MCP_TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: await callLunaOpsTool(name, args) }] } };
  }
  if (LUNA_OPS_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: await callLunaOpsTool(method, params) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

export function createLunaOpsMcpServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'luna-ops-mcp',
          mode: 'read_only',
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

export async function startServer({ port = null, host = '127.0.0.1' } = {}) {
  const server = createLunaOpsMcpServer();
  const listenPort = Number(port ?? argValue('--port', process.env.LUNA_OPS_MCP_PORT || 4092));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

async function main() {
  const { port, host } = await startServer();
  console.log(JSON.stringify({ ok: true, service: 'luna-ops-mcp', host, port, mode: 'read_only' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`luna-ops-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}

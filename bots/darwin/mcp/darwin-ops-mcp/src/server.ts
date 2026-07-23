'use strict';

const http: typeof import('http') = require('http');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const env: { PROJECT_ROOT: string } = require('../../../../../packages/core/lib/env');
const proposalStore = require('../../../lib/proposal-store.ts');
const adoptPipeline = require('../../../lib/adopt-pipeline.ts');
const telemetry = require('../../../lib/telemetry.ts');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4099;
const LEARNINGS_PATH = path.join(env.PROJECT_ROOT, 'bots/darwin/docs/learnings.md');

const DARWIN_OPS_TOOLS = [
  {
    name: 'cycle_status',
    description: 'Read-only Darwin cycle status from proposals and telemetry.',
    inputSchema: { type: 'object', properties: { telemetryLimit: { type: 'number' } } },
  },
  {
    name: 'proposals',
    description: 'List Darwin proposal lifecycle states.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, state: { type: 'string' } } },
  },
  {
    name: 'adopt_queue',
    description: 'Read-only Darwin adopt queue and blockers.',
    inputSchema: { type: 'object', properties: { cap: { type: 'number' } } },
  },
  {
    name: 'learnings_tail',
    description: 'Tail Darwin learnings.md lines.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

function safeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.trunc(parsed)) : fallback;
}

function tailFile(filePath: string, limit: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit);
}

function summarizeProposal(proposal: Record<string, unknown>) {
  return {
    id: proposal.id,
    title: proposal.title || proposal.paper_title || null,
    status: proposal.status || null,
    state: proposalStore.normalizeProposalState(proposal.status),
    branch: proposal.branch || null,
    updated_at: proposal.updated_at || null,
    created_at: proposal.created_at || null,
  };
}

async function callDarwinOpsTool(name: string, args: Record<string, unknown> = {}, deps: {
  proposalStore?: typeof proposalStore;
  adoptPipeline?: typeof adoptPipeline;
  telemetry?: typeof telemetry;
  learningsPath?: string;
} = {}) {
  const store = deps.proposalStore || proposalStore;
  const adopt = deps.adoptPipeline || adoptPipeline;
  const tel = deps.telemetry || telemetry;
  if (name === 'cycle_status') {
    const proposals = store.listProposals();
    const consistency = typeof store.auditProposalConsistency === 'function'
      ? store.auditProposalConsistency()
      : { activeDuplicatePapers: [], implementingWithoutBranch: [], staleImplementations: [] };
    const states = new Map<string, number>();
    for (const proposal of proposals) {
      const state = String(store.normalizeProposalState(proposal.status));
      states.set(state, (states.get(state) || 0) + 1);
    }
    return {
      ok: true,
      proposalCount: proposals.length,
      states: Object.fromEntries(states.entries()),
      consistency,
      telemetry: tel.tailTelemetry(safeLimit(args.telemetryLimit, 20, 100)),
    };
  }
  if (name === 'proposals') {
    const limit = safeLimit(args.limit, 20, 100);
    const stateFilter = String(args.state || '').trim();
    const proposals = store.listProposals()
      .map(summarizeProposal)
      .filter((proposal: Record<string, unknown>) => !stateFilter || proposal.state === stateFilter)
      .slice(0, limit);
    return { ok: true, proposals };
  }
  if (name === 'adopt_queue') {
    const result = adopt.selectAdoptCandidates({ cap: safeLimit(args.cap, 2, 20) });
    return {
      ok: true,
      cap: result.cap,
      candidates: result.candidates.map((item: Record<string, unknown>) => {
        const proposal = item.proposal && typeof item.proposal === 'object' ? item.proposal as Record<string, unknown> : {};
        return {
          id: proposal.id,
          title: proposal.title,
          changedFiles: item.changedFiles,
        };
      }),
      blocked: result.blocked.map((item: Record<string, unknown>) => {
        const proposal = item.proposal && typeof item.proposal === 'object' ? item.proposal as Record<string, unknown> : {};
        return {
          id: proposal.id,
          reason: item.blockedReason,
          denylistMatches: item.denylistMatches,
        };
      }),
    };
  }
  if (name === 'learnings_tail') {
    return {
      ok: true,
      lines: tailFile(deps.learningsPath || LEARNINGS_PATH, safeLimit(args.limit, 20, 100)),
    };
  }
  return { ok: false, error: `unknown_tool:${name}` };
}

function jsonResponse(res: import('http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: import('http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request_too_large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleRpc(req: import('http').IncomingMessage, res: import('http').ServerResponse) {
  try {
    const body = await readBody(req);
    const method = String(body.method || '');
    const params = body.params && typeof body.params === 'object' ? body.params as Record<string, unknown> : {};
    if (method === 'tools/list') {
      return jsonResponse(res, 200, { jsonrpc: '2.0', id: body.id || null, result: { tools: DARWIN_OPS_TOOLS } });
    }
    if (method === 'tools/call') {
      const name = String(params.name || '');
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
      const result = await callDarwinOpsTool(name, args);
      return jsonResponse(res, result.ok === false ? 400 : 200, { jsonrpc: '2.0', id: body.id || null, result });
    }
    return jsonResponse(res, 400, { jsonrpc: '2.0', id: body.id || null, error: { message: `unknown_method:${method}` } });
  } catch (error) {
    return jsonResponse(res, 500, { ok: false, error: String((error as Error)?.message || error) });
  }
}

function startServer(options: { host?: string; port?: number } = {}) {
  const host = options.host || process.env.DARWIN_OPS_MCP_HOST || DEFAULT_HOST;
  const port = Number.isFinite(options.port) ? Number(options.port) : Number(process.env.DARWIN_OPS_MCP_PORT || DEFAULT_PORT);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return jsonResponse(res, 200, { ok: true, service: 'darwin-ops-mcp', tools: DARWIN_OPS_TOOLS.length });
    }
    if (req.method === 'GET' && req.url === '/tools') {
      return jsonResponse(res, 200, { tools: DARWIN_OPS_TOOLS });
    }
    if (req.method === 'POST' && (req.url === '/rpc' || req.url === '/')) {
      return handleRpc(req, res);
    }
    return jsonResponse(res, 404, { ok: false, error: 'not_found' });
  });
  server.listen(port, host, () => {
    console.log(`[darwin-ops-mcp] listening on http://${host}:${(server.address() as import('net').AddressInfo).port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  DARWIN_OPS_TOOLS,
  callDarwinOpsTool,
  startServer,
};

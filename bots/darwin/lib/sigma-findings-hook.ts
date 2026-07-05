'use strict';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DEFAULT_SIGMA_LIBRARY_MCP_URL = 'http://127.0.0.1:4097';
const DEFAULT_QUEUE_PATH = path.join(os.homedir(), '.ai-agent-system/workspace/darwin/sigma-findings-queue.jsonl');

function getSigmaFindingsQueuePath(envObj: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(envObj.DARWIN_SIGMA_FINDINGS_QUEUE_PATH || DEFAULT_QUEUE_PATH);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown_error');
}

function buildFindingPayload(
  proposal: Record<string, unknown>,
  event: 'adopted' | 'archived',
  evidence: Record<string, unknown> = {},
) {
  return {
    source: 'darwin',
    axis: 'W',
    validation_state: 'unverified',
    event,
    proposal_id: proposal.id || evidence.proposal_id || null,
    title: proposal.title || proposal.paper_title || evidence.title || null,
    status: proposal.status || event,
    evidence,
    created_at: new Date().toISOString(),
  };
}

async function jsonRpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  fetchFn: typeof fetch,
  timeoutMs: number,
) {
  const response = await fetchFn(`${url.replace(/\/$/, '')}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `darwin-${Date.now()}`, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && !body.error, response, body };
}

async function discoverSigmaContributionTool(options: {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}) {
  const baseUrl = options.baseUrl || process.env.DARWIN_SIGMA_LIBRARY_MCP_URL || DEFAULT_SIGMA_LIBRARY_MCP_URL;
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = options.timeoutMs || 1500;
  const result = await jsonRpc(baseUrl, 'tools/list', {}, fetchFn, timeoutMs);
  if (!result.ok) {
    return { ok: false, toolName: null, reason: 'tools_list_failed', response: result.body };
  }
  const tools = Array.isArray(result.body?.result?.tools) ? result.body.result.tools : [];
  const tool = tools.find((item: Record<string, unknown>) => {
    const name = String(item.name || '');
    return /contribut|finding|ingest|vault.*add/i.test(name);
  });
  return {
    ok: true,
    toolName: tool ? String(tool.name) : null,
    tools: tools.map((item: Record<string, unknown>) => String(item.name || '')).filter(Boolean),
  };
}

function queueSigmaFinding(payload: Record<string, unknown>, options: { queuePath?: string } = {}) {
  const queuePath = options.queuePath || getSigmaFindingsQueuePath();
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, `${JSON.stringify(payload)}\n`, 'utf8');
  return { ok: true, queued: true, queuePath };
}

async function contributeSigmaFinding(
  proposal: Record<string, unknown>,
  event: 'adopted' | 'archived',
  evidence: Record<string, unknown> = {},
  options: {
    baseUrl?: string;
    fetchFn?: typeof fetch;
    queuePath?: string;
    timeoutMs?: number;
  } = {},
) {
  const payload = buildFindingPayload(proposal, event, evidence);
  const baseUrl = options.baseUrl || process.env.DARWIN_SIGMA_LIBRARY_MCP_URL || DEFAULT_SIGMA_LIBRARY_MCP_URL;
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = options.timeoutMs || 1500;
  try {
    const discovered = await discoverSigmaContributionTool({ baseUrl, fetchFn, timeoutMs });
    if (discovered.ok && discovered.toolName) {
      const called = await jsonRpc(baseUrl, 'tools/call', {
        name: discovered.toolName,
        arguments: { finding: payload },
      }, fetchFn, timeoutMs);
      if (called.ok) return { ok: true, queued: false, toolName: discovered.toolName, response: called.body };
      return {
        ...queueSigmaFinding({ ...payload, sigma_error: called.body }, { queuePath: options.queuePath }),
        reason: 'tool_call_failed',
      };
    }
    return {
      ...queueSigmaFinding({ ...payload, sigma_discovery: discovered }, { queuePath: options.queuePath }),
      reason: discovered.ok ? 'contribution_tool_unavailable' : discovered.reason,
    };
  } catch (error) {
    return {
      ...queueSigmaFinding({ ...payload, sigma_error: toErrorMessage(error) }, { queuePath: options.queuePath }),
      reason: 'sigma_hook_failed',
    };
  }
}

module.exports = {
  DEFAULT_SIGMA_LIBRARY_MCP_URL,
  DEFAULT_QUEUE_PATH,
  getSigmaFindingsQueuePath,
  buildFindingPayload,
  discoverSigmaContributionTool,
  queueSigmaFinding,
  contributeSigmaFinding,
};

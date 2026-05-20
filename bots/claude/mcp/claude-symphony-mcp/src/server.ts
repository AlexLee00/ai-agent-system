#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DEFAULT_PORT = 8770;
const HUB_BASE = 'http://localhost:7788';

export const CLAUDE_SYMPHONY_MCP_TOOLS = [
  {
    name: 'poll_tasks',
    description: 'Symphony Tasks DB에서 티켓 목록 조회. 상태/팀으로 필터링 가능.',
  },
  {
    name: 'dispatch_ticket',
    description: '새 Symphony 티켓 생성 및 팀에 dispatch. title, team, agent 필수.',
  },
  {
    name: 'get_task_status',
    description: '특정 티켓 ID의 현재 상태 조회.',
  },
  {
    name: 'update_task',
    description: '티켓 상태 변경 (todo/in_progress/review/done/blocked).',
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

function loadHubToken() {
  try {
    const store = JSON.parse(readFileSync(path.join(REPO_ROOT, 'bots/hub/secrets-store.json'), 'utf8'));
    return store.HUB_AUTH_TOKEN || '';
  } catch {
    return process.env.HUB_AUTH_TOKEN || '';
  }
}

async function hubFetch(pathname, options = {}) {
  const token = loadHubToken();
  const { method = 'GET', body } = options;
  const url = `${HUB_BASE}${pathname}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleTool(name, params) {
  if (name === 'poll_tasks') {
    const qs = new URLSearchParams();
    if (params.state) qs.set('state', params.state);
    if (params.status) qs.set('state', params.status);
    if (params.team) qs.set('team', params.team);
    if (params.limit) qs.set('limit', String(params.limit));
    const r = await hubFetch(`/hub/tasks?${qs.toString()}`);
    return {
      ok: r.ok,
      mode: 'read_only_poll',
      tasks: r.data?.tasks || [],
      total: r.data?.total ?? 0,
      hubReachable: r.ok,
      error: r.error,
    };
  }

  if (name === 'dispatch_ticket') {
    if (!params.title || !params.team) {
      return { ok: false, error: 'title and team are required' };
    }
    const r = await hubFetch('/hub/tasks', {
      method: 'POST',
      body: {
        title: params.title,
        team: params.team,
        agent: params.agent || null,
        ticket_external_id: params.ticket_external_id || null,
        metadata: params.metadata || {},
      },
    });
    return { ok: r.ok, task: r.data?.task || null, error: r.error };
  }

  if (name === 'get_task_status') {
    if (!params.id) return { ok: false, error: 'id is required' };
    const r = await hubFetch(`/hub/tasks/${params.id}`);
    return { ok: r.ok, task: r.data?.task || null, error: r.error };
  }

  if (name === 'update_task') {
    if (!params.id) return { ok: false, error: 'id is required' };
    const r = await hubFetch(`/hub/tasks/${params.id}`, {
      method: 'PATCH',
      body: {
        state: params.state,
        result: params.result || null,
      },
    });
    return { ok: r.ok, task: r.data?.task || null, error: r.error };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

const PORT = Number(argValue('port', DEFAULT_PORT));
const IS_SMOKE = process.argv.includes('--smoke') || process.argv.includes('--json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'claude-symphony-mcp', port: PORT });
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    return json(res, 200, { ok: true, tools: CLAUDE_SYMPHONY_MCP_TOOLS });
  }

  const toolMatch = url.pathname.match(/^\/tools\/([^/]+)$/);
  if (toolMatch && req.method === 'POST') {
    const name = toolMatch[1];
    const params = await readBody(req).catch(() => ({}));
    const result = await handleTool(name, params);
    return json(res, result.ok ? 200 : 400, result);
  }

  json(res, 404, { ok: false, error: 'not found' });
});

if (IS_SMOKE) {
  // smoke: 포트 바인딩 없이 도구 목록 + Hub 연결 확인
  (async () => {
    const r = await hubFetch('/hub/tasks?state=todo&limit=3');
    console.log(JSON.stringify({
      ok: true,
      service: 'claude-symphony-mcp',
      port: PORT,
      tools: CLAUDE_SYMPHONY_MCP_TOOLS.map((t) => t.name),
      hubReachable: r.ok,
      sampleTasks: r.data?.tasks?.length ?? 0,
    }));
  })();
} else {
  server.on('error', (err) => {
    console.error(`[claude-symphony-mcp] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`[claude-symphony-mcp] listening on :${PORT}`);
  });
}

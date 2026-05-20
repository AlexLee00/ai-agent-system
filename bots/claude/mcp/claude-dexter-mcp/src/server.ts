#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DEFAULT_PORT = 8772;
const HUB_BASE = 'http://localhost:7788';

export const CLAUDE_DEXTER_MCP_TOOLS = [
  {
    name: 'run_checks',
    description: '덱스터 22개 체크 시스템 실행. 선택적 카테고리 필터 가능 (bots/resources/database/n8n/patterns).',
  },
  {
    name: 'get_health_summary',
    description: '최신 덱스터 헬스 체크 결과 요약. 이전 실행 결과 캐시에서 읽음.',
  },
  {
    name: 'get_alert_history',
    description: '덱스터 경고 이력 조회 (최근 N건). 패턴 감지 및 반복 오류 분석용.',
  },
  {
    name: 'subscribe_alerts',
    description: '알림 구독 상태 확인 (read-only). 실제 구독 변경은 Hub 경유 필요.',
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
  try {
    const res = await fetch(`${HUB_BASE}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function readDexterCache() {
  const issuesFile = path.join(REPO_ROOT, 'bots/claude/dexter-issues.json');
  const fixesFile = path.join(REPO_ROOT, 'bots/claude/dexter-fixes.json');
  try {
    const issues = existsSync(issuesFile) ? JSON.parse(readFileSync(issuesFile, 'utf8')) : [];
    const fixes = existsSync(fixesFile) ? JSON.parse(readFileSync(fixesFile, 'utf8')) : [];
    return { issues, fixes };
  } catch {
    return { issues: [], fixes: [] };
  }
}

async function handleTool(name, params) {
  if (name === 'run_checks') {
    const category = params.category || 'all';
    const r = await hubFetch('/hub/tasks', {
      method: 'POST',
      body: {
        title: `dexter-mcp: run_checks (category=${category})`,
        team: 'claude',
        agent: 'dexter',
        metadata: { category, source: 'claude-dexter-mcp' },
      },
    });
    return {
      ok: r.ok,
      mode: 'dispatch_dexter_check',
      category,
      dispatchedTask: r.data?.task || null,
      note: '덱스터 체크 요청 dispatched — 결과는 get_health_summary로 조회',
      error: r.error,
    };
  }

  if (name === 'get_health_summary') {
    const { issues, fixes } = readDexterCache();
    const r = await hubFetch('/health');
    return {
      ok: true,
      mode: 'read_only_summary',
      hubHealth: r.data || null,
      dexterIssues: issues.slice(0, 10),
      dexterFixes: fixes.slice(0, 5),
      issueCount: issues.length,
      fixCount: fixes.length,
    };
  }

  if (name === 'get_alert_history') {
    const limit = Math.min(Number(params.limit) || 20, 100);
    const r = await hubFetch(`/hub/pg?query=SELECT+id,check_name,severity,message,created_at+FROM+claude.dexter_patterns+ORDER+BY+created_at+DESC+LIMIT+${limit}`);
    const { issues } = readDexterCache();
    return {
      ok: r.ok,
      mode: 'read_only_history',
      dbRows: r.data?.rows || [],
      cachedIssues: issues.slice(0, limit),
      error: r.error,
    };
  }

  if (name === 'subscribe_alerts') {
    return {
      ok: true,
      mode: 'read_only_subscription_status',
      note: '알림 구독은 Hub /hub/alarms/policy 경유 필요 — dexter-mcp는 조회만 지원',
      hubAlarmEndpoint: `${HUB_BASE}/hub/alarms`,
    };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

const PORT = Number(argValue('port', DEFAULT_PORT));
const IS_SMOKE = process.argv.includes('--smoke') || process.argv.includes('--json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'claude-dexter-mcp', port: PORT });
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    return json(res, 200, { ok: true, tools: CLAUDE_DEXTER_MCP_TOOLS });
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
  (async () => {
    const { issues } = readDexterCache();
    console.log(JSON.stringify({
      ok: true,
      service: 'claude-dexter-mcp',
      port: PORT,
      tools: CLAUDE_DEXTER_MCP_TOOLS.map((t) => t.name),
      cachedIssueCount: issues.length,
    }));
  })();
} else {
  server.on('error', (err) => {
    console.error(`[claude-dexter-mcp] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`[claude-dexter-mcp] listening on :${PORT}`);
  });
}

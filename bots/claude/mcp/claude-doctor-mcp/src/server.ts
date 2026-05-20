#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DEFAULT_PORT = 8771;
const HUB_BASE = 'http://localhost:7788';

export const CLAUDE_DOCTOR_MCP_TOOLS = [
  {
    name: 'diagnose_system',
    description: '시스템 전반 진단. launchd 서비스 상태 + 최근 복구 로그 요약.',
  },
  {
    name: 'get_health',
    description: '현재 시스템 헬스 스냅샷 (Hub 상태 + DB 연결 + 서비스 목록).',
  },
  {
    name: 'heal_service',
    description: '서비스 재시작 요청 (L1). PROTECTED 서비스는 차단됨. 마스터 승인 필요.',
  },
  {
    name: 'get_recovery_log',
    description: '닥터 복구 이력 조회 (최근 20건). 성공/실패 패턴 분석용.',
  },
];

const PROTECTED_SERVICES = [
  'ai.ska', 'ai.luna', 'ai.investment', 'ai.claude', 'ai.elixir', 'ai.hub',
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

function isProtected(service) {
  return PROTECTED_SERVICES.some((p) => service.startsWith(p));
}

async function handleTool(name, params) {
  if (name === 'diagnose_system') {
    const [healthR, logR] = await Promise.allSettled([
      hubFetch('/health'),
      hubFetch('/hub/pg?query=SELECT+id,service,action,success,created_at+FROM+claude.doctor_recovery_log+ORDER+BY+created_at+DESC+LIMIT+5'),
    ]);
    return {
      ok: true,
      mode: 'read_only_diagnose',
      hubHealth: healthR.status === 'fulfilled' ? healthR.value.data : null,
      recentRecovery: logR.status === 'fulfilled' ? logR.value.data : null,
      protectedServices: PROTECTED_SERVICES,
    };
  }

  if (name === 'get_health') {
    const r = await hubFetch('/health');
    return {
      ok: r.ok,
      mode: 'read_only_health',
      health: r.data || null,
      hubReachable: r.ok,
      error: r.error,
    };
  }

  if (name === 'heal_service') {
    const service = String(params.service || '');
    if (!service) return { ok: false, error: 'service is required' };
    if (isProtected(service)) {
      return {
        ok: false,
        error: `PROTECTED: ${service}는 자동 재시작 금지 (마스터 승인 필요)`,
        protectedPolicy: 'CLAUDE.md 절대 규칙 — PROTECTED launchd 무중단',
      };
    }
    const r = await hubFetch('/hub/services/restart', {
      method: 'POST',
      body: { service, reason: params.reason || 'doctor-mcp heal request' },
    });
    return { ok: r.ok, service, result: r.data, error: r.error };
  }

  if (name === 'get_recovery_log') {
    const limit = Math.min(Number(params.limit) || 20, 100);
    const r = await hubFetch(`/hub/pg?query=SELECT+id,service,action,success,error_msg,created_at+FROM+claude.doctor_recovery_log+ORDER+BY+created_at+DESC+LIMIT+${limit}`);
    return {
      ok: r.ok,
      mode: 'read_only_log',
      rows: r.data?.rows || [],
      error: r.error,
    };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

const PORT = Number(argValue('port', DEFAULT_PORT));
const IS_SMOKE = process.argv.includes('--smoke') || process.argv.includes('--json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'claude-doctor-mcp', port: PORT });
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    return json(res, 200, { ok: true, tools: CLAUDE_DOCTOR_MCP_TOOLS });
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
    const health = await hubFetch('/health');
    console.log(JSON.stringify({
      ok: true,
      service: 'claude-doctor-mcp',
      port: PORT,
      tools: CLAUDE_DOCTOR_MCP_TOOLS.map((t) => t.name),
      hubReachable: health.ok,
      protectedServicesCount: PROTECTED_SERVICES.length,
    }));
  })();
} else {
  server.on('error', (err) => {
    console.error(`[claude-doctor-mcp] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`[claude-doctor-mcp] listening on :${PORT}`);
  });
}

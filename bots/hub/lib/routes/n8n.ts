const fs = require('node:fs');
const path = require('node:path');
const env = require('../../../../packages/core/lib/env');
const { fetchJson, postJson } = require('../../../../packages/core/lib/health-provider');
const pgPool = require('../../../../packages/core/lib/pg-pool');

// n8n.webhook_entity에서 실제 웹훅 경로를 조회 (short name → full path)
// 예: "rag-ingest" → "D1HhD70CSezffE02/webhook/rag-ingest"
//     "critical"   → "critical"
const _webhookPathCache = new Map<string, { fullPath: string; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
let _n8nPool: any = null;

async function resolveWebhookPath(shortPath: string): Promise<string> {
  const cached = _webhookPathCache.get(shortPath);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.fullPath;
  }
  try {
    // pg-pool은 n8n 스키마를 허용하지 않으므로 node-postgres 직접 사용 (싱글톤)
    if (!_n8nPool) {
      const { Pool } = require('pg');
      _n8nPool = new Pool({ database: 'jay', host: '127.0.0.1', port: 5432, max: 2 });
    }
    const result = await _n8nPool.query(
      `SELECT "webhookPath" FROM n8n.webhook_entity
       WHERE "webhookPath" = $1 OR "webhookPath" LIKE $2
       LIMIT 1`,
      [shortPath, `%/${shortPath}`]
    );
    if (result.rows.length > 0) {
      const fullPath = result.rows[0].webhookPath;
      _webhookPathCache.set(shortPath, { fullPath, cachedAt: Date.now() });
      return fullPath;
    }
  } catch {
    // fallback: short path 그대로 사용
  }
  return shortPath;
}

async function buildWebhookUrl(pathValue: unknown): Promise<string> {
  const safePath = String(pathValue || '').replace(/^\/+/, '');
  const resolvedPath = await resolveWebhookPath(safePath);
  return `${env.N8N_BASE_URL}/webhook/${resolvedPath}`;
}

function getN8nApiKey(): string {
  if (env.N8N_API_KEY) return env.N8N_API_KEY;
  try {
    const storePath = path.join(env.PROJECT_ROOT || '', 'bots/hub/secrets-store.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return store?.n8n_api_key || '';
  } catch {
    return '';
  }
}

async function n8nApiRequest(method: string, apiPath: string, body?: unknown) {
  const apiKey = getN8nApiKey();
  if (!apiKey) return { error: 'n8n_api_key_missing' };
  const url = `${env.N8N_BASE_URL}/api/v1${apiPath}`;
  try {
    const fetchOpts: RequestInit = {
      method,
      headers: {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    };
    if (body && method !== 'GET') fetchOpts.body = JSON.stringify(body);
    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) return { error: `n8n_api_http_${resp.status}` };
    return await resp.json();
  } catch (err: any) {
    return { error: err.message || 'n8n_api_request_failed' };
  }
}

export async function n8nHealthRoute(_req: any, res: any) {
  if (!env.N8N_ENABLED) {
    return res.json({ status: 'ok', detail: 'n8n disabled in current mode' });
  }

  const data = await fetchJson(`${env.N8N_BASE_URL}/healthz`, 4000);
  if (!data) {
    return res.status(502).json({ error: 'n8n_unreachable' });
  }
  return res.json(data);
}

export async function n8nWorkflowsRoute(_req: any, res: any) {
  if (!env.N8N_ENABLED) return res.status(503).json({ error: 'n8n_disabled' });
  const data = await n8nApiRequest('GET', '/workflows?limit=100') as any;
  if (!data || data.error) return res.status(502).json({ error: 'n8n_api_failed', detail: data?.error });
  return res.json(data);
}

export async function n8nTriggerWorkflowRoute(req: any, res: any) {
  if (!env.N8N_ENABLED) return res.status(503).json({ error: 'n8n_disabled' });
  const { workflowId } = req.params;
  if (!workflowId) return res.status(400).json({ error: 'workflowId required' });
  const data = await n8nApiRequest('POST', `/workflows/${workflowId}/run`, req.body || {});
  if (!data || (data as any).error) return res.status(502).json({ error: 'n8n_trigger_failed' });
  return res.json(data);
}

export async function n8nWebhookRoute(req: any, res: any) {
  if (!env.N8N_ENABLED) {
    return res.status(503).json({ error: 'n8n_disabled' });
  }

  const webhookUrl = await buildWebhookUrl(req.params.path);
  const result = await postJson(webhookUrl, req.body || {}, {
    timeoutMs: 10000,
    headers: req.headers['x-health-probe'] ? { 'x-health-probe': req.headers['x-health-probe'] } : {},
  });

  if (result.error) {
    return res.status(502).json({ error: 'n8n_proxy_failed', reason: result.error });
  }

  return res.status(result.status || 200).json(
    result.json || {
      ok: result.ok,
      status: result.status,
      text: result.text,
    },
  );
}

const fs = require('node:fs');
const path = require('node:path');
const env = require('../../../../packages/core/lib/env');
const { fetchJson, postJson } = require('../../../../packages/core/lib/health-provider');

function buildWebhookUrl(pathValue: unknown) {
  const safePath = String(pathValue || '').replace(/^\/+/, '');
  return `${env.N8N_BASE_URL}/webhook/${safePath}`;
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

  const result = await postJson(buildWebhookUrl(req.params.path), req.body || {}, {
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

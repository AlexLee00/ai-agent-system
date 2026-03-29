'use strict';

const env = require('../../../../packages/core/lib/env');
const { fetchJson, postJson } = require('../../../../packages/core/lib/health-provider');

function buildWebhookUrl(pathValue) {
  const safePath = String(pathValue || '').replace(/^\/+/, '');
  return `${env.N8N_BASE_URL}/webhook/${safePath}`;
}

async function n8nHealthRoute(req, res) {
  if (!env.N8N_ENABLED) {
    return res.json({ status: 'ok', detail: 'n8n disabled in current mode' });
  }

  const data = await fetchJson(`${env.N8N_BASE_URL}/healthz`, 4000);
  if (!data) {
    return res.status(502).json({ error: 'n8n_unreachable' });
  }
  return res.json(data);
}

async function n8nWebhookRoute(req, res) {
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

module.exports = {
  n8nWebhookRoute,
  n8nHealthRoute,
};

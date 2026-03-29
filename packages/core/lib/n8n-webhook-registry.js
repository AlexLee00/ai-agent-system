'use strict';

const pgPool = require('./pg-pool');
const { N8N_ENABLED, N8N_BASE_URL: DEFAULT_N8N_BASE } = require('./env');

async function resolveProductionWebhookUrl({
  workflowName,
  method = 'POST',
  pathSuffix = '',
  baseUrl = DEFAULT_N8N_BASE,
} = {}) {
  if (!N8N_ENABLED) return null;
  if (!workflowName) return null;

  const rows = await pgPool.query('public', `
    SELECT we."webhookPath" AS "webhookPath"
    FROM n8n.webhook_entity we
    JOIN n8n.workflow_entity wf ON wf.id = we."workflowId"
    WHERE wf.name = $1
      AND we.method = $2
      AND ($3 = '' OR we."webhookPath" LIKE $3)
    LIMIT 5
  `, [
    workflowName,
    method,
    pathSuffix ? `%${pathSuffix}` : '',
  ]);

  const row = rows.find((item) => item?.webhookPath) || null;
  if (!row?.webhookPath) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/webhook/${String(row.webhookPath).replace(/^\/+/, '')}`;
}

async function buildWebhookCandidates({
  workflowName,
  method = 'POST',
  pathSuffix = '',
  configured = [],
  defaults = [],
} = {}) {
  let resolved = null;
  try {
    resolved = await resolveProductionWebhookUrl({
      workflowName,
      method,
      pathSuffix,
    });
  } catch {}

  return [...new Set([
    ...(Array.isArray(configured) ? configured : [configured]),
    resolved,
    ...(Array.isArray(defaults) ? defaults : [defaults]),
  ].filter(Boolean))];
}

module.exports = {
  resolveProductionWebhookUrl,
  buildWebhookCandidates,
};

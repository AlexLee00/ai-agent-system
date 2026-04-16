// @ts-nocheck
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const pgPool = require(path.join(ROOT, 'packages/core/lib/pg-pool'));

async function main() {
  const columns = await pgPool.query('public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'n8n'
      AND table_name = 'webhook_entity'
    ORDER BY ordinal_position
  `);

  const rows = await pgPool.query('public', `
    SELECT *
    FROM n8n.webhook_entity
    LIMIT 20
  `);

  const workflows = await pgPool.query('public', `
    SELECT id, name, active
    FROM n8n.workflow_entity
    WHERE active = true
    LIMIT 20
  `);

  const normalizedRows = rows.map((row) => {
    const workflowId = row.workflowid || row.workflowId || row.workflow_id || null;
    const pathValue = row.path || '';
    const webhookPath = row.webhookpath || row.webhookPath || '';
    const method = row.method || row.httpmethod || null;
    return {
      workflowId,
      webhookPath,
      path: pathValue,
      method,
      guessedUrl: pathValue ? `http://127.0.0.1:5678/${String(pathValue).replace(/^\/+/, '')}` : null,
      guessedProdUrl: webhookPath ? `http://127.0.0.1:5678/webhook/${String(webhookPath).replace(/^\/+/, '')}` : null,
    };
  });

  console.log(JSON.stringify({
    columns: columns.map((row) => row.column_name),
    activeWorkflows: workflows,
    webhookRows: normalizedRows,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`[inspect-n8n-webhooks] ${error.message}`);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await pgPool.closeAll();
    } catch {}
  });

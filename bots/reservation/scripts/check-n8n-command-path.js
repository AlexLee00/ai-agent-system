#!/usr/bin/env node
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');

const HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_WEBHOOK_URL = process.env.SKA_N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/ska-command';

async function main() {
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '스카팀 읽기 명령 intake',
    method: 'POST',
    pathSuffix: 'ska-command',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_WEBHOOK_URL;
  const healthOk = await checkHttp(HEALTH_URL, 2500);
  const webhook = await checkWebhookRegistration(webhookUrl, {
    command: 'query_today_stats',
    args: { date: new Date().toISOString().slice(0, 10) },
  }, {
    timeoutMs: 5000,
  });

  const report = {
    healthUrl: HEALTH_URL,
    webhookUrl,
    resolvedWebhookUrl,
    defaultWebhookUrl: DEFAULT_WEBHOOK_URL,
    n8nHealthy: healthOk,
    webhookRegistered: webhook.registered,
    webhookStatus: webhook.status,
    webhookReason: webhook.reason,
    webhookHealthy: webhook.healthy,
    webhookError: webhook.error || null,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  const nestedErrors = Array.isArray(error?.errors)
    ? error.errors.map((item) => item?.message).filter(Boolean).join(' | ')
    : '';
  const detail = error?.message || nestedErrors || error?.stack || String(error);
  console.error(`[ska n8n command path] ${detail}`);
  process.exit(1);
});

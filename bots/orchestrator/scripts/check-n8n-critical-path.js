#!/usr/bin/env node
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');

const HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_WEBHOOK_URL = process.env.N8N_CRITICAL_WEBHOOK || 'http://127.0.0.1:5678/webhook/critical';

async function main() {
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: 'CRITICAL 알림 에스컬레이션',
    method: 'POST',
    pathSuffix: 'critical',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_WEBHOOK_URL;
  const healthOk = await checkHttp(HEALTH_URL, 2500);
  const webhook = await checkWebhookRegistration(webhookUrl, {
    severity: 'critical',
    service: 'health-check',
    status: 'probe',
    detail: 'n8n critical webhook health probe',
  }, {
    timeoutMs: 5000,
  });

  console.log(JSON.stringify({
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
  }, null, 2));
}

main().catch((error) => {
  console.error(`[orchestrator n8n critical path] ${error.message}`);
  process.exit(1);
});

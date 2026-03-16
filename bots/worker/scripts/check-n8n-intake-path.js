#!/usr/bin/env node
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { getWorkerN8nRuntimeConfig } = require('../lib/runtime-config');

const runtimeConfig = getWorkerN8nRuntimeConfig();
const HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.healthUrl;
const DEFAULT_WEBHOOK_URL = process.env.N8N_WORKER_WEBHOOK || runtimeConfig.workerWebhookUrl;

async function main() {
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '워커팀 자연어 업무 intake',
    method: 'POST',
    pathSuffix: 'worker-chat-intake',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_WEBHOOK_URL;
  const healthOk = await checkHttp(HEALTH_URL, Number(runtimeConfig.healthTimeoutMs || 2500));
  const webhook = await checkWebhookRegistration(webhookUrl, {
    company_id: 'master',
    user_id: 1,
    message: 'n8n intake health probe',
  }, {
    timeoutMs: Number(runtimeConfig.webhookTimeoutMs || 5000),
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
  console.error(`[worker n8n intake path] ${error.message}`);
  process.exit(1);
});

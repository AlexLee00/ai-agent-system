#!/usr/bin/env node
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config');

const runtimeConfig = getBlogHealthRuntimeConfig();
const HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.n8nHealthUrl || 'http://127.0.0.1:5678/healthz';
const DEFAULT_WEBHOOK_URL = process.env.N8N_BLOG_WEBHOOK || runtimeConfig.blogWebhookUrl || 'http://127.0.0.1:5678/webhook/blog-pipeline';

async function main() {
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '블로그팀 동적 포스팅',
    method: 'POST',
    pathSuffix: 'blog-pipeline',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_WEBHOOK_URL;
  const healthOk = await checkHttp(HEALTH_URL, Number(runtimeConfig.n8nHealthTimeoutMs || 2500));
  const webhook = await checkWebhookRegistration(webhookUrl, {
    postType: 'general',
    sessionId: 'n8n-blog-health-probe',
    pipeline: ['weather'],
    variations: {},
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
  console.error(`[blog n8n pipeline path] ${error.message}`);
  process.exit(1);
});

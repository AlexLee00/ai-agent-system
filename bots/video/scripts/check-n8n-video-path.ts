// @ts-nocheck
#!/usr/bin/env node
'use strict';

const { checkHttp, checkWebhookRegistration } = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { loadConfig } = require('../src/index');
const { resolveVideoN8nToken } = require('../lib/video-n8n-config');

async function main() {
  const config = loadConfig();
  const healthUrl = config?.n8n?.health_url || 'http://127.0.0.1:5678/healthz';
  const baseUrl = config?.n8n?.base_url || 'http://127.0.0.1:5678';
  const workflowName = config?.n8n?.workflow_name || 'Video Pipeline';
  const webhookPath = config?.n8n?.webhook_path || 'video-pipeline';
  const token = resolveVideoN8nToken(config);
  const defaultWebhookUrl = `${String(baseUrl).replace(/\/+$/, '')}/webhook/${webhookPath}`;

  let resolvedWebhookUrl = null;
  let resolveError = null;
  try {
    resolvedWebhookUrl = await resolveProductionWebhookUrl({
      workflowName,
      method: 'POST',
      pathSuffix: webhookPath,
      baseUrl,
    });
  } catch (error) {
    resolveError = error?.message || String(error);
  }
  const webhookUrl = resolvedWebhookUrl || defaultWebhookUrl;
  const healthOk = await checkHttp(healthUrl, 2500);
  const webhook = await checkWebhookRegistration(webhookUrl, {
    sessionId: 0,
    pairIndex: 1,
    sourceVideoPath: '/tmp/probe.mp4',
    sourceAudioPath: '/tmp/probe.m4a',
    title: 'health-probe',
    editNotes: '',
    skipRender: true,
  }, {
    timeoutMs: 5000,
    headers: token ? { 'X-Video-Token': token } : {},
  });

  console.log(JSON.stringify({
    healthUrl,
    webhookUrl,
    resolvedWebhookUrl,
    defaultWebhookUrl,
    n8nHealthy: healthOk,
    webhookRegistered: webhook.registered,
    webhookStatus: webhook.status,
    webhookReason: webhook.reason,
    webhookHealthy: webhook.healthy,
    webhookError: webhook.error || null,
    registryResolveError: resolveError,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[video n8n path] ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});

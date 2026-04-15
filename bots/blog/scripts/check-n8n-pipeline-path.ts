#!/usr/bin/env node
// @ts-nocheck
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

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

  const payload = {
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
  payload.aiSummary = await buildBlogCliInsight({
    bot: 'check-n8n-pipeline-path',
    requestType: 'n8n-pipeline-path',
    title: '블로그 n8n pipeline path 진단 결과',
    data: {
      n8nHealthy: payload.n8nHealthy,
      webhookRegistered: payload.webhookRegistered,
      webhookHealthy: payload.webhookHealthy,
      webhookStatus: payload.webhookStatus,
      webhookReason: payload.webhookReason,
      webhookError: payload.webhookError,
    },
    fallback: payload.n8nHealthy && payload.webhookRegistered && payload.webhookHealthy
      ? '블로그 n8n 파이프라인 경로가 정상이라 동적 포스팅 웹훅 유입은 현재 안정적입니다.'
      : '블로그 n8n 파이프라인 경로에 경고가 있어 웹훅 등록과 응답 상태를 우선 점검하는 편이 좋습니다.',
  });

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(`[blog n8n pipeline path] ${error.message}`);
  process.exit(1);
});

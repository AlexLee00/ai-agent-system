// @ts-nocheck
#!/usr/bin/env node
'use strict';

const { checkHttp, checkWebhookRegistration } = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { loadConfig } = require('../src/index');
const { resolveVideoN8nToken } = require('../lib/video-n8n-config');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');
const { buildVideoCliInsight } = require('../lib/cli-insight.js');

const videoPathMemory = createAgentMemory({ agentId: 'video.n8n-path', team: 'video' });

function buildVideoPathMemoryQuery(kind, extras = []) {
  return [
    'video n8n path',
    kind,
    ...extras,
  ].filter(Boolean).join(' ');
}

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
  const n8nHealthy = healthOk;
  const webhookRegistered = webhook.registered;
  const kind = n8nHealthy && webhookRegistered ? 'healthy' : 'issue';
  const memoryQuery = buildVideoPathMemoryQuery(kind, [
    n8nHealthy ? 'n8n-ok' : 'n8n-fail',
    webhookRegistered ? 'webhook-ok' : 'webhook-missing',
  ]);
  const episodicHint = await videoPathMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 진단',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      healthy: '정상',
      issue: '이슈',
    },
    order: ['issue', 'healthy'],
  }).catch(() => '');
  const semanticHint = await videoPathMemory.recallHint(`${memoryQuery} consolidated video path pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const summary = [
    '비디오 n8n path 진단',
    `n8n healthy: ${n8nHealthy}`,
    `webhook registered: ${webhookRegistered}`,
    `webhook status: ${webhook.status}`,
    resolveError ? `registry resolve error: ${resolveError}` : null,
    webhook.reason ? `reason: ${webhook.reason}` : null,
  ].filter(Boolean).join('\n');
  const aiSummary = await buildVideoCliInsight({
    bot: 'check-n8n-video-path',
    requestType: 'n8n-video-path',
    title: '비디오 n8n path 진단 결과',
    data: {
      n8nHealthy,
      webhookRegistered,
      webhookHealthy: webhook.healthy,
      webhookStatus: webhook.status,
      webhookReason: webhook.reason,
      webhookError: webhook.error || null,
      registryResolveError: resolveError,
    },
    fallback: n8nHealthy && webhookRegistered && webhook.healthy
      ? '비디오 n8n 경로가 정상이라 파이프라인 웹훅 유입은 현재 안정적입니다.'
      : '비디오 n8n 경로에 경고가 있어 레지스트리 해석과 웹훅 응답 상태를 우선 점검하는 편이 좋습니다.',
  });

  console.log(JSON.stringify({
    healthUrl,
    webhookUrl,
    resolvedWebhookUrl,
    defaultWebhookUrl,
    n8nHealthy,
    webhookRegistered,
    webhookStatus: webhook.status,
    webhookReason: webhook.reason,
    webhookHealthy: webhook.healthy,
    webhookError: webhook.error || null,
    registryResolveError: resolveError,
    memoryHints: {
      episodicHint,
      semanticHint,
    },
    aiSummary,
  }, null, 2));

  await videoPathMemory.remember(summary, 'episodic', {
    importance: kind === 'issue' ? 0.74 : 0.58,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind,
      n8nHealthy,
      webhookRegistered,
      webhookStatus: webhook.status || null,
    },
  }).catch(() => {});
  await videoPathMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
}

main().catch((error) => {
  console.error(`[video n8n path] ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});

// @ts-nocheck
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { getWorkerN8nRuntimeConfig } = require('../lib/runtime-config');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');
const { buildWorkerCliInsight } = require('../lib/cli-insight.legacy.js');

const runtimeConfig = getWorkerN8nRuntimeConfig();
const HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.healthUrl;
const DEFAULT_WEBHOOK_URL = process.env.N8N_WORKER_WEBHOOK || runtimeConfig.workerWebhookUrl;
const intakePathMemory = createAgentMemory({ agentId: 'worker.n8n-intake-path', team: 'worker' });

function buildIntakePathMemoryQuery(kind, extras = []) {
  return [
    'worker n8n intake path',
    kind,
    ...extras,
  ].filter(Boolean).join(' ');
}

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
  const n8nHealthy = healthOk;
  const webhookRegistered = webhook.registered;
  const kind = n8nHealthy && webhookRegistered ? 'healthy' : 'issue';
  const memoryQuery = buildIntakePathMemoryQuery(kind, [
    n8nHealthy ? 'n8n-ok' : 'n8n-fail',
    webhookRegistered ? 'webhook-ok' : 'webhook-missing',
  ]);
  const episodicHint = await intakePathMemory.recallCountHint(memoryQuery, {
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
  const semanticHint = await intakePathMemory.recallHint(`${memoryQuery} consolidated intake pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const summary = [
    '워커 n8n intake path 진단',
    `n8n healthy: ${n8nHealthy}`,
    `webhook registered: ${webhookRegistered}`,
    `webhook status: ${webhook.status}`,
    webhook.reason ? `reason: ${webhook.reason}` : null,
  ].filter(Boolean).join('\n');
  const aiSummary = await buildWorkerCliInsight({
    bot: 'check-n8n-intake-path',
    requestType: 'n8n-intake-path',
    title: '워커 n8n intake path 진단 결과',
    data: {
      n8nHealthy,
      webhookRegistered,
      webhookHealthy: webhook.healthy,
      webhookStatus: webhook.status,
      webhookReason: webhook.reason,
      webhookError: webhook.error || null,
    },
    fallback: n8nHealthy && webhookRegistered && webhook.healthy
      ? '워커 n8n intake 경로가 정상이라 자연어 업무 유입은 현재 안정적입니다.'
      : '워커 n8n intake 경로에 경고가 있어 웹훅 등록과 응답 상태를 우선 점검하는 편이 좋습니다.',
  });

  console.log(JSON.stringify({
    healthUrl: HEALTH_URL,
    webhookUrl,
    resolvedWebhookUrl,
    defaultWebhookUrl: DEFAULT_WEBHOOK_URL,
    n8nHealthy,
    webhookRegistered,
    webhookStatus: webhook.status,
    webhookReason: webhook.reason,
    webhookHealthy: webhook.healthy,
    webhookError: webhook.error || null,
    memoryHints: {
      episodicHint,
      semanticHint,
    },
    aiSummary,
  }, null, 2));

  await intakePathMemory.remember(summary, 'episodic', {
    importance: kind === 'issue' ? 0.74 : 0.58,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind,
      n8nHealthy,
      webhookRegistered,
      webhookStatus: webhook.status || null,
    },
  }).catch(() => {});
  await intakePathMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
}

main().catch((error) => {
  console.error(`[worker n8n intake path] ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const {
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');
const { buildReservationCliInsight } = require('../lib/cli-insight');

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

  report.aiSummary = await buildReservationCliInsight({
    bot: 'check-n8n-command-path',
    requestType: 'n8n-command-path',
    title: '예약 스카 n8n 명령 경로 점검',
    data: {
      n8nHealthy: report.n8nHealthy,
      webhookRegistered: report.webhookRegistered,
      webhookHealthy: report.webhookHealthy,
      webhookStatus: report.webhookStatus,
      webhookReason: report.webhookReason,
      webhookError: report.webhookError,
    },
    fallback: report.n8nHealthy && report.webhookRegistered && report.webhookHealthy
      ? 'n8n 명령 경로가 정상이라 스카 읽기 명령은 현재 안정적으로 연결돼 있습니다.'
      : 'n8n 명령 경로에 경고가 있어 스카 읽기 명령 intake를 우선 점검하는 편이 좋습니다.',
  });

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

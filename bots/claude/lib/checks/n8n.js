'use strict';
/**
 * checks/n8n.js — n8n 워크플로우 서버/critical webhook 헬스체크
 */

const {
  checkHttp,
  buildResolvedWebhookHealth,
} = require('../../../../packages/core/lib/health-provider');
const cfg = require('../config');

const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || cfg.RUNTIME?.n8n?.healthUrl || 'http://127.0.0.1:5678/healthz';
const DEFAULT_CRITICAL_WEBHOOK_URL = process.env.N8N_CRITICAL_WEBHOOK || cfg.RUNTIME?.n8n?.criticalWebhookUrl || 'http://127.0.0.1:5678/webhook/critical';
const N8N_TIMEOUT_MS = Number(cfg.RUNTIME?.n8n?.timeoutMs || 5000);

async function run() {
  const items = [];

  const n8nHealthy = await checkHttp(N8N_HEALTH_URL, N8N_TIMEOUT_MS);
  items.push({
    status: n8nHealthy ? 'ok' : 'warn',
    label: 'n8n 워크플로우 서버',
    detail: n8nHealthy ? 'healthz 정상' : 'healthz 응답 없음',
  });

  const criticalWebhook = await buildResolvedWebhookHealth(/** @type {any} */ ({
    workflowName: 'CRITICAL 알림 에스컬레이션',
    pathSuffix: 'critical',
    defaultWebhookUrl: DEFAULT_CRITICAL_WEBHOOK_URL,
    label: 'n8n critical webhook',
    probeBody: {
      severity: 'critical',
      service: 'claude-health-check',
      status: 'probe',
      detail: 'n8n critical webhook health probe',
    },
    timeoutMs: N8N_TIMEOUT_MS,
  }));

  items.push({
    status: criticalWebhook.warn.length ? 'warn' : 'ok',
    label: 'n8n critical webhook',
    detail: criticalWebhook.warn[0] || criticalWebhook.ok[0] || '상태 확인 불가',
  });

  return {
    name: 'n8n 워크플로우',
    status: items.some((item) => item.status === 'warn') ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

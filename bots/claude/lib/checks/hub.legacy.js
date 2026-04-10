'use strict';

const { checkHttp, fetchJson } = require('../../../../packages/core/lib/health-provider');
const env = require('../../../../packages/core/lib/env');

const HUB_HEALTH_URL = process.env.HUB_HEALTH_URL || 'http://127.0.0.1:7788/hub/health';
const HUB_TIMEOUT_MS = 3000;

async function run() {
  if (!env.LAUNCHD_AVAILABLE) {
    return {
      name: 'Resource API Hub',
      status: 'ok',
      items: [{ status: 'ok', label: 'Hub', detail: 'DEV 환경 — 체크 스킵' }],
    };
  }

  const items = [];
  const healthy = await checkHttp(HUB_HEALTH_URL, HUB_TIMEOUT_MS);
  items.push({
    status: healthy ? 'ok' : 'warn',
    label: 'Resource API Hub',
    detail: healthy ? 'health 정상' : 'Hub 응답 없음 (DEV 접근 불가)',
  });

  if (healthy) {
    const data = await fetchJson(HUB_HEALTH_URL, HUB_TIMEOUT_MS);
    if (data?.resources) {
      for (const [name, info] of Object.entries(data.resources)) {
        items.push({
          status: info.status || 'ok',
          label: `Hub → ${name}`,
          detail: info.detail || `${info.latency_ms || '?'}ms`,
        });
      }
    }
  }

  const status = items.some((item) => item.status === 'warn' || item.status === 'error')
    ? 'warn'
    : 'ok';

  return {
    name: 'Resource API Hub',
    status,
    items,
  };
}

module.exports = { run };

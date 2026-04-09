'use strict';

const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { checkHttp } = require('../../../../packages/core/lib/health-provider');

async function healthRoute(req, res) {
  const started = Date.now();
  const resources = {};

  try {
    const pgStart = Date.now();
    await pgPool.query('public', 'SELECT 1 AS ok');
    resources.postgresql = {
      status: 'ok',
      detail: 'query ok',
      latency_ms: Date.now() - pgStart,
    };
  } catch (error) {
    resources.postgresql = {
      status: 'warn',
      detail: String(error?.message || 'pg_failed'),
    };
  }

  if (env.N8N_ENABLED) {
    const n8nStart = Date.now();
    const ok = await checkHttp(`${env.N8N_BASE_URL}/healthz`, 3000);
    resources.n8n = {
      status: ok ? 'ok' : 'warn',
      detail: ok ? 'health ok' : 'health unreachable',
      latency_ms: Date.now() - n8nStart,
    };
  } else {
    resources.n8n = {
      status: 'ok',
      detail: 'disabled in current mode',
    };
  }

  const hasWarn = Object.values(resources).some((item) => item.status !== 'ok');

  res.json({
    status: hasWarn ? 'warn' : 'ok',
    mode: env.MODE,
    uptime_s: Math.round(process.uptime()),
    latency_ms: Date.now() - started,
    resources,
  });
}

module.exports = {
  healthRoute,
};

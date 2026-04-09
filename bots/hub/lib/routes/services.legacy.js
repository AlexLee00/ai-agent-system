'use strict';

const env = require('../../../../packages/core/lib/env');
const { getLaunchctlStatus } = require('../../../../packages/core/lib/health-provider');

const SERVICE_LABELS = [
  'ai.orchestrator',
  'ai.openclaw.gateway',
  'ai.claude.commander',
  'ai.claude.dexter',
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.blog.node-server',
  'ai.worker.web',
  'ai.worker.nextjs',
  'ai.worker.lead',
  'ai.worker.task-runner',
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.n8n.server',
  'ai.hub.resource-api',
];

async function servicesStatusRoute(req, res) {
  if (!env.LAUNCHD_AVAILABLE) {
    return res.json({
      status: 'ok',
      detail: 'launchd unavailable in current mode',
      services: {},
    });
  }

  const status = getLaunchctlStatus(SERVICE_LABELS);
  return res.json({
    status: 'ok',
    services: status,
  });
}

async function envRoute(req, res) {
  return res.json({
    mode: env.MODE,
    node_env: env.NODE_ENV,
    paper_mode: env.PAPER_MODE,
    n8n_enabled: env.N8N_ENABLED,
    launchd_available: env.LAUNCHD_AVAILABLE,
    pg_host: env.PG_HOST,
    pg_port: env.PG_PORT,
    hub_port: env.HUB_PORT,
    openclaw_port: env.OPENCLAW_PORT,
    use_hub: env.USE_HUB,
  });
}

module.exports = {
  servicesStatusRoute,
  envRoute,
};

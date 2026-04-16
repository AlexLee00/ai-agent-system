'use strict';

const SERVICE_CATALOG = [
  { label: 'ai.openclaw.gateway', owner: 'launchd', core: true },
  { label: 'ai.n8n.server', owner: 'launchd', core: true },
  { label: 'ai.mlx.server', owner: 'launchd' },

  { label: 'ai.claude.commander', owner: 'launchd' },
  { label: 'ai.claude.dexter', owner: 'launchd', expectedIdle: true },
  { label: 'ai.claude.dexter.quick', owner: 'launchd', expectedIdle: true },
  { label: 'ai.claude.dexter.daily', owner: 'launchd', expectedIdle: true },
  { label: 'ai.claude.archer', owner: 'launchd' },

  { label: 'ai.ska.commander', owner: 'launchd' },
  { label: 'ai.ska.naver-monitor', owner: 'launchd' },
  { label: 'ai.ska.kiosk-monitor', owner: 'launchd' },
  { label: 'ai.ska.etl', owner: 'launchd', optional: true },
  { label: 'ai.ska.eve', owner: 'launchd', optional: true },
  { label: 'ai.ska.eve-crawl', owner: 'launchd', optional: true },
  { label: 'ai.ska.rebecca', owner: 'launchd', optional: true },
  { label: 'ai.ska.rebecca-weekly', owner: 'launchd', optional: true },
  { label: 'ai.ska.forecast-daily', owner: 'launchd', optional: true },
  { label: 'ai.ska.forecast-weekly', owner: 'launchd', optional: true },
  { label: 'ai.ska.pickko-verify', owner: 'launchd', optional: true },
  { label: 'ai.ska.pickko-daily-audit', owner: 'launchd', optional: true },

  { label: 'ai.investment.commander', owner: 'launchd' },
  { label: 'ai.investment.crypto', owner: 'launchd', expectedIdle: true },
  { label: 'ai.investment.crypto.validation', owner: 'launchd', optional: true, expectedIdle: true },
  { label: 'ai.investment.domestic', owner: 'launchd', expectedIdle: true },
  { label: 'ai.investment.domestic.validation', owner: 'launchd', optional: true, expectedIdle: true },
  { label: 'ai.investment.overseas', owner: 'launchd', expectedIdle: true },
  { label: 'ai.investment.overseas.validation', owner: 'launchd', optional: true, expectedIdle: true },
  { label: 'ai.investment.argos', owner: 'launchd', optional: true, expectedIdle: true },
  { label: 'ai.investment.reporter', owner: 'launchd', optional: true, expectedIdle: true },

  { label: 'ai.blog.node-server', owner: 'elixir', healthUrl: 'http://127.0.0.1:3100/health' },
  { label: 'ai.worker.web', owner: 'elixir', healthUrl: 'http://127.0.0.1:4000/api/health' },
  { label: 'ai.worker.nextjs', owner: 'elixir', healthUrl: 'http://127.0.0.1:4001' },
  { label: 'ai.worker.lead', owner: 'elixir' },
  { label: 'ai.worker.task-runner', owner: 'elixir' },
  { label: 'ai.hub.resource-api', owner: 'elixir', healthUrl: 'http://127.0.0.1:7788/hub/health' },

  { label: 'ai.orchestrator', owner: 'retired', retired: true },
];

const CATALOG_BY_LABEL = new Map(SERVICE_CATALOG.map((entry) => [entry.label, entry]));

function getServiceCatalog() {
  return SERVICE_CATALOG.slice();
}

function getServiceOwnership(label) {
  return CATALOG_BY_LABEL.get(String(label || '')) || null;
}

function isElixirOwnedService(label) {
  return getServiceOwnership(label)?.owner === 'elixir';
}

function isRetiredService(label) {
  return getServiceOwnership(label)?.retired === true;
}

function isExpectedIdleService(label) {
  return getServiceOwnership(label)?.expectedIdle === true;
}

function getHubServiceLabels() {
  return [
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
    'ai.mlx.server',
    'ai.n8n.server',
    'ai.hub.resource-api',
  ];
}

function getHubCoreServiceLabels() {
  return SERVICE_CATALOG.filter((entry) => entry.core).map((entry) => entry.label);
}

module.exports = {
  SERVICE_CATALOG,
  getServiceCatalog,
  getServiceOwnership,
  getHubServiceLabels,
  getHubCoreServiceLabels,
  isElixirOwnedService,
  isRetiredService,
  isExpectedIdleService,
};

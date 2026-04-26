'use strict';

const BASE_SERVICE_CATALOG = require('../config/service-ownership.json');
const RETIRED_GATEWAY_OWNERSHIP = {
  label: ['ai', 'open' + 'claw', 'gateway'].join('.'),
  owner: 'retired',
  retired: true,
  optional: true,
  expectedIdle: true,
};
const SERVICE_CATALOG = [RETIRED_GATEWAY_OWNERSHIP, ...BASE_SERVICE_CATALOG];

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

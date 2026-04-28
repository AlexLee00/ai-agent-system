'use strict';

const { createLunaCommanderAdapter } = require('./luna-adapter');
const { createBlogCommanderAdapter } = require('./blog-adapter');
const { createClaudeCommanderAdapter } = require('./claude-adapter');
const { createSkaCommanderAdapter } = require('./ska-adapter');
const { createVideoCommanderAdapter } = require('./video-adapter');
const { createDarwinCommanderAdapter } = require('./darwin-adapter');
const { createLegalCommanderAdapter } = require('./legal-adapter');
const { createWorkerCommanderAdapter } = require('./worker-adapter');
const { createVirtualCommanderAdapter } = require('../../../../packages/core/lib/commander-contract.ts');

const ADAPTER_FACTORIES = {
  luna: createLunaCommanderAdapter,
  blog: createBlogCommanderAdapter,
  claude: createClaudeCommanderAdapter,
  ska: createSkaCommanderAdapter,
  video: createVideoCommanderAdapter,
  darwin: createDarwinCommanderAdapter,
  legal: createLegalCommanderAdapter,
  worker: createWorkerCommanderAdapter,
};

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getCommanderAdapter(team) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const create = ADAPTER_FACTORIES[normalizedTeam];
  if (!create) return createVirtualCommanderAdapter(normalizedTeam, { label: `${normalizedTeam}-virtual` });
  return create();
}

function listCommanderTeams() {
  return Object.keys(ADAPTER_FACTORIES);
}

module.exports = {
  getCommanderAdapter,
  listCommanderTeams,
};

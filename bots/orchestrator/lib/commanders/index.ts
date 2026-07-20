'use strict';

const { createLunaCommanderAdapter } = require('./luna-adapter');
const { createBlogCommanderAdapter } = require('./blog-adapter');
const { createClaudeCommanderAdapter } = require('./claude-adapter');
const { createSkaCommanderAdapter } = require('./ska-adapter');
const { createDarwinCommanderAdapter } = require('./darwin-adapter');
const { createVirtualCommanderAdapter } = require('../../../../packages/core/lib/commander-contract.ts');

const ADAPTER_FACTORIES = {
  luna: createLunaCommanderAdapter,
  blog: createBlogCommanderAdapter,
  claude: createClaudeCommanderAdapter,
  ska: createSkaCommanderAdapter,
  darwin: createDarwinCommanderAdapter,
};

type CommanderTeam = keyof typeof ADAPTER_FACTORIES;

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getCommanderAdapter(team: unknown) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const create = ADAPTER_FACTORIES[normalizedTeam as CommanderTeam];
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

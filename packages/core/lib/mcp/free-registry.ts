// @ts-nocheck
'use strict';

const FREE_MCP_REGISTRY = {
  github: {
    id: 'github',
    label: 'GitHub MCP',
    cost: 'free',
    mode: 'remote',
    capabilities: ['repo-search', 'code-search', 'release-check', 'issue-pr-context'],
    preferredTeams: ['darwin', 'sigma'],
    taskHints: ['research', 'search', 'code', 'trend', 'experiment'],
  },
  postgresql: {
    id: 'postgresql',
    label: 'PostgreSQL MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['sql-query', 'jsonb-inspect', 'metrics', 'catalog'],
    preferredTeams: ['justin', 'sigma'],
    taskHints: ['citation', 'evidence', 'quality', 'etl', 'analysis'],
  },
  filesystem: {
    id: 'filesystem',
    label: 'Filesystem MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['read-files', 'write-files', 'artifact-inspect', 'report-assemble'],
    preferredTeams: ['darwin', 'justin', 'sigma'],
    taskHints: ['research', 'citation', 'evidence', 'quality', 'report'],
  },
  'desktop-commander': {
    id: 'desktop-commander',
    label: 'Desktop Commander MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['process-check', 'command-run', 'system-inspect'],
    preferredTeams: ['sigma'],
    taskHints: ['quality', 'etl', 'analysis', 'ops'],
  },
  'tradingview-market': {
    id: 'tradingview-market',
    label: 'TradingView Market MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['quote', 'ohlcv', 'indicators', 'multi-symbol-quote'],
    preferredTeams: ['investment', 'luna'],
    taskHints: ['trading', 'market', 'analysis', 'signal', 'research'],
  },
  'toss-market-intel': {
    id: 'toss-market-intel',
    label: 'Toss Market Intel MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['community-intel', 'screening-candidates', 'section-scan'],
    preferredTeams: ['investment', 'luna'],
    taskHints: ['trading', 'market', 'screening', 'signal', 'research'],
  },
  'kis-market': {
    id: 'kis-market',
    label: 'KIS Market MCP',
    cost: 'free',
    mode: 'local',
    capabilities: ['domestic-quote', 'overseas-quote', 'balance-check'],
    preferredTeams: ['investment', 'luna'],
    taskHints: ['trading', 'market', 'execution', 'signal', 'ops'],
  },
};

function getMcpDefinition(id) {
  return FREE_MCP_REGISTRY[id] || null;
}

function listMcps() {
  return Object.values(FREE_MCP_REGISTRY);
}

module.exports = { FREE_MCP_REGISTRY, getMcpDefinition, listMcps };

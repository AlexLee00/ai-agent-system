// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCollaborationMatrix, getCollaborationFlow } from './agent-collaboration-matrix.ts';
import { listAgentDefinitions } from './agent-yaml-loader.ts';
import { loadInvestmentSkills } from './skill-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const INVESTMENT_ROOT = path.resolve(path.dirname(__filename), '..');

export const LUNA_CORE_AGENT_NAMES = [
  'luna',
  'aria',
  'sophia',
  'hermes',
  'oracle',
  'argos',
  'stock-flow',
  'chronos',
  'zeus',
  'athena',
  'nemesis',
  'hephaestos',
  'hanul',
  'adaptive-risk',
  'budget',
  'sentinel',
  'scout',
  'sweeper',
  'reporter',
];

export const LUNA_SHADOW_EXTENSION_AGENT_NAMES = ['kairos'];

export const REQUIRED_SKILLS_BY_OWNER = {
  aria: [
    'ta-divergence-detector',
    'ta-chart-patterns',
    'ta-support-resistance',
    'ta-ma-cross-detector',
    'ta-weighted-voting',
    'ta-bullish-entry-conditions',
    'ta-weight-adaptive-tuner',
  ],
  hermes: ['news-to-symbol-mapper'],
  oracle: ['coingecko-trending'],
  argos: ['prescreen-domestic', 'prescreen-overseas', 'discovery-orchestrator', 'discovery-store'],
  scout: [
    'scout-scraper',
    'toss-popular-100',
    'toss-market-intel',
    'yahoo-trending-collector',
    'sec-edgar-collector',
    'dart-disclosure-collector',
  ],
  'stock-flow': ['domestic-validation', 'overseas-validation'],
  hephaestos: ['crypto-validation'],
  chronos: ['ml-price-predictor', 'backtest-runner'],
  luna: ['shadow-auto-promote', 'luna-l5-readiness', 'luna-entry-trigger', 'posttrade-feedback', 'daily-feedback', 'daily-report', 'weekly-review'],
  nemesis: ['hard-rule'],
  sweeper: ['maintenance-collect', 'position-watch', 'unrealized-pnl'],
  sentinel: ['health-check'],
  reporter: [
    'market-alert-crypto-daily',
    'market-alert-domestic-open',
    'market-alert-domestic-close',
    'market-alert-overseas-open',
    'market-alert-overseas-close',
    'position-runtime-autopilot',
  ],
  kairos: ['walk-forward-validation', 'monte-carlo-simulation'],
};

const REQUIRED_MCP_FILES = [
  'mcp/luna-marketdata-mcp/package.json',
  'mcp/luna-marketdata-mcp/README.md',
  'mcp/luna-marketdata-mcp/src/server.ts',
  'mcp/luna-marketdata-mcp/src/tools/binance-ws.ts',
  'mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts',
  'mcp/luna-marketdata-mcp/src/tools/kis-ws-overseas.ts',
  'mcp/luna-marketdata-mcp/src/tools/tradingview-ws.ts',
];

const REQUIRED_ELIXIR_AGENT_FILES = [
  'elixir/lib/luna/v2/agents/stock_flow.ex',
  'elixir/lib/luna/v2/agents/sweeper.ex',
  'elixir/lib/luna/v2/supervisor.ex',
];

const REQUIRED_FLOW_TYPES = ['discovery_entry', 'risk_execution', 'posttrade_learning', 'maintenance_sync'];

function relExists(relPath) {
  return fs.existsSync(path.join(INVESTMENT_ROOT, relPath));
}

function listMissing(expected, actualSet) {
  return expected.filter((item) => !actualSet.has(item));
}

function buildSkillCoverage() {
  const skills = loadInvestmentSkills();
  const byOwner = new Map();
  for (const skill of skills) {
    if (!byOwner.has(skill.owner)) byOwner.set(skill.owner, new Set());
    byOwner.get(skill.owner).add(skill.name);
  }
  const missing = [];
  const owners = {};
  for (const [owner, required] of Object.entries(REQUIRED_SKILLS_BY_OWNER)) {
    const existing = byOwner.get(owner) || new Set();
    const missingForOwner = required.filter((name) => !existing.has(name));
    if (missingForOwner.length > 0) missing.push({ owner, skills: missingForOwner });
    owners[owner] = {
      required,
      present: required.filter((name) => existing.has(name)),
      missing: missingForOwner,
      totalOwned: existing.size,
    };
  }
  return {
    ok: missing.length === 0,
    totalSkills: skills.length,
    owners,
    missing,
  };
}

function buildMcpCoverage() {
  const files = REQUIRED_MCP_FILES.map((file) => ({ file, exists: relExists(file) }));
  const missing = files.filter((item) => !item.exists).map((item) => item.file);
  return { ok: missing.length === 0, files, missing };
}

function buildElixirCoverage() {
  const files = REQUIRED_ELIXIR_AGENT_FILES.map((file) => ({ file, exists: relExists(file) }));
  const supervisorPath = path.join(INVESTMENT_ROOT, 'elixir/lib/luna/v2/supervisor.ex');
  const supervisorText = fs.existsSync(supervisorPath) ? fs.readFileSync(supervisorPath, 'utf8') : '';
  const supervisorAgents = ['Luna.V2.Agents.StockFlow', 'Luna.V2.Agents.Sweeper'];
  const missingSupervisorAgents = supervisorAgents.filter((name) => !supervisorText.includes(name));
  const missing = files.filter((item) => !item.exists).map((item) => item.file);
  return {
    ok: missing.length === 0 && missingSupervisorAgents.length === 0,
    files,
    missing,
    supervisorAgents,
    missingSupervisorAgents,
  };
}

function buildFlowCoverage(agents) {
  const flows = REQUIRED_FLOW_TYPES.map((type) => getCollaborationFlow(type, { agents }));
  return {
    ok: flows.every((flow) => flow.ok),
    flows: flows.map((flow) => ({
      decisionType: flow.decisionType,
      ok: flow.ok,
      steps: flow.steps.length,
      missingAgents: flow.missingAgents,
      dryRunDefault: flow.dryRunDefault,
      publishDefault: flow.publishDefault,
    })),
  };
}

export function buildLunaAgentNormalizationReport({ agents = listAgentDefinitions() } = {}) {
  const agentNames = new Set(agents.map((agent) => agent.name));
  const coreMissing = listMissing(LUNA_CORE_AGENT_NAMES, agentNames);
  const shadowMissing = listMissing(LUNA_SHADOW_EXTENSION_AGENT_NAMES, agentNames);
  const validationErrors = agents
    .filter((agent) => agent.validation?.ok !== true)
    .map((agent) => ({ name: agent.name, errors: agent.validation?.errors || ['invalid'] }));
  const matrix = buildCollaborationMatrix(agents);
  const skillCoverage = buildSkillCoverage();
  const mcpCoverage = buildMcpCoverage();
  const elixirCoverage = buildElixirCoverage();
  const flowCoverage = buildFlowCoverage(agents);
  const blockers = [
    ...coreMissing.map((name) => `core_agent_missing:${name}`),
    ...shadowMissing.map((name) => `shadow_extension_agent_missing:${name}`),
    ...validationErrors.map((item) => `agent_yaml_invalid:${item.name}:${item.errors.join('|')}`),
    ...matrix.missingReferences.map((item) => `collaboration_missing:${item.from}->${item.to}:${item.kind}`),
    ...skillCoverage.missing.map((item) => `skill_missing:${item.owner}:${item.skills.join(',')}`),
    ...mcpCoverage.missing.map((file) => `mcp_file_missing:${file}`),
    ...elixirCoverage.missing.map((file) => `elixir_file_missing:${file}`),
    ...elixirCoverage.missingSupervisorAgents.map((name) => `elixir_supervisor_agent_missing:${name}`),
    ...flowCoverage.flows.flatMap((flow) => flow.missingAgents.map((name) => `flow_agent_missing:${flow.decisionType}:${name}`)),
  ];

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_agent_normalization_complete' : 'luna_agent_normalization_blocked',
    checkedAt: new Date().toISOString(),
    blockers,
    warnings: [],
    summary: {
      canonicalYamlAgents: agents.length,
      coreAgentCount: LUNA_CORE_AGENT_NAMES.filter((name) => agentNames.has(name)).length,
      shadowExtensionCount: LUNA_SHADOW_EXTENSION_AGENT_NAMES.filter((name) => agentNames.has(name)).length,
      skillCount: skillCoverage.totalSkills,
      mcpNormalized: mcpCoverage.ok,
      elixirStockFlowSweeperReady: elixirCoverage.ok,
      collaborationMatrixOk: matrix.ok,
      executableFlows: flowCoverage.flows.length,
    },
    evidence: {
      coreAgents: LUNA_CORE_AGENT_NAMES,
      shadowExtensions: LUNA_SHADOW_EXTENSION_AGENT_NAMES,
      yamlAgents: agents.map((agent) => ({
        name: agent.name,
        tier: Number(agent.tier),
        runtime: agent.runtime,
        validation: agent.validation,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      skillCoverage,
      mcpCoverage,
      elixirCoverage,
      flowCoverage,
      matrix: {
        totalAgents: matrix.totalAgents,
        byTier: matrix.byTier,
        missingReferences: matrix.missingReferences,
        cycleCount: matrix.cycles.length,
      },
    },
  };
}

export default {
  LUNA_CORE_AGENT_NAMES,
  LUNA_SHADOW_EXTENSION_AGENT_NAMES,
  REQUIRED_SKILLS_BY_OWNER,
  buildLunaAgentNormalizationReport,
};

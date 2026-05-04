// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLunaAgentNormalizationReport } from './luna-agent-normalization.ts';
import { createGuardrailRegistry, GUARDRAIL_CATEGORIES } from './guardrail-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const INVESTMENT_ROOT = path.resolve(path.dirname(__filename), '..');
const REPO_ROOT = path.resolve(INVESTMENT_ROOT, '../..');

const FIVE_ELIXIR_AGENTS = [
  { file: 'elixir/lib/luna/v2/agents/stock_flow.ex', supervisor: 'Luna.V2.Agents.StockFlow' },
  { file: 'elixir/lib/luna/v2/agents/sweeper.ex', supervisor: 'Luna.V2.Agents.Sweeper' },
  { file: 'elixir/lib/luna/v2/agents/aria.ex', supervisor: 'Luna.V2.Agents.Aria' },
  { file: 'elixir/lib/luna/v2/agents/sentinel.ex', supervisor: 'Luna.V2.Agents.Sentinel' },
  { file: 'elixir/lib/luna/v2/agents/argos.ex', supervisor: 'Luna.V2.Agents.Argos' },
];

const CORE_REFACTOR_LIBS = [
  'packages/core/lib/agent-yaml-loader.ts',
  'packages/core/lib/agent-collaboration-matrix.ts',
  'packages/core/lib/skill-registry.ts',
  'packages/core/lib/agent-runtime-router.ts',
];

const REFACTOR_AUDITS = [
  'scripts/refactor-naming-audit.ts',
  'scripts/refactor-function-audit.ts',
];

const GUARDRAIL_FILES = [
  'shared/guardrail-registry.ts',
  'scripts/luna-guardrails-smoke.ts',
  'scripts/runtime-luna-guardrails-hourly.ts',
  'launchd/retired/ai.luna.guardrails-hourly.retired.plist',
];

const TA_FILES = [
  'shared/ta-divergence-detector.ts',
  'shared/ta-chart-patterns.ts',
  'shared/ta-support-resistance.ts',
  'shared/ta-ma-cross-detector.ts',
  'shared/ta-weighted-voting.ts',
  'shared/ml-price-predictor.ts',
  'shared/ta-bullish-entry-conditions.ts',
  'shared/ta-weight-adaptive-tuner.ts',
  'shared/ta-integrated-scorer.ts',
  'scripts/luna-technical-analysis-boost-smoke.ts',
];

function investmentPath(relPath) {
  return path.join(INVESTMENT_ROOT, relPath);
}

function repoPath(relPath) {
  return path.join(REPO_ROOT, relPath);
}

function existsInInvestment(relPath) {
  return fs.existsSync(investmentPath(relPath));
}

function existsInRepo(relPath) {
  return fs.existsSync(repoPath(relPath));
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function loadPackageScripts() {
  const pkgPath = investmentPath('package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.scripts || {};
}

function phaseStatus(blockers) {
  return blockers.length === 0 ? 'complete' : 'blocked';
}

function buildPsiPhase(scripts) {
  const normalization = buildLunaAgentNormalizationReport();
  const supervisorText = readText(investmentPath('elixir/lib/luna/v2/supervisor.ex'));
  const elixirAgents = FIVE_ELIXIR_AGENTS.map((agent) => ({
    file: agent.file,
    exists: existsInInvestment(agent.file),
    supervisor: agent.supervisor,
    supervisorRegistered: supervisorText.includes(agent.supervisor),
  }));
  const blockers = [
    ...normalization.blockers,
    ...elixirAgents.filter((item) => !item.exists).map((item) => `elixir_agent_file_missing:${item.file}`),
    ...elixirAgents.filter((item) => !item.supervisorRegistered).map((item) => `elixir_supervisor_missing:${item.supervisor}`),
  ];
  if (!scripts['check:luna-agent-normalization']) blockers.push('package_script_missing:check:luna-agent-normalization');
  return {
    ok: blockers.length === 0,
    status: phaseStatus(blockers),
    blockers,
    summary: {
      canonicalYamlAgents: normalization.summary.canonicalYamlAgents,
      coreAgentCount: normalization.summary.coreAgentCount,
      shadowExtensionCount: normalization.summary.shadowExtensionCount,
      skillCount: normalization.summary.skillCount,
      executableFlows: normalization.summary.executableFlows,
      elixirShadowAgents: elixirAgents.filter((item) => item.exists && item.supervisorRegistered).length,
      mcpNormalized: normalization.summary.mcpNormalized,
    },
    evidence: {
      normalization: normalization.summary,
      elixirAgents,
      mcpCoverage: normalization.evidence.mcpCoverage,
      flowCoverage: normalization.evidence.flowCoverage,
    },
  };
}

function buildRefactorPhase(scripts) {
  const coreLibs = CORE_REFACTOR_LIBS.map((file) => ({ file, exists: existsInRepo(file) }));
  const audits = REFACTOR_AUDITS.map((file) => ({ file, exists: existsInInvestment(file) }));
  const blockers = [
    ...coreLibs.filter((item) => !item.exists).map((item) => `core_refactor_lib_missing:${item.file}`),
    ...audits.filter((item) => !item.exists).map((item) => `refactor_audit_missing:${item.file}`),
  ];
  if (!scripts['check:luna-final-closure-wave2']) blockers.push('package_script_missing:check:luna-final-closure-wave2');
  return {
    ok: blockers.length === 0,
    status: phaseStatus(blockers),
    blockers,
    warnings: ['refactor_audits_are_advisory_by_design'],
    summary: {
      coreLibsReady: coreLibs.filter((item) => item.exists).length,
      auditScriptsReady: audits.filter((item) => item.exists).length,
      wave2ScriptReady: Boolean(scripts['check:luna-final-closure-wave2']),
    },
    evidence: { coreLibs, audits },
  };
}

function buildGuardrailPhase(scripts) {
  const registry = createGuardrailRegistry();
  const entries = registry.list();
  const byCategory = Object.fromEntries(GUARDRAIL_CATEGORIES.map((category) => [category, registry.list(category).length]));
  const files = GUARDRAIL_FILES.map((file) => ({ file, exists: existsInInvestment(file) }));
  const blockers = [
    ...files.filter((item) => !item.exists).map((item) => `guardrail_file_missing:${item.file}`),
    ...GUARDRAIL_CATEGORIES.filter((category) => byCategory[category] < 1).map((category) => `guardrail_category_missing:${category}`),
  ];
  if (entries.length < 50) blockers.push(`guardrail_registry_too_small:${entries.length}`);
  if (!scripts['check:luna-final-closure-wave3']) blockers.push('package_script_missing:check:luna-final-closure-wave3');
  return {
    ok: blockers.length === 0,
    status: phaseStatus(blockers),
    blockers,
    summary: {
      totalGuardrails: entries.length,
      byCategory,
      hourlyRunnerReady: existsInInvestment('scripts/runtime-luna-guardrails-hourly.ts'),
      wave3ScriptReady: Boolean(scripts['check:luna-final-closure-wave3']),
    },
    evidence: { files, sample: entries.slice(0, 10).map((entry) => ({ name: entry.name, category: entry.category, owner: entry.owner })) },
  };
}

function buildTaPhase(scripts) {
  const files = TA_FILES.map((file) => ({ file, exists: existsInInvestment(file) }));
  const blockers = files.filter((item) => !item.exists).map((item) => `ta_file_missing:${item.file}`);
  if (!scripts['check:luna-technical-analysis-boost']) blockers.push('package_script_missing:check:luna-technical-analysis-boost');
  return {
    ok: blockers.length === 0,
    status: phaseStatus(blockers),
    blockers,
    summary: {
      taFilesReady: files.filter((item) => item.exists).length,
      checkScriptReady: Boolean(scripts['check:luna-technical-analysis-boost']),
    },
    evidence: { files },
  };
}

export function buildLunaNormalizationRefactorGuardrailMasterReport() {
  const scripts = loadPackageScripts();
  const phases = {
    psi: buildPsiPhase(scripts),
    refactor: buildRefactorPhase(scripts),
    guardrail: buildGuardrailPhase(scripts),
    technicalAnalysis: buildTaPhase(scripts),
  };
  const blockers = Object.entries(phases).flatMap(([phase, report]) =>
    report.blockers.map((blocker) => `${phase}:${blocker}`),
  );
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_normalization_refactor_guardrail_master_complete' : 'luna_normalization_refactor_guardrail_master_blocked',
    checkedAt: new Date().toISOString(),
    blockers,
    warnings: phases.refactor.warnings,
    summary: {
      phaseStatuses: Object.fromEntries(Object.entries(phases).map(([name, report]) => [name, report.status])),
      canonicalYamlAgents: phases.psi.summary.canonicalYamlAgents,
      coreAgentCount: phases.psi.summary.coreAgentCount,
      shadowExtensionCount: phases.psi.summary.shadowExtensionCount,
      totalGuardrails: phases.guardrail.summary.totalGuardrails,
      taFilesReady: phases.technicalAnalysis.summary.taFilesReady,
    },
    phases,
  };
}

export default { buildLunaNormalizationRefactorGuardrailMasterReport };

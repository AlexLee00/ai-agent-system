import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLunaCommunicationInfrastructureReport } from './luna-communication-infrastructure.ts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const LUNA_HYBRID_PHASE10 = 'phase10_hybrid_promotion_gate';
export const PHASE10_RUNTIME_COMMAND = 'runtime:luna-hybrid-promotion-gate';
export const PHASE10_A2A_SKILL = 'hybrid-promotion-gate';

export const LUNA_HYBRID_PHASE_CONTRACTS = [
  {
    phase: 1,
    name: 'market_regime_llm_shadow',
    checkScript: 'check:luna-hybrid-phase1',
    runtimeScript: 'runtime:luna-regime-llm-shadow',
    a2aSkill: 'market-regime-analysis',
    hookRuntime: 'runtime:luna-regime-llm-shadow',
    evidence: { table: 'investment.luna_regime_llm_shadow', timestampColumn: 'captured_at' },
  },
  {
    phase: 2,
    name: 'entry_decision_llm_shadow',
    checkScript: 'check:luna-hybrid-phase2',
    runtimeScript: 'runtime:luna-entry-llm-shadow',
    a2aSkill: 'entry-decision-shadow',
    hookRuntime: 'runtime:luna-entry-llm-shadow',
    evidence: { table: 'investment.luna_entry_llm_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 3,
    name: 'dynamic_tpsl_shadow',
    checkScript: 'check:luna-hybrid-phase3',
    runtimeScript: 'runtime:luna-dynamic-tpsl-shadow',
    a2aSkill: 'dynamic-tpsl-shadow',
    hookRuntime: 'runtime:luna-dynamic-tpsl-shadow',
    evidence: { table: 'investment.luna_dynamic_tpsl_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 4,
    name: 'meta_neural_reflexion_shadow',
    checkScript: 'check:luna-hybrid-phase4',
    runtimeScript: 'runtime:luna-meta-reflexion-shadow',
    a2aSkill: 'meta-neural-reflexion',
    hookRuntime: 'runtime:luna-meta-reflexion-shadow',
    evidence: { table: 'investment.mapek_knowledge', timestampColumn: 'created_at', eventType: 'luna_meta_reflexion_shadow' },
  },
  {
    phase: 5,
    name: 'factor_model_shadow',
    checkScript: 'check:luna-hybrid-phase5',
    runtimeScript: 'runtime:luna-factor-model-shadow',
    a2aSkill: 'factor-model-shadow',
    hookRuntime: 'runtime:luna-factor-model-shadow',
    evidence: { table: 'investment.luna_factor_model_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 6,
    name: 'stat_arb_shadow',
    checkScript: 'check:luna-hybrid-phase6',
    runtimeScript: 'runtime:luna-stat-arb-shadow',
    a2aSkill: 'stat-arb-shadow',
    hookRuntime: 'runtime:luna-stat-arb-shadow',
    evidence: { table: 'investment.luna_stat_arb_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 7,
    name: 'rl_policy_shadow',
    checkScript: 'check:luna-hybrid-phase7',
    runtimeScript: 'runtime:luna-rl-policy-shadow',
    a2aSkill: 'rl-policy-shadow',
    hookRuntime: 'runtime:luna-rl-policy-shadow',
    evidence: { table: 'investment.luna_rl_policy_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 8,
    name: 'monte_carlo_stress_shadow',
    checkScript: 'check:luna-hybrid-phase8',
    runtimeScript: 'runtime:luna-monte-carlo-stress-shadow',
    a2aSkill: 'risk-simulation-shadow',
    hookRuntime: 'runtime:luna-monte-carlo-stress-shadow',
    evidence: { table: 'investment.luna_risk_simulation_shadow', timestampColumn: 'observed_at' },
  },
  {
    phase: 9,
    name: 'communication_infrastructure',
    checkScript: 'check:luna-hybrid-phase9',
    runtimeScript: 'runtime:luna-communication-infra-gate',
    a2aSkill: 'communication-infrastructure-gate',
    hookRuntime: 'runtime:luna-communication-infra-gate',
    evidence: null,
  },
  {
    phase: 10,
    name: 'hybrid_promotion_gate',
    checkScript: 'check:luna-hybrid-phase10',
    runtimeScript: PHASE10_RUNTIME_COMMAND,
    a2aSkill: PHASE10_A2A_SKILL,
    hookRuntime: PHASE10_RUNTIME_COMMAND,
    evidence: null,
  },
];

function defaultInvestmentRoot() {
  return path.resolve(MODULE_DIR, '..');
}

function projectRootFromInvestmentRoot(investmentRoot) {
  return path.resolve(investmentRoot, '../..');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function packageScripts(investmentRoot) {
  return readJson(path.join(investmentRoot, 'package.json'), {})?.scripts || {};
}

function cardSkillIds(investmentRoot) {
  const card = readJson(path.join(investmentRoot, 'a2a/luna-card.json'), {}) || {};
  return new Set((card.skills || []).map((skill) => skill?.id).filter(Boolean));
}

function phaseContractStatus({ investmentRoot, projectRoot }) {
  const scripts = packageScripts(investmentRoot);
  const skills = cardSkillIds(investmentRoot);
  const preHookText = readText(path.join(projectRoot, '.claude/hooks/scripts/luna-pretooluse-policy-check.sh'));
  const serverText = readText(path.join(investmentRoot, 'a2a/server.ts'));
  return LUNA_HYBRID_PHASE_CONTRACTS.map((phase) => {
    const missing = [];
    if (!scripts[phase.checkScript]) missing.push(`package_script:${phase.checkScript}`);
    if (!scripts[phase.runtimeScript]) missing.push(`runtime_script:${phase.runtimeScript}`);
    if (!skills.has(phase.a2aSkill)) missing.push(`a2a_skill:${phase.a2aSkill}`);
    if (!preHookText.includes(phase.hookRuntime)) missing.push(`hook_allowlist:${phase.hookRuntime}`);
    if (phase.phase === 10) {
      if (!serverText.includes('registerHybridPromotionGateSkill')) {
        missing.push('a2a_server:registerHybridPromotionGateSkill');
      }
      if (!preHookText.includes('"runtime:luna-hybrid-promotion-gate"')) {
        missing.push('hook_runtime_literal:runtime:luna-hybrid-promotion-gate');
      }
    }
    return {
      phase: phase.phase,
      name: phase.name,
      checkScript: phase.checkScript,
      runtimeScript: phase.runtimeScript,
      a2aSkill: phase.a2aSkill,
      ok: missing.length === 0,
      missing,
    };
  });
}

function securityChecks({ projectRoot }) {
  const preHookText = readText(path.join(projectRoot, '.claude/hooks/scripts/luna-pretooluse-policy-check.sh'));
  return [
    {
      name: 'phase10_shadow_runtime_allowlisted',
      ok: preHookText.includes(PHASE10_RUNTIME_COMMAND),
      detail: preHookText.includes(PHASE10_RUNTIME_COMMAND) ? 'ready' : 'missing phase10 read-only runtime allowlist',
    },
    {
      name: 'apply_confirm_not_allowlisted',
      ok: !preHookText.includes('re.compile(r"^--apply$")') && !preHookText.includes('confirm='),
      detail: 'read-only shadow commands exclude apply/confirm arguments',
    },
    {
      name: 'live_mutation_disabled',
      ok: true,
      detail: 'Phase 10 gate emits readiness only; no live order/config/PID mutation',
    },
  ];
}

async function queryEvidence(queryFn, phase, hours) {
  if (!phase.evidence) {
    return {
      phase: phase.phase,
      name: phase.name,
      status: phase.phase === 9 ? 'covered_by_communication_gate' : 'not_applicable',
      count: null,
      latestAt: null,
      ok: true,
    };
  }
  if (typeof queryFn !== 'function') {
    return {
      phase: phase.phase,
      name: phase.name,
      status: 'not_checked',
      count: null,
      latestAt: null,
      ok: false,
      warning: 'queryFn unavailable; run without --no-db to check real shadow evidence',
    };
  }

  const { table, timestampColumn, eventType } = phase.evidence;
  const sql = eventType
    ? `SELECT COUNT(*)::int AS count, MAX(${timestampColumn}) AS latest_at
         FROM ${table}
        WHERE event_type = $1
          AND ${timestampColumn} >= NOW() - ($2::int * INTERVAL '1 hour')`
    : `SELECT COUNT(*)::int AS count, MAX(${timestampColumn}) AS latest_at
         FROM ${table}
        WHERE ${timestampColumn} >= NOW() - ($1::int * INTERVAL '1 hour')`;
  const params = eventType ? [eventType, hours] : [hours];
  try {
    const rows = await Promise.resolve(queryFn(sql, params));
    const row = Array.isArray(rows) ? rows[0] || {} : rows || {};
    const count = Number(row.count ?? row.rows ?? 0);
    return {
      phase: phase.phase,
      name: phase.name,
      table,
      status: count > 0 ? 'ready' : 'missing_recent_shadow_evidence',
      count,
      latestAt: row.latest_at || row.latestAt || null,
      ok: count > 0,
    };
  } catch (error) {
    return {
      phase: phase.phase,
      name: phase.name,
      table,
      status: 'query_failed',
      count: null,
      latestAt: null,
      ok: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildEvidenceStatus({ queryFn, hours }) {
  const checks = [];
  for (const phase of LUNA_HYBRID_PHASE_CONTRACTS) {
    checks.push(await queryEvidence(queryFn, phase, hours));
  }
  return checks;
}

export async function buildLunaHybridPromotionGateReport(options = {}) {
  const investmentRoot = path.resolve(options.investmentRoot || defaultInvestmentRoot());
  const projectRoot = path.resolve(options.projectRoot || projectRootFromInvestmentRoot(investmentRoot));
  const hours = Math.max(1, Number(options.hours || 168));
  const contractChecks = phaseContractStatus({ investmentRoot, projectRoot });
  const security = securityChecks({ projectRoot });
  const communication = buildLunaCommunicationInfrastructureReport({ investmentRoot, projectRoot });
  const evidenceChecks = await buildEvidenceStatus({ queryFn: options.queryFn, hours });

  const contractFailures = contractChecks.filter((item) => !item.ok);
  const securityFailures = security.filter((item) => !item.ok);
  const evidenceWarnings = evidenceChecks.filter((item) => !item.ok);
  const blockers = [
    ...contractFailures.map((item) => ({
      type: 'contract',
      phase: item.phase,
      name: item.name,
      missing: item.missing,
    })),
    ...securityFailures.map((item) => ({
      type: 'security',
      name: item.name,
      detail: item.detail,
    })),
  ];
  if (!communication.ok) {
    blockers.push({
      type: 'communication',
      name: 'phase9_communication_infrastructure',
      missing: communication.failures.map((item) => item.name),
    });
  }

  const contractReady = blockers.length === 0;
  const dataReady = evidenceWarnings.length === 0;
  const manualPromotionReviewCandidate = contractReady && dataReady;
  const status = !contractReady
    ? 'luna_hybrid_promotion_gate_blocked'
    : dataReady
      ? 'luna_hybrid_promotion_gate_ready_for_master_review'
      : 'luna_hybrid_promotion_gate_shadow_ready_data_pending';

  return {
    ok: contractReady,
    phase: LUNA_HYBRID_PHASE10,
    status,
    shadowMode: true,
    liveMutation: false,
    protectedPidMutation: false,
    promotionReady: false,
    manualPromotionReviewCandidate,
    promotionPolicy: 'manual_master_approval_required_after_shadow_observation',
    contractReady,
    dataReady,
    evidenceLookbackHours: hours,
    summary: {
      phases: LUNA_HYBRID_PHASE_CONTRACTS.length,
      contractChecks: contractChecks.length,
      contractFailures: contractFailures.length,
      securityChecks: security.length,
      securityFailures: securityFailures.length,
      evidenceChecks: evidenceChecks.length,
      evidenceWarnings: evidenceWarnings.length,
      a2aSkills: communication.summary.a2aSkills,
    },
    contractChecks,
    evidenceChecks,
    securityChecks: security,
    communication: {
      ok: communication.ok,
      status: communication.status,
      failures: communication.failures,
      channels: communication.channels,
    },
    blockers,
    warnings: evidenceWarnings.map((item) => ({
      type: 'evidence',
      phase: item.phase,
      name: item.name,
      status: item.status,
      warning: item.warning || null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export default {
  LUNA_HYBRID_PHASE10,
  PHASE10_RUNTIME_COMMAND,
  PHASE10_A2A_SKILL,
  LUNA_HYBRID_PHASE_CONTRACTS,
  buildLunaHybridPromotionGateReport,
};

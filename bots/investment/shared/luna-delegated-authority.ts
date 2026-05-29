// @ts-nocheck

import { spawnSync } from 'node:child_process';

export const LUNA_DELEGATED_AUTHORITY_TOKEN = 'luna-delegated-authority';

// 0 means no per-trade USDT cap; daily/open-position gates still apply.
const DEFAULT_MAX_TRADE_USDT = 0;
const DEFAULT_MAX_DAILY_USDT = 200;
const DEFAULT_MAX_OPEN_POSITIONS = 5;

// Absolute hard caps — regime multiplier cannot exceed these.
const DEFAULT_TRADE_HARD_CAP_USDT = 80;
const DEFAULT_DAILY_HARD_CAP_USDT = 300;

// Regime multiplier defaults. Configurable via LUNA_REGIME_LIMIT_MULT_<REGIME_UPPER>.
// Unknown/missing regime → REGIME_MULT_FALLBACK (ranging-equivalent, conservative).
const REGIME_MULT_DEFAULTS = {
  low_volatility_bull: 1.3,
  high_volatility_bull: 1.0,
  ranging: 0.8,
  trending_bull: 1.0,
  trending_bear: 0.5,
  low_volatility_bear: 0.6,
  high_volatility_bear: 0.4,
};
const REGIME_MULT_FALLBACK = 0.8;

const SUPPORTED_DELEGATED_ACTIONS = new Set([
  'report',
  'live_fire_enable',
  'live_fire_cutover',
  'runtime_config_apply',
  'safe_maintenance_apply',
  'skill_learning_apply',
  'reconcile_ack',
]);
const POLICY_ENV_KEYS = [
  'LUNA_DELEGATED_AUTHORITY_ENABLED',
  'LUNA_MASTER_AUTHORITY_MODE',
  'LUNA_AUTHORITY_MODE',
  'LUNA_MASTER_REPORT_ONLY',
  'LUNA_DELEGATED_AUTHORITY_REQUIRE_FINAL_GATE',
  'LUNA_DELEGATED_RECONCILE_ACK_ENABLED',
  'LUNA_DELEGATED_MAX_TRADE_USDT',
  'LUNA_MAX_TRADE_USDT',
  'LUNA_DELEGATED_MAX_DAILY_USDT',
  'LUNA_LIVE_FIRE_MAX_DAILY',
  'LUNA_DELEGATED_MAX_OPEN_POSITIONS',
  'LUNA_LIVE_FIRE_MAX_OPEN',
  'LUNA_CURRENT_REGIME',
  'LUNA_DELEGATED_MAX_TRADE_USDT_HARD_CAP',
  'LUNA_DELEGATED_MAX_DAILY_USDT_HARD_CAP',
];

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function optionalPositiveNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeMode(value) {
  const raw = String(value || '').toLowerCase();
  if (['delegated', 'delegated_autonomous', 'luna_delegated'].includes(raw)) return 'delegated';
  if (['report_only', 'master_report_only'].includes(raw)) return 'report_only';
  return 'master_approval';
}

function launchctlGetenv(key) {
  const proc = spawnSync('launchctl', ['getenv', key], { encoding: 'utf8' });
  if (proc.status !== 0) return undefined;
  const value = String(proc.stdout || '').trim();
  return value || undefined;
}

function activePolicyEnv() {
  const env = { ...process.env };
  for (const key of POLICY_ENV_KEYS) {
    if (env[key] == null || env[key] === '') {
      const value = launchctlGetenv(key);
      if (value != null && value !== '') env[key] = value;
    }
  }
  return env;
}

function getRegimeMultiplier(regime, effectiveEnv) {
  const normalized = String(regime || '').trim().toLowerCase();
  if (normalized) {
    const envKey = `LUNA_REGIME_LIMIT_MULT_${normalized.toUpperCase().replace(/-/g, '_')}`;
    const envValue = effectiveEnv[envKey] ?? launchctlGetenv(envKey) ?? '';
    if (envValue !== '') {
      const n = Number(envValue);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (REGIME_MULT_DEFAULTS[normalized] != null) return REGIME_MULT_DEFAULTS[normalized];
  }
  return REGIME_MULT_FALLBACK;
}

export function getLunaDelegatedAuthorityPolicy(env = null) {
  const effectiveEnv = env || activePolicyEnv();
  const mode = boolEnv(effectiveEnv.LUNA_DELEGATED_AUTHORITY_ENABLED)
    ? 'delegated'
    : normalizeMode(effectiveEnv.LUNA_MASTER_AUTHORITY_MODE || effectiveEnv.LUNA_AUTHORITY_MODE);
  const delegated = mode === 'delegated';

  const baseTradeUsdt = optionalPositiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_TRADE_USDT || effectiveEnv.LUNA_MAX_TRADE_USDT, DEFAULT_MAX_TRADE_USDT);
  const baseDailyUsdt = positiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_DAILY_USDT || effectiveEnv.LUNA_LIVE_FIRE_MAX_DAILY, DEFAULT_MAX_DAILY_USDT);

  // Regime-based dynamic limit scaling
  const currentRegime = String(effectiveEnv.LUNA_CURRENT_REGIME || '').trim().toLowerCase() || null;
  const regimeMultiplier = getRegimeMultiplier(currentRegime, effectiveEnv);
  const hardCapTrade = positiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_TRADE_USDT_HARD_CAP, DEFAULT_TRADE_HARD_CAP_USDT);
  const hardCapDaily = positiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_DAILY_USDT_HARD_CAP, DEFAULT_DAILY_HARD_CAP_USDT);

  // Apply multiplier then clamp by hard cap. If base is 0 (no cap), keep 0.
  const maxTradeUsdt = baseTradeUsdt > 0
    ? Math.min(+(baseTradeUsdt * regimeMultiplier).toFixed(2), hardCapTrade)
    : 0;
  const maxDailyUsdt = Math.min(+(baseDailyUsdt * regimeMultiplier).toFixed(2), hardCapDaily);

  return {
    mode,
    delegated,
    reportOnly: delegated || mode === 'report_only' || boolEnv(effectiveEnv.LUNA_MASTER_REPORT_ONLY),
    requireFinalGate: boolEnv(effectiveEnv.LUNA_DELEGATED_AUTHORITY_REQUIRE_FINAL_GATE, true),
    allowReconcileAck: boolEnv(effectiveEnv.LUNA_DELEGATED_RECONCILE_ACK_ENABLED, false),
    maxTradeUsdt,
    maxDailyUsdt,
    maxOpenPositions: Math.max(1, Math.round(positiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_OPEN_POSITIONS || effectiveEnv.LUNA_LIVE_FIRE_MAX_OPEN, DEFAULT_MAX_OPEN_POSITIONS))),
    regime: currentRegime,
    regimeMultiplier,
    hardCaps: { tradeUsdt: hardCapTrade, dailyUsdt: hardCapDaily },
    auditRequired: true,
    hardSafetyNonDelegable: [
      'broker_order_identity_missing',
      'manual_reconcile_without_evidence',
      'position_parity_failure',
      'kill_switch_inconsistent',
      'daily_cap_exceeded',
      'trade_cap_exceeded',
    ],
  };
}

function capBlockers(caps = {}, policy) {
  const blockers = [];
  const maxUsdt = optionalPositiveNumber(caps.maxUsdt, DEFAULT_MAX_TRADE_USDT);
  const maxDailyUsdt = positiveNumber(caps.maxDailyUsdt, DEFAULT_MAX_DAILY_USDT);
  const maxOpen = Math.max(1, Math.round(positiveNumber(caps.maxOpen, DEFAULT_MAX_OPEN_POSITIONS)));
  if (policy.maxTradeUsdt > 0 && maxUsdt > policy.maxTradeUsdt) blockers.push(`trade_cap_exceeded:${maxUsdt}>${policy.maxTradeUsdt}`);
  if (maxDailyUsdt > policy.maxDailyUsdt) blockers.push(`daily_cap_exceeded:${maxDailyUsdt}>${policy.maxDailyUsdt}`);
  if (maxOpen > policy.maxOpenPositions) blockers.push(`open_position_cap_exceeded:${maxOpen}>${policy.maxOpenPositions}`);
  return blockers;
}

export function buildLunaDelegatedAuthorityDecision({
  action = 'report',
  env = null,
  finalGate = null,
  readiness = null,
  caps = {},
  reconcileEvidence = null,
} = {}) {
  const policy = getLunaDelegatedAuthorityPolicy(env);
  const blockers = [];
  const warnings = [];

  if (!SUPPORTED_DELEGATED_ACTIONS.has(action)) {
    blockers.push(`delegated_action_not_registered:${action}`);
  }

  if (!policy.delegated) blockers.push('delegated_authority_disabled');

  if (['live_fire_enable', 'live_fire_cutover'].includes(action)) {
    blockers.push(...capBlockers(caps, policy));
    const gate = finalGate || readiness;
    if (policy.requireFinalGate && gate?.ok !== true) {
      blockers.push(...(gate?.blockers?.length ? gate.blockers : ['final_gate_not_clear']));
    }
  }

  if (action === 'reconcile_ack') {
    if (!policy.allowReconcileAck) blockers.push('delegated_reconcile_ack_disabled');
    if (!reconcileEvidence?.evidenceHash) blockers.push('reconcile_evidence_hash_required');
    if (reconcileEvidence?.verifiedNotFound !== true) blockers.push('broker_absence_verification_required');
  }

  if (action === 'runtime_config_apply') {
    warnings.push('runtime_config_apply_delegated_but_audited');
  }

  const canSelfApprove = policy.delegated && blockers.length === 0;
  return {
    ok: canSelfApprove,
    action,
    approvalSource: canSelfApprove ? LUNA_DELEGATED_AUTHORITY_TOKEN : null,
    approvalToken: canSelfApprove ? LUNA_DELEGATED_AUTHORITY_TOKEN : null,
    canSelfApprove,
    masterRole: policy.reportOnly ? 'report_only' : 'approval_required',
    policy,
    blockers: [...new Set(blockers)],
    warnings,
    report: {
      notifyMaster: true,
      actionability: canSelfApprove ? 'none' : 'needs_human',
      summary: canSelfApprove
        ? `luna delegated authority approved ${action}`
        : `luna delegated authority blocked ${action}`,
    },
  };
}

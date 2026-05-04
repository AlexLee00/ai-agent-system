// @ts-nocheck

export const LUNA_DELEGATED_AUTHORITY_TOKEN = 'luna-delegated-authority';

const DEFAULT_MAX_TRADE_USDT = 50;
const DEFAULT_MAX_DAILY_USDT = 200;
const DEFAULT_MAX_OPEN_POSITIONS = 2;

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeMode(value) {
  const raw = String(value || '').toLowerCase();
  if (['delegated', 'delegated_autonomous', 'luna_delegated'].includes(raw)) return 'delegated';
  if (['report_only', 'master_report_only'].includes(raw)) return 'report_only';
  return 'master_approval';
}

export function getLunaDelegatedAuthorityPolicy(env = process.env) {
  const mode = boolEnv(env.LUNA_DELEGATED_AUTHORITY_ENABLED)
    ? 'delegated'
    : normalizeMode(env.LUNA_MASTER_AUTHORITY_MODE || env.LUNA_AUTHORITY_MODE);
  const delegated = mode === 'delegated';
  return {
    mode,
    delegated,
    reportOnly: delegated || mode === 'report_only' || boolEnv(env.LUNA_MASTER_REPORT_ONLY),
    requireFinalGate: boolEnv(env.LUNA_DELEGATED_AUTHORITY_REQUIRE_FINAL_GATE, true),
    allowReconcileAck: boolEnv(env.LUNA_DELEGATED_RECONCILE_ACK_ENABLED, false),
    maxTradeUsdt: positiveNumber(env.LUNA_DELEGATED_MAX_TRADE_USDT || env.LUNA_MAX_TRADE_USDT, DEFAULT_MAX_TRADE_USDT),
    maxDailyUsdt: positiveNumber(env.LUNA_DELEGATED_MAX_DAILY_USDT || env.LUNA_LIVE_FIRE_MAX_DAILY, DEFAULT_MAX_DAILY_USDT),
    maxOpenPositions: Math.max(1, Math.round(positiveNumber(env.LUNA_DELEGATED_MAX_OPEN_POSITIONS || env.LUNA_LIVE_FIRE_MAX_OPEN, DEFAULT_MAX_OPEN_POSITIONS))),
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
  const maxUsdt = positiveNumber(caps.maxUsdt, DEFAULT_MAX_TRADE_USDT);
  const maxDailyUsdt = positiveNumber(caps.maxDailyUsdt, DEFAULT_MAX_DAILY_USDT);
  const maxOpen = Math.max(1, Math.round(positiveNumber(caps.maxOpen, DEFAULT_MAX_OPEN_POSITIONS)));
  if (maxUsdt > policy.maxTradeUsdt) blockers.push(`trade_cap_exceeded:${maxUsdt}>${policy.maxTradeUsdt}`);
  if (maxDailyUsdt > policy.maxDailyUsdt) blockers.push(`daily_cap_exceeded:${maxDailyUsdt}>${policy.maxDailyUsdt}`);
  if (maxOpen > policy.maxOpenPositions) blockers.push(`open_position_cap_exceeded:${maxOpen}>${policy.maxOpenPositions}`);
  return blockers;
}

export function buildLunaDelegatedAuthorityDecision({
  action = 'report',
  env = process.env,
  finalGate = null,
  readiness = null,
  caps = {},
  reconcileEvidence = null,
} = {}) {
  const policy = getLunaDelegatedAuthorityPolicy(env);
  const blockers = [];
  const warnings = [];

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

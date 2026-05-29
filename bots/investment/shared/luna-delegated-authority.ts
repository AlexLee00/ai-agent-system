// @ts-nocheck

import { spawnSync } from 'node:child_process';

export const LUNA_DELEGATED_AUTHORITY_TOKEN = 'luna-delegated-authority';

// ─── Ratio-mode defaults (v2: available_balance × ratio × regime_mult) ───────
const DEFAULT_TRADE_RATIO = 0.05;
const DEFAULT_DAILY_RATIO = 0.20;
const DEFAULT_TRADE_RATIO_HARD_CAP = 0.10;  // available × 10% — hard, regime/학습 무관
const DEFAULT_DAILY_RATIO_HARD_CAP  = 0.40;  // available × 40% — hard

// Legacy $ fallbacks (used when ratio env vars are absent — backward compat)
const DEFAULT_MAX_TRADE_USDT = 0;
const DEFAULT_MAX_DAILY_USDT = 200;
const DEFAULT_MAX_OPEN_POSITIONS = 5;  // safety upper bound (dynamic natural limit + bug guard)

// Binance minimum order size — positions below this are not opened (natural limit)
const BINANCE_MIN_ORDER_USDT = 11;

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
const REGIME_MULT_FALLBACK = 0.8;  // ranging equiv — safe default for unknown regime

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
  // Ratio-mode (v2)
  'LUNA_DELEGATED_TRADE_RATIO',
  'LUNA_DELEGATED_DAILY_RATIO',
  'LUNA_DELEGATED_TRADE_RATIO_HARD_CAP',
  'LUNA_DELEGATED_DAILY_RATIO_HARD_CAP',
  'LUNA_DELEGATED_RATIO_EXCHANGE',
  // Legacy $ values (kept for backward compat / override)
  'LUNA_DELEGATED_MAX_TRADE_USDT',
  'LUNA_MAX_TRADE_USDT',
  'LUNA_DELEGATED_MAX_DAILY_USDT',
  'LUNA_LIVE_FIRE_MAX_DAILY',
  'LUNA_DELEGATED_MAX_OPEN_POSITIONS',
  'LUNA_LIVE_FIRE_MAX_OPEN',
  'LUNA_CURRENT_REGIME',
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

// ─── Ratio-mode helpers ────────────────────────────────────────────────────────

/**
 * ratio 모드 활성 여부: LUNA_DELEGATED_TRADE_RATIO 또는 LUNA_DELEGATED_DAILY_RATIO 설정 시.
 */
function isRatioMode(effectiveEnv) {
  return (
    (effectiveEnv.LUNA_DELEGATED_TRADE_RATIO != null && effectiveEnv.LUNA_DELEGATED_TRADE_RATIO !== '') ||
    (effectiveEnv.LUNA_DELEGATED_DAILY_RATIO != null && effectiveEnv.LUNA_DELEGATED_DAILY_RATIO !== '')
  );
}

/**
 * 가용잔고 × 비율 × regime_mult 한도 계산.
 * 절대상한(hard cap ratio)으로 clamp — regime·학습 무관.
 */
function calcRatioLimits(availableBalance, tradeRatio, dailyRatio, tradeHardCapRatio, dailyHardCapRatio, regimeMult) {
  const rawTrade = availableBalance * tradeRatio * regimeMult;
  const rawDaily = availableBalance * dailyRatio * regimeMult;
  const hardTrade = availableBalance * tradeHardCapRatio;
  const hardDaily = availableBalance * dailyHardCapRatio;
  return {
    maxTradeUsdt: +(Math.min(rawTrade, hardTrade)).toFixed(2),
    maxDailyUsdt: +(Math.min(rawDaily, hardDaily)).toFixed(2),
    hardCapTradeUsdt: +hardTrade.toFixed(2),
    hardCapDailyUsdt: +hardDaily.toFixed(2),
  };
}

/**
 * ratio 모드에서 가용잔고 0 → 거래 보류(안전).
 * maxTradeUsdt = 0(no-cap)이면 안전 fallback으로 최솟값($11)을 한도로 사용.
 */
function safeRatioFallback() {
  return {
    maxTradeUsdt: BINANCE_MIN_ORDER_USDT,   // 최소 주문 금액 이하 허용 → 사실상 차단
    maxDailyUsdt: BINANCE_MIN_ORDER_USDT,
    hardCapTradeUsdt: BINANCE_MIN_ORDER_USDT,
    hardCapDailyUsdt: BINANCE_MIN_ORDER_USDT,
  };
}

// ─── Async runtime inputs ──────────────────────────────────────────────────────

/**
 * 가용잔고(binance) + regime(market_regime_snapshots) 비동기 조회.
 * 실패 시 { availableBalance: 0, regime: null } → 거래 보류(안전).
 */
export async function resolveRuntimeLimitInputs(exchange = 'binance', market = 'binance') {
  const [capitalMod, dbStrategyMod] = await Promise.allSettled([
    import('./capital-manager.ts'),
    import('./db/strategy.ts'),
  ]);

  let availableBalance = 0;
  if (capitalMod.status === 'fulfilled') {
    try {
      availableBalance = await capitalMod.value.getAvailableBalance(exchange);
    } catch (e) {
      console.warn('[delegated-authority] 잔고 조회 실패:', e?.message);
    }
  }

  let regime = null;
  if (dbStrategyMod.status === 'fulfilled') {
    try {
      const snapshot = await dbStrategyMod.value.getLatestMarketRegimeSnapshot(market);
      regime = snapshot?.regime ?? null;
    } catch (e) {
      console.warn('[delegated-authority] regime 조회 실패:', e?.message);
    }
  }

  return { availableBalance: availableBalance ?? 0, regime };
}

// ─── Core policy ───────────────────────────────────────────────────────────────

/**
 * 위임 권한 정책.
 * runtimeInputs = { availableBalance, regime } 제공 시 ratio 기반 동적 한도 사용.
 * 미제공(sync 호출) 시 env $ 기반 fallback (레거시 호환).
 */
export function getLunaDelegatedAuthorityPolicy(env = null, runtimeInputs = null) {
  const effectiveEnv = env || activePolicyEnv();
  const mode = boolEnv(effectiveEnv.LUNA_DELEGATED_AUTHORITY_ENABLED)
    ? 'delegated'
    : normalizeMode(effectiveEnv.LUNA_MASTER_AUTHORITY_MODE || effectiveEnv.LUNA_AUTHORITY_MODE);
  const delegated = mode === 'delegated';

  // ── Regime 결정: runtimeInputs.regime (DB) → LUNA_CURRENT_REGIME env → null ──
  const currentRegime = (
    (runtimeInputs?.regime != null ? String(runtimeInputs.regime) : null) ||
    String(effectiveEnv.LUNA_CURRENT_REGIME || '').trim().toLowerCase() ||
    null
  );
  const regimeMultiplier = getRegimeMultiplier(currentRegime, effectiveEnv);

  // ── 한도 계산: ratio 모드(v2) vs 레거시 $ 모드 ──
  let maxTradeUsdt, maxDailyUsdt, hardCaps, limitMode;

  if (isRatioMode(effectiveEnv) && runtimeInputs !== null) {
    // Ratio 모드: 가용잔고 × 비율 × regime_mult
    const availableBalance = runtimeInputs.availableBalance ?? 0;
    const tradeRatio    = positiveNumber(effectiveEnv.LUNA_DELEGATED_TRADE_RATIO,     DEFAULT_TRADE_RATIO);
    const dailyRatio    = positiveNumber(effectiveEnv.LUNA_DELEGATED_DAILY_RATIO,     DEFAULT_DAILY_RATIO);
    const tradeHardCap  = positiveNumber(effectiveEnv.LUNA_DELEGATED_TRADE_RATIO_HARD_CAP, DEFAULT_TRADE_RATIO_HARD_CAP);
    const dailyHardCap  = positiveNumber(effectiveEnv.LUNA_DELEGATED_DAILY_RATIO_HARD_CAP, DEFAULT_DAILY_RATIO_HARD_CAP);

    if (availableBalance > 0) {
      const limits = calcRatioLimits(availableBalance, tradeRatio, dailyRatio, tradeHardCap, dailyHardCap, regimeMultiplier);
      maxTradeUsdt = limits.maxTradeUsdt;
      maxDailyUsdt = limits.maxDailyUsdt;
      hardCaps = {
        tradeUsdt: limits.hardCapTradeUsdt,
        dailyUsdt: limits.hardCapDailyUsdt,
        tradeRatio: tradeHardCap,
        dailyRatio: dailyHardCap,
      };
    } else {
      // 잔고 0 또는 조회 실패 → 거래 보류 (안전)
      const fb = safeRatioFallback();
      maxTradeUsdt = fb.maxTradeUsdt;
      maxDailyUsdt = fb.maxDailyUsdt;
      hardCaps = { tradeUsdt: fb.hardCapTradeUsdt, dailyUsdt: fb.hardCapDailyUsdt };
    }
    limitMode = 'ratio';
  } else {
    // 레거시 $ 모드 (env 값 기반, ratio 미설정 또는 sync 호출)
    const baseTradeUsdt = optionalPositiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_TRADE_USDT || effectiveEnv.LUNA_MAX_TRADE_USDT, DEFAULT_MAX_TRADE_USDT);
    const baseDailyUsdt = positiveNumber(effectiveEnv.LUNA_DELEGATED_MAX_DAILY_USDT || effectiveEnv.LUNA_LIVE_FIRE_MAX_DAILY, DEFAULT_MAX_DAILY_USDT);
    maxTradeUsdt = baseTradeUsdt > 0 ? +(baseTradeUsdt * regimeMultiplier).toFixed(2) : 0;
    maxDailyUsdt = +(baseDailyUsdt * regimeMultiplier).toFixed(2);
    hardCaps = { tradeUsdt: maxTradeUsdt || 0, dailyUsdt: maxDailyUsdt };
    limitMode = 'legacy_usdt';
  }

  return {
    mode,
    delegated,
    reportOnly: delegated || mode === 'report_only' || boolEnv(effectiveEnv.LUNA_MASTER_REPORT_ONLY),
    requireFinalGate: boolEnv(effectiveEnv.LUNA_DELEGATED_AUTHORITY_REQUIRE_FINAL_GATE, true),
    allowReconcileAck: boolEnv(effectiveEnv.LUNA_DELEGATED_RECONCILE_ACK_ENABLED, false),
    maxTradeUsdt,
    maxDailyUsdt,
    maxOpenPositions: Math.max(1, Math.round(positiveNumber(
      effectiveEnv.LUNA_DELEGATED_MAX_OPEN_POSITIONS || effectiveEnv.LUNA_LIVE_FIRE_MAX_OPEN,
      DEFAULT_MAX_OPEN_POSITIONS,
    ))),
    regime: currentRegime,
    regimeMultiplier,
    availableBalance: runtimeInputs?.availableBalance ?? null,
    limitMode,
    hardCaps,
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

/**
 * Async 버전: 잔고·regime DB 조회 후 ratio 기반 정책 반환.
 * 실거래 게이트에서 사용 권장.
 */
export async function getLunaDelegatedAuthorityPolicyAsync(env = null, options = {}) {
  const effectiveEnv = env || activePolicyEnv();
  const exchange = options.exchange || effectiveEnv.LUNA_DELEGATED_RATIO_EXCHANGE || 'binance';
  const market   = options.market   || exchange;

  const runtimeInputs = await resolveRuntimeLimitInputs(exchange, market);
  return getLunaDelegatedAuthorityPolicy(effectiveEnv, runtimeInputs);
}

// ─── Decision builder ──────────────────────────────────────────────────────────

function capBlockers(caps = {}, policy) {
  const blockers = [];
  const maxUsdt      = optionalPositiveNumber(caps.maxUsdt, DEFAULT_MAX_TRADE_USDT);
  const maxDailyUsdt = positiveNumber(caps.maxDailyUsdt, DEFAULT_MAX_DAILY_USDT);
  const maxOpen      = Math.max(1, Math.round(positiveNumber(caps.maxOpen, DEFAULT_MAX_OPEN_POSITIONS)));
  if (policy.maxTradeUsdt > 0 && maxUsdt > policy.maxTradeUsdt) blockers.push(`trade_cap_exceeded:${maxUsdt}>${policy.maxTradeUsdt}`);
  if (maxDailyUsdt > policy.maxDailyUsdt) blockers.push(`daily_cap_exceeded:${maxDailyUsdt}>${policy.maxDailyUsdt}`);
  if (maxOpen > policy.maxOpenPositions) blockers.push(`open_position_cap_exceeded:${maxOpen}>${policy.maxOpenPositions}`);
  return blockers;
}

function _buildDecision({ action = 'report', policy, finalGate = null, readiness = null, caps = {}, reconcileEvidence = null }) {
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

/** Sync 버전 (레거시 호환). runtimeInputs = null → 레거시 $ 모드. */
export function buildLunaDelegatedAuthorityDecision({
  action = 'report',
  env = null,
  finalGate = null,
  readiness = null,
  caps = {},
  reconcileEvidence = null,
} = {}) {
  const policy = getLunaDelegatedAuthorityPolicy(env, null);
  return _buildDecision({ action, policy, finalGate, readiness, caps, reconcileEvidence });
}

/**
 * Async 버전: 잔고·regime 조회 후 ratio 기반 한도로 결정.
 * 실거래 활성화 게이트 등 async 컨텍스트에서 사용.
 */
export async function buildLunaDelegatedAuthorityDecisionAsync({
  action = 'report',
  env = null,
  finalGate = null,
  readiness = null,
  caps = {},
  reconcileEvidence = null,
  exchange = null,
  market = null,
} = {}) {
  const effectiveEnv = env || activePolicyEnv();
  const resolvedExchange = exchange || effectiveEnv.LUNA_DELEGATED_RATIO_EXCHANGE || 'binance';
  const resolvedMarket   = market   || resolvedExchange;
  const policy = await getLunaDelegatedAuthorityPolicyAsync(effectiveEnv, {
    exchange: resolvedExchange,
    market: resolvedMarket,
  });
  return _buildDecision({ action, policy, finalGate, readiness, caps, reconcileEvidence });
}

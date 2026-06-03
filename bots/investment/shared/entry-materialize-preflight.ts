// @ts-nocheck
/**
 * entry-materialize-preflight.ts — entry-trigger materialize SHADOW preflight.
 *
 * This module predicts whether a fired entry trigger would later be blocked by
 * crypto execution guards. It never blocks materialization or order execution.
 */

import { query, run } from './db/core.ts';
import { getLivePosition } from './db/positions.ts';
import {
  calculatePositionSize,
  getCapitalConfig,
  getDynamicMinOrderAmount,
  getOpenPositions,
  preTradeCheck,
} from './capital-manager.ts';
import { getInvestmentExecutionRuntimeConfig } from './runtime-config.ts';
import { getInvestmentTradeMode } from './secrets.ts';

const PRIMARY_ENABLED_ENV = 'ENTRY_PREFLIGHT_SHADOW_ENABLED';
const LEGACY_ENABLED_ENV = 'LUNA_ENTRY_PREFLIGHT_SHADOW_ENABLED';
const DEFAULT_TRADE_MODE = 'normal';

function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function normalizeSymbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeTradeMode(value = null) {
  const text = String(value || '').trim().toLowerCase();
  return text || DEFAULT_TRADE_MODE;
}

function resolveTriggerTradeMode(trigger = {}, fallback = DEFAULT_TRADE_MODE) {
  return normalizeTradeMode(
    trigger.trade_mode
    || trigger.tradeMode
    || trigger.trigger_meta?.trade_mode
    || trigger.trigger_meta?.tradeMode
    || trigger.trigger_context?.trade_mode
    || trigger.trigger_context?.tradeMode
    || fallback
    || getInvestmentTradeMode?.()
    || DEFAULT_TRADE_MODE,
  );
}

function classifyValidationFallbackGuard(reason = '') {
  const text = String(reason || '');
  if (text.includes('최대 포지션 도달')) return 'max_positions';
  if (text.includes('일간 매매 한도')) return 'daily_trade_limit';
  if (text.includes('live_fire_daily_notional_limit')) return 'daily_trade_limit';
  return null;
}

function getNormalToValidationFallbackPolicy() {
  const execution = getInvestmentExecutionRuntimeConfig?.() || {};
  return execution?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.validationFallback || {};
}

function capLiveFireTradeAmount(amount, env = process.env) {
  const numeric = num(amount, 0);
  const cap = num(env?.LUNA_MAX_TRADE_USDT, 0);
  if (!(cap > 0) || !(numeric > cap)) {
    return { amount: numeric, capApplied: false, cap };
  }
  return { amount: cap, capApplied: true, cap };
}

function buildResult(decision, reason, checks = {}) {
  return {
    decision,
    reason,
    wouldDefer: decision !== 'allow',
    checks,
  };
}

export function isEntryPreflightShadowEnabled(env = process.env) {
  return boolEnv(PRIMARY_ENABLED_ENV, false, env) || boolEnv(LEGACY_ENABLED_ENV, false, env);
}

export async function ensureEntryPreflightShadowTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS entry_preflight_shadow (
      id                     BIGSERIAL PRIMARY KEY,
      trigger_id             TEXT,
      candidate_id           TEXT,
      symbol                 TEXT NOT NULL,
      exchange               TEXT NOT NULL DEFAULT 'binance',
      trade_mode             TEXT NOT NULL DEFAULT 'normal',
      preflight_decision     TEXT NOT NULL,
      preflight_reason       TEXT,
      preflight_checks       JSONB NOT NULL DEFAULT '{}'::jsonb,
      would_defer            BOOLEAN NOT NULL DEFAULT false,
      materialized_signal_id TEXT,
      executor_status        TEXT,
      executor_block_code    TEXT,
      executor_block_reason  TEXT,
      agreement              BOOLEAN,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_trigger ON entry_preflight_shadow(trigger_id, created_at DESC)`).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_signal ON entry_preflight_shadow(materialized_signal_id, created_at DESC)`).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_decision ON entry_preflight_shadow(preflight_decision, created_at DESC)`).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_symbol ON entry_preflight_shadow(exchange, symbol, created_at DESC)`).catch(() => {});
}

export async function evaluateEntryMaterializePreflight({
  trigger = {},
  exchange = 'binance',
  amountUsdt = 0,
  rawAmountUsdt = null,
  notifyMultiplier = 1,
  event = null,
  env = process.env,
  deps = {},
} = {}) {
  const symbol = normalizeSymbol(trigger.symbol || event?.symbol || '');
  const effectiveExchange = String(exchange || trigger.exchange || 'binance').trim().toLowerCase();
  const tradeMode = resolveTriggerTradeMode(trigger, DEFAULT_TRADE_MODE);
  const amount = num(amountUsdt, 0);
  const checks = {
    symbol,
    exchange: effectiveExchange,
    tradeMode,
    amountUsdt: amount,
    rawAmountUsdt: rawAmountUsdt == null ? null : num(rawAmountUsdt, null),
    notifyMultiplier: num(notifyMultiplier, 1),
  };

  if (!symbol) return buildResult('allow', 'symbol_unavailable', checks);
  if (effectiveExchange !== 'binance') {
    return buildResult('allow', 'non_binance_preflight_not_supported_shadow_allow', checks);
  }
  if (!(amount > 0)) return buildResult('allow', 'amount_unavailable_existing_path_handles', checks);

  const getOpenPositionsFn = deps.getOpenPositions || getOpenPositions;
  const getCapitalConfigFn = deps.getCapitalConfig || getCapitalConfig;
  const getLivePositionFn = deps.getLivePosition || getLivePosition;
  const preTradeCheckFn = deps.preTradeCheck || preTradeCheck;
  const calculatePositionSizeFn = deps.calculatePositionSize || calculatePositionSize;
  const getDynamicMinOrderAmountFn = deps.getDynamicMinOrderAmount || getDynamicMinOrderAmount;

  const capitalPolicy = getCapitalConfigFn('binance', tradeMode) || {};
  const openPositions = await Promise.resolve(getOpenPositionsFn('binance', false, tradeMode)).catch(() => []);
  const openPositionsSafe = Array.isArray(openPositions) ? openPositions : [];
  const hasSameSymbolOpen = openPositionsSafe.some((position) => normalizeSymbol(position?.symbol) === symbol);
  checks.capital = {
    openPositions: openPositionsSafe.length,
    maxPositions: num(capitalPolicy.max_concurrent_positions, 0),
    hasSameSymbolOpen,
  };
  if (!hasSameSymbolOpen && checks.capital.maxPositions > 0 && openPositionsSafe.length >= checks.capital.maxPositions) {
    return buildResult(
      'defer_capital_full',
      `최대 포지션 도달: ${openPositionsSafe.length}/${checks.capital.maxPositions}`,
      checks,
    );
  }

  const livePosition = await Promise.resolve(getLivePositionFn(symbol, 'binance', tradeMode)).catch(() => null);
  checks.reentry = {
    livePosition: Boolean(livePosition),
    livePositionAmount: livePosition ? num(livePosition.amount, 0) : 0,
  };
  if (livePosition) {
    return buildResult('skip_existing_position', '동일 LIVE 포지션 보유 중 — 추가매수 차단', checks);
  }

  let effectiveTradeMode = tradeMode;
  let reducedAmountMultiplier = 1;
  let softGuards = [];
  const normalCheck = await Promise.resolve(preTradeCheckFn(symbol, 'BUY', amount, 'binance', tradeMode)).catch((error) => ({
    allowed: true,
    error: String(error?.message || error),
  }));
  checks.preTradeCheck = {
    allowed: normalCheck?.allowed !== false,
    reason: normalCheck?.reason || null,
    error: normalCheck?.error || null,
  };

  const fallbackPolicy = getNormalToValidationFallbackPolicy();
  const guardKind = classifyValidationFallbackGuard(normalCheck?.reason || '');
  const allowedGuardKinds = Array.isArray(fallbackPolicy?.allowedGuardKinds) ? fallbackPolicy.allowedGuardKinds : [];
  if (
    normalCheck?.allowed === false
    && fallbackPolicy?.enabled !== false
    && guardKind
    && allowedGuardKinds.includes(guardKind)
  ) {
    const fallbackMultiplier = num(fallbackPolicy?.reductionMultiplier, 0);
    const reducedAmount = amount * fallbackMultiplier;
    const validationCheck = fallbackMultiplier > 0 && fallbackMultiplier < 1
      ? await Promise.resolve(preTradeCheckFn(symbol, 'BUY', reducedAmount, 'binance', 'validation')).catch((error) => ({
        allowed: false,
        reason: String(error?.message || error),
      }))
      : { allowed: false, reason: 'invalid_validation_fallback_multiplier' };
    checks.validationFallback = {
      guardKind,
      allowedGuardKinds,
      fallbackMultiplier,
      reducedAmount,
      validationAllowed: validationCheck?.allowed === true,
      validationReason: validationCheck?.reason || null,
    };
    if (validationCheck?.allowed === true) {
      effectiveTradeMode = 'validation';
      reducedAmountMultiplier = fallbackMultiplier;
      softGuards = [
        {
          kind: 'normal_to_validation_fallback',
          exchange: 'binance',
          tradeMode: 'validation',
          originTradeMode: tradeMode,
          originReason: normalCheck.reason || '',
          reductionMultiplier: fallbackMultiplier,
        },
      ];
    }
  }

  const currentPrice = num(trigger.target_price ?? event?.price ?? event?.lastPrice ?? event?.currentPrice, 0);
  const slPrice = num(trigger.stop_loss ?? trigger.stopLoss, 0);
  const sizing = await Promise.resolve(calculatePositionSizeFn(symbol, currentPrice, slPrice, 'binance')).catch((error) => ({
    size: 0,
    skip: true,
    reason: String(error?.message || error),
  }));
  const minOrderUsdt = await Promise.resolve(getDynamicMinOrderAmountFn('binance', effectiveTradeMode)).catch(() => 0);
  const baseAmount = num(sizing?.size, 0);
  const uncappedAmount = reducedAmountMultiplier > 0 && reducedAmountMultiplier < 1
    ? baseAmount * reducedAmountMultiplier
    : baseAmount;
  const capped = capLiveFireTradeAmount(uncappedAmount, env);
  checks.sizing = {
    currentPrice,
    slPrice,
    sizingSkip: Boolean(sizing?.skip),
    sizingReason: sizing?.reason || null,
    baseAmount,
    effectiveTradeMode,
    reducedAmountMultiplier,
    softGuards,
    minOrderUsdt: num(minOrderUsdt, 0),
    actualAmount: capped.amount,
    liveFireMaxTradeUsdt: capped.cap || null,
    liveFireCapApplied: capped.capApplied,
  };

  if (sizing?.skip) {
    return buildResult('defer_min_order', sizing.reason || 'position_size_skip', checks);
  }
  if (checks.sizing.actualAmount < checks.sizing.minOrderUsdt) {
    return buildResult(
      'defer_min_order',
      `감산 후 주문금액 ${checks.sizing.actualAmount.toFixed(2)} < 최소 ${checks.sizing.minOrderUsdt}`,
      checks,
    );
  }

  return buildResult('allow', 'preflight_pass', checks);
}

export async function recordEntryPreflightShadow({
  trigger = {},
  exchange = 'binance',
  tradeMode = DEFAULT_TRADE_MODE,
  preflight,
  candidateId = null,
} = {}) {
  if (!preflight) return null;
  await ensureEntryPreflightShadowTable();
  const row = await query(
    `INSERT INTO entry_preflight_shadow
       (trigger_id, candidate_id, symbol, exchange, trade_mode, preflight_decision,
        preflight_reason, preflight_checks, would_defer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     RETURNING *`,
    [
      trigger.id || null,
      candidateId,
      normalizeSymbol(trigger.symbol || preflight.checks?.symbol || ''),
      exchange || preflight.checks?.exchange || 'binance',
      tradeMode || preflight.checks?.tradeMode || DEFAULT_TRADE_MODE,
      preflight.decision,
      preflight.reason || null,
      json(preflight.checks || {}, {}),
      preflight.wouldDefer === true,
    ],
  );
  return row?.[0] || null;
}

export async function attachEntryPreflightShadowSignal(shadowId, signalId) {
  if (!shadowId || !signalId) return null;
  await ensureEntryPreflightShadowTable();
  const row = await query(
    `UPDATE entry_preflight_shadow
        SET materialized_signal_id = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [shadowId, signalId],
  );
  return row?.[0] || null;
}

export async function runEntryMaterializePreflightShadow({
  trigger = {},
  exchange = 'binance',
  amountUsdt = 0,
  rawAmountUsdt = null,
  notifyMultiplier = 1,
  event = null,
  env = process.env,
  deps = {},
} = {}) {
  if (!isEntryPreflightShadowEnabled(env)) {
    return { enabled: false, reason: 'ENTRY_PREFLIGHT_SHADOW_ENABLED=false' };
  }
  const tradeMode = resolveTriggerTradeMode(trigger, DEFAULT_TRADE_MODE);
  const preflight = await evaluateEntryMaterializePreflight({
    trigger,
    exchange,
    amountUsdt,
    rawAmountUsdt,
    notifyMultiplier,
    event,
    env,
    deps,
  });
  const shadowRow = deps.record === false
    ? null
    : await recordEntryPreflightShadow({
      trigger,
      exchange,
      tradeMode,
      preflight,
      candidateId: trigger.trigger_meta?.candidateId || trigger.trigger_meta?.candidate_id || null,
    }).catch((error) => ({
      error: String(error?.message || error),
    }));
  return {
    enabled: true,
    shadowId: shadowRow && !shadowRow.error ? shadowRow.id : null,
    error: shadowRow?.error || null,
    preflight,
  };
}

export async function loadEntryPreflightShadowReport({ days = 14, limit = 50 } = {}) {
  await ensureEntryPreflightShadowTable();
  const summaryRows = await query(
    `WITH shadow AS (
       SELECT eps.*,
              s.status AS current_executor_status,
              s.block_code AS current_executor_block_code,
              s.block_reason AS current_executor_block_reason
         FROM entry_preflight_shadow eps
         LEFT JOIN signals s ON s.id = eps.materialized_signal_id
        WHERE eps.created_at >= now() - ($1 * INTERVAL '1 day')
     ),
     classified AS (
       SELECT *,
              (preflight_decision <> 'allow') AS predicted_block,
              (current_executor_status = 'blocked') AS actual_block,
              CASE
                WHEN materialized_signal_id IS NULL THEN NULL
                WHEN (preflight_decision <> 'allow') = (current_executor_status = 'blocked') THEN true
                ELSE false
              END AS computed_agreement
         FROM shadow
     )
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE materialized_signal_id IS NOT NULL)::int AS linked,
       COUNT(*) FILTER (WHERE predicted_block)::int AS predicted_block,
       COUNT(*) FILTER (WHERE actual_block)::int AS actual_block,
       COUNT(*) FILTER (WHERE computed_agreement IS TRUE)::int AS agreement,
       COUNT(*) FILTER (WHERE predicted_block = false AND actual_block = true)::int AS missed_block,
       COUNT(*) FILTER (WHERE predicted_block = true AND actual_block = false AND materialized_signal_id IS NOT NULL)::int AS over_block,
       ROUND(100.0 * COUNT(*) FILTER (WHERE computed_agreement IS TRUE) / NULLIF(COUNT(*) FILTER (WHERE materialized_signal_id IS NOT NULL), 0), 2) AS agreement_pct
     FROM classified`,
    [Math.max(1, num(days, 14))],
  );
  const byDecision = await query(
    `SELECT preflight_decision, COUNT(*)::int AS count
       FROM entry_preflight_shadow
      WHERE created_at >= now() - ($1 * INTERVAL '1 day')
      GROUP BY 1
      ORDER BY count DESC, preflight_decision`,
    [Math.max(1, num(days, 14))],
  );
  const recent = await query(
    `SELECT eps.id, eps.trigger_id, eps.symbol, eps.exchange, eps.trade_mode,
            eps.preflight_decision, eps.preflight_reason, eps.materialized_signal_id,
            s.status AS executor_status, s.block_code AS executor_block_code,
            s.block_reason AS executor_block_reason,
            CASE
              WHEN eps.materialized_signal_id IS NULL THEN NULL
              WHEN (eps.preflight_decision <> 'allow') = (s.status = 'blocked') THEN true
              ELSE false
            END AS agreement,
            eps.created_at
       FROM entry_preflight_shadow eps
       LEFT JOIN signals s ON s.id = eps.materialized_signal_id
      WHERE eps.created_at >= now() - ($1 * INTERVAL '1 day')
      ORDER BY eps.created_at DESC
      LIMIT $2`,
    [Math.max(1, num(days, 14)), Math.max(1, num(limit, 50))],
  );
  return {
    days: Math.max(1, num(days, 14)),
    summary: summaryRows?.[0] || {},
    byDecision,
    recent,
  };
}

export default {
  isEntryPreflightShadowEnabled,
  evaluateEntryMaterializePreflight,
  runEntryMaterializePreflightShadow,
  attachEntryPreflightShadowSignal,
  loadEntryPreflightShadowReport,
  ensureEntryPreflightShadowTable,
};

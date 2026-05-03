// @ts-nocheck
/**
 * shared/capital-manager.js — 루나팀 자본 관리 모듈
 *
 * 역할: 매매 전 종합 체크 + 동적 포지션 사이징 + 서킷 브레이커
 * 설정: config.yaml capital_management 섹션
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import ccxt from 'ccxt';
import { getInvestmentTradeMode, loadSecrets, isKisPaper } from './secrets.ts';
import { getMinOrderAmount, getMinOrderRatio } from './order-rules.ts';
import { fetchFearGreedIndex } from '../team/argos.ts';
import { getInvestmentExecutionRuntimeConfig, getInvestmentSyncRuntimeConfig } from './runtime-config.ts';
import { getBinanceBalanceSnapshot, getBinanceTickerSnapshot } from './binance-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require  = createRequire(import.meta.url);
const pgPool    = _require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'investment';
const DOMESTIC_CASH_BUFFER_KRW = 10_000;
const dynamicMinOrderLogCache = new Set();

function numEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getLunaLiveFireCaps(env = process.env) {
  const read = (name) => {
    const value = Number(env?.[name]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return {
    maxTradeUsdt: read('LUNA_MAX_TRADE_USDT'),
    maxDailyUsdt: read('LUNA_LIVE_FIRE_MAX_DAILY'),
    maxOpenPositions: read('LUNA_LIVE_FIRE_MAX_OPEN'),
  };
}

function applyLunaLiveFireCaps(policy = {}) {
  const caps = getLunaLiveFireCaps();
  const patched = { ...policy };
  if (caps.maxOpenPositions > 0) {
    patched.max_concurrent_positions = Math.max(1, Math.min(
      Number(patched.max_concurrent_positions || caps.maxOpenPositions),
      caps.maxOpenPositions,
    ));
  }
  return patched;
}

// ─── 설정 로드 ───────────────────────────────────────────────────────

function loadCapitalConfig() {
  const fallbackCryptoMinOrder = getMinOrderAmount('binance') ?? 11;
  try {
    const c  = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    const cm = c.capital_management || {};
    return {
      max_capital_usage:          cm.max_capital_usage          ?? 0.50,
      reserve_ratio:              cm.reserve_ratio              ?? 0.50,
      risk_per_trade:             cm.risk_per_trade             ?? 0.02,
      max_position_pct:           cm.max_position_pct           ?? 0.10,
      max_drawdown_pct:           cm.max_drawdown_pct           ?? 0.15,
      min_order_usdt:             cm.min_order_usdt             ?? fallbackCryptoMinOrder,
      max_concurrent_positions:   cm.max_concurrent_positions   ?? 3,
      max_same_direction_positions: cm.max_same_direction_positions ?? 3,
      max_daily_trades:           cm.max_daily_trades           ?? 15,
      max_daily_loss_pct:         cm.max_daily_loss_pct         ?? 0.10,
      max_weekly_loss_pct:        cm.max_weekly_loss_pct        ?? 0.20,
      cooldown_after_loss_streak: cm.cooldown_after_loss_streak ?? 3,
      cooldown_minutes:           cm.cooldown_minutes           ?? 60,
      dynamic_min_order:          cm.dynamic_min_order          ?? {},
      time_profiles:              cm.time_profiles              ?? {},
      rr_fallback:                cm.rr_fallback                ?? {},
      by_exchange:                cm.by_exchange                ?? {},
    };
  } catch {
    return {
      max_capital_usage: 0.90,  reserve_ratio: 0.10,          risk_per_trade: 0.02,
      max_position_pct: 0.10,   max_drawdown_pct: 0.15, min_order_usdt: fallbackCryptoMinOrder, max_concurrent_positions: 3,
      max_same_direction_positions: 3,
      max_daily_trades: 15,     max_daily_loss_pct: 0.10,     max_weekly_loss_pct: 0.20,
      cooldown_after_loss_streak: 3, cooldown_minutes: 60,
      dynamic_min_order: {},
      time_profiles: {},
      rr_fallback: {},
      by_exchange: {},
    };
  }
}

export const config = loadCapitalConfig();

// ─── 런타임 오버라이드 (Elixir StrategyAdjuster → DB) ────────────────────

/**
 * investment.runtime_overrides 테이블에서 유효한 오버라이드 로드.
 * ALLOW 승인된 항목만 반영. 범위: max_position_pct, risk_per_trade 등 수치형 파라미터.
 * 비동기 함수 — preTradeCheck 호출 시마다 최신 값 반영.
 */
export async function loadRuntimeOverrides(): Promise<Record<string, number>> {
  try {
    const rows = await pgPool.get(
      SCHEMA,
      `SELECT param_key, override_value
       FROM investment.runtime_overrides
       WHERE approved = true
         AND (valid_until IS NULL OR valid_until > NOW())
       ORDER BY inserted_at DESC`,
      []
    );
    if (!rows || rows.length === 0) return {};

    // 동일 param_key 중 최신 1개만 적용
    const seen = new Set<string>();
    const result: Record<string, number> = {};
    for (const row of rows) {
      if (!seen.has(row.param_key)) {
        seen.add(row.param_key);
        // override_value는 JSONB (숫자 또는 숫자 문자열)
        const val = typeof row.override_value === 'number'
          ? row.override_value
          : parseFloat(row.override_value);
        if (!isNaN(val)) result[row.param_key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 런타임 오버라이드를 반영한 자본 설정 반환.
 * preTradeCheck / sizeCalculation에서 사용.
 */
export async function getCapitalConfigWithOverrides(exchange = null, tradeMode = null) {
  const base = getCapitalConfig(exchange, tradeMode);
  const overrides = await loadRuntimeOverrides();
  if (Object.keys(overrides).length === 0) return base;

  // ALLOW 범위 내 수치 파라미터만 적용 (안전 클램프)
  const ALLOW_RANGES: Record<string, [number, number]> = {
    max_position_pct:         [0.05, 0.50],
    max_capital_usage:        [0.50, 0.95],
    max_concurrent_positions: [1,    8],
    max_same_direction_positions: [1, 6],
    cooldown_after_loss_streak: [2, 5],
    cooldown_minutes:         [30, 240],
    risk_per_trade:           [0.01, 0.05],
    'rr_fallback.tp_pct':     [0.02, 0.15],
    'rr_fallback.sl_pct':     [0.01, 0.08],
  };

  const patched = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const range = ALLOW_RANGES[key];
    if (!range) continue;
    const [min, max] = range;
    const clamped = Math.min(max, Math.max(min, value));
    // nested key 지원 (e.g. 'rr_fallback.tp_pct')
    if (key.includes('.')) {
      const [parent, child] = key.split('.');
      if (patched[parent] && typeof patched[parent] === 'object') {
        patched[parent] = { ...patched[parent], [child]: clamped };
      }
    } else {
      (patched as any)[key] = clamped;
    }
  }
  return patched;
}

export function getCapitalConfig(exchange = null, tradeMode = null) {
  if (!exchange) return applyLunaLiveFireCaps(config);
  const override = config.by_exchange?.[exchange] || {};
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const modeOverride = effectiveTradeMode ? (override.trade_modes?.[effectiveTradeMode] || {}) : {};
  return applyLunaLiveFireCaps({
    ...config,
    ...override,
    ...modeOverride,
    by_exchange: config.by_exchange || {},
  });
}

export function formatDailyTradeLimitReason(dailyTrades, maxDailyTrades) {
  const current = Number(dailyTrades || 0);
  const limit = Number(maxDailyTrades || 0);
  if (current > limit) {
    return `일간 매매 한도 초과: 현재 ${current}건 / 한도 ${limit}건`;
  }
  return `일간 매매 한도 도달: 현재 ${current}건 / 한도 ${limit}건`;
}

// ─── 바이낸스 클라이언트 (lazy) ─────────────────────────────────────

let _ex = null;

function getEx() {
  if (_ex) return _ex;
  try {
    const secrets = loadSecrets();
    const c = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    _ex = new ccxt.binance({
      apiKey: secrets.binance_api_key || c.binance?.api_key || '',
      secret: secrets.binance_api_secret || c.binance?.api_secret || '',
      options: { defaultType: 'spot' },
    });
  } catch {
    const secrets = loadSecrets();
    _ex = new ccxt.binance({
      apiKey: secrets.binance_api_key || '',
      secret: secrets.binance_api_secret || '',
      options: { defaultType: 'spot' },
    });
  }
  return _ex;
}

// ─── 잔고 / 자본 조회 ────────────────────────────────────────────────

/**
 * 미추적 BTC의 USD 환산 가치
 * - wallet BTC free − DB positions의 BTC 수량 = 봇 외부 보유 BTC
 * - 이 BTC는 USDT 잔고와 동등하게 가용 자본으로 취급
 */
async function getUntrackedBtcUsd() {
  try {
    const [walletBal, btcTicker, trackedPos] = await Promise.all([
      getBinanceBalanceSnapshot({ omitZeroBalances: false }),
      getBinanceTickerSnapshot('BTC/USDT').catch(() => ({ last: 0 })),
      pgPool.get(SCHEMA, 'SELECT amount FROM investment.positions WHERE symbol = $1 AND paper = false', ['BTC/USDT']).catch(() => null),
    ]);
    const walletBtc  = walletBal.free?.BTC  || 0;
    const trackedBtc = parseFloat(trackedPos?.amount || 0);
    const untracked  = Math.max(0, walletBtc - trackedBtc);
    const usd        = untracked * (btcTicker.last || 0);
    if (untracked > 0) console.log(`[capital] 미추적 BTC: ${untracked.toFixed(6)} (≈$${usd.toFixed(2)})`);
    return usd;
  } catch (e) {
    console.warn('[capital] 미추적 BTC 조회 실패:', e.message);
    return 0;
  }
}

/**
 * 순수 USDT 잔고 (리포팅·모니터링용)
 */
export async function getAvailableUSDT() {
  try {
    const bal = await getBinanceBalanceSnapshot({ omitZeroBalances: false });
    return bal.free?.USDT || 0;
  } catch (e) {
    console.warn('[capital] USDT 잔고 조회 실패:', e.message);
    return 0;
  }
}

/**
 * 가용 자본 = USDT 잔고 + 미추적 BTC USD 환산
 * - BTC를 USDT와 동등하게 취급 → preTradeCheck / sizeCalculation 기준
 */
export async function getAvailableBalance(exchange = null) {
  if (exchange && exchange !== 'binance') return 0;
  try {
    const [usdt, btcUsd] = await Promise.all([
      getAvailableUSDT(),
      getUntrackedBtcUsd(),
    ]);
    return usdt + btcUsd;
  } catch (e) {
    console.warn('[capital] 잔고 조회 실패:', e.message);
    return 0;
  }
}

function normalizeDynamicMinOrderAmount(exchange, amount, fallback = 0) {
  const numeric = Number(amount);
  if (!(numeric > 0)) return fallback;
  if (exchange === 'binance') {
    return Math.max(fallback, Math.round(numeric * 100) / 100);
  }
  return Math.max(fallback, Math.ceil(numeric));
}

function getDynamicMinOrderPolicy(exchange = 'binance', tradeMode = null) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const root = config.dynamic_min_order || {};
  const exchangePolicy = root.by_exchange?.[exchange] || {};
  const modePolicy = effectiveTradeMode ? (exchangePolicy.trade_modes?.[effectiveTradeMode] || {}) : {};
  const capitalPolicy = getCapitalConfig(exchange, effectiveTradeMode);

  const enabled = modePolicy.enabled ?? exchangePolicy.enabled ?? root.enabled ?? true;
  const ratio = Number(
    modePolicy.ratio_of_available_funds
    ?? exchangePolicy.ratio_of_available_funds
    ?? root.ratio_of_available_funds
    ?? getMinOrderRatio(exchange)
    ?? 0.05,
  );
  const fallbackMinOrder = Number(
    modePolicy.fallback_min_order
    ?? exchangePolicy.fallback_min_order
    ?? capitalPolicy.min_order_usdt
    ?? getMinOrderAmount(exchange)
    ?? 0,
  );
  const logDecisions = modePolicy.log_decisions ?? exchangePolicy.log_decisions ?? root.log_decisions ?? true;

  return {
    enabled,
    ratioOfAvailableFunds: Number.isFinite(ratio) && ratio > 0 ? ratio : 0.05,
    fallbackMinOrder: Number.isFinite(fallbackMinOrder) && fallbackMinOrder > 0 ? fallbackMinOrder : (getMinOrderAmount(exchange) ?? 0),
    logDecisions,
  };
}

function logDynamicMinOrderDecision(exchange, tradeMode, kind, payload = {}) {
  const key = JSON.stringify({
    exchange,
    tradeMode: tradeMode || 'normal',
    kind,
    dynamicMinOrderAmount: payload.dynamicMinOrderAmount ?? null,
    availableFunds: payload.availableFunds ?? null,
    ratioOfAvailableFunds: payload.ratioOfAvailableFunds ?? null,
    fallbackMinOrder: payload.fallbackMinOrder ?? null,
    reason: payload.reason ?? null,
  });
  if (dynamicMinOrderLogCache.has(key)) return;
  dynamicMinOrderLogCache.add(key);
  console.log(`[capital] dynamic_min_order ${JSON.stringify({
    exchange,
    tradeMode: tradeMode || 'normal',
    kind,
    ...payload,
  })}`);
}

export async function getMarketAvailableFunds(exchange = null) {
  if (!exchange || exchange === 'binance') {
    return await getAvailableBalance('binance');
  }

  try {
    const kis = await import('./kis-client.ts');
    if (exchange === 'kis') {
      const balance = await kis.getDomesticBalance(isKisPaper()).catch(() => null);
      const depositKrw = Number(balance?.dnca_tot_amt || 0);
      return Math.max(0, depositKrw - DOMESTIC_CASH_BUFFER_KRW);
    }
    if (exchange === 'kis_overseas') {
      const balance = await kis.getOverseasBalance(isKisPaper()).catch(() => null);
      const availableUsd = Number(
        balance?.available_cash_usd
        || balance?.orderable_cash_usd
        || balance?.cash_usd
        || balance?.total_eval_usd
        || 0,
      );
      return Math.max(0, availableUsd);
    }
  } catch (e) {
    console.warn('[capital] 시장별 가용자금 조회 실패:', e.message);
  }

  return 0;
}

export async function getDynamicMinOrderAmount(exchange = 'binance', tradeMode = null) {
  const policy = getDynamicMinOrderPolicy(exchange, tradeMode);
  const fallback = policy.fallbackMinOrder;
  if (!policy.enabled) {
    if (policy.logDecisions) {
      logDynamicMinOrderDecision(exchange, tradeMode, 'fallback', {
        reason: 'dynamic_min_order_disabled',
        fallbackMinOrder: fallback,
        dynamicMinOrderAmount: fallback,
      });
    }
    return fallback;
  }
  const availableFunds = await getMarketAvailableFunds(exchange);
  if (!(availableFunds > 0)) {
    const amount = normalizeDynamicMinOrderAmount(exchange, fallback, fallback);
    if (policy.logDecisions) {
      logDynamicMinOrderDecision(exchange, tradeMode, 'fallback', {
        reason: 'available_funds_unavailable',
        availableFunds,
        fallbackMinOrder: fallback,
        ratioOfAvailableFunds: policy.ratioOfAvailableFunds,
        dynamicMinOrderAmount: amount,
      });
    }
    return amount;
  }
  const amount = normalizeDynamicMinOrderAmount(exchange, availableFunds * policy.ratioOfAvailableFunds, fallback);
  if (policy.logDecisions) {
    logDynamicMinOrderDecision(exchange, tradeMode, 'dynamic', {
      availableFunds,
      fallbackMinOrder: fallback,
      ratioOfAvailableFunds: policy.ratioOfAvailableFunds,
      dynamicMinOrderAmount: amount,
    });
  }
  return amount;
}

/**
 * 총 자본 = USDT 잔고 + 미추적 BTC + 포지션 평가금액 (avg_price 기준)
 */
export async function getTotalCapital(exchange = null) {
  try {
    const balance   = await getAvailableBalance(exchange);  // USDT + 미추적 BTC
    const positions = await getOpenPositions(exchange);
    const posValue  = positions.reduce((s, p) => s + (p.amount || 0) * (p.avg_price || 0), 0);
    return balance + posValue;
  } catch (e) {
    console.warn('[capital] 총 자본 계산 실패:', e.message);
    return 0;
  }
}

// ─── 포지션 조회 ─────────────────────────────────────────────────────

export async function getOpenPositions(exchange = null, paper = false, tradeMode = null) {
  try {
    const conditions = ['amount > 0', `paper = $1`];
    const params = [paper === true];
    const unifyLiveBinance = String(exchange || '').trim().toLowerCase() === 'binance' && paper !== true;

    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode && !unifyLiveBinance) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    if (unifyLiveBinance) {
      const syncRuntime = getInvestmentSyncRuntimeConfig();
      const dustThreshold = Number(syncRuntime?.cryptoMinNotionalUsdt || 10);
      params.push(dustThreshold);
      conditions.push(`((amount * avg_price) >= $${params.length} OR EXISTS (
        SELECT 1
        FROM investment.position_strategy_profiles psp
        WHERE psp.symbol = positions.symbol
          AND psp.exchange = positions.exchange
          AND psp.status = 'active'
      ))`);
    }
    return pgPool.query(
      SCHEMA,
      `SELECT * FROM investment.positions WHERE ${conditions.join(' AND ')}`,
      params,
    );
  } catch (e) {
    console.warn('[capital] 포지션 조회 실패:', e.message);
    return [];
  }
}

function normalizeTradeDirection(direction) {
  const value = String(direction || '').toLowerCase();
  if (value === 'buy' || value === 'long') return 'long';
  if (value === 'sell' || value === 'short') return 'short';
  return null;
}

// ─── PnL / 거래 횟수 ─────────────────────────────────────────────────

export async function getDailyPnL(exchange = null, tradeMode = null) {
  try {
    const conditions = [`status = 'closed'`, `to_timestamp(exit_time / 1000.0)::date = CURRENT_DATE`];
    const params = [];
    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    const rows = await pgPool.query(SCHEMA, `
      SELECT COALESCE(SUM(pnl_net), 0) AS pnl
      FROM trade_journal
      WHERE ${conditions.join(' AND ')}
    `, params);
    return parseFloat(rows[0]?.pnl || 0);
  } catch (e) {
    console.warn('[capital] 일간 PnL 조회 실패:', e.message);
    return 0;
  }
}

export async function getWeeklyPnL(exchange = null, tradeMode = null) {
  try {
    const conditions = [`status = 'closed'`, `to_timestamp(exit_time / 1000.0) >= date_trunc('week', CURRENT_TIMESTAMP)`];
    const params = [];
    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    const rows = await pgPool.query(SCHEMA, `
      SELECT COALESCE(SUM(pnl_net), 0) AS pnl
      FROM trade_journal
      WHERE ${conditions.join(' AND ')}
    `, params);
    return parseFloat(rows[0]?.pnl || 0);
  } catch (e) {
    console.warn('[capital] 주간 PnL 조회 실패:', e.message);
    return 0;
  }
}

export async function getDailyTradeCount({ exchange = null, tradeMode = null, paper = null, side = null } = {}) {
  try {
    const conditions = [`executed_at::date = CURRENT_DATE`];
    const params = [];

    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    if (paper !== null) {
      params.push(paper === true);
      conditions.push(`paper = $${params.length}`);
    }
    if (side) {
      params.push(String(side).toLowerCase());
      conditions.push(`LOWER(COALESCE(side, '')) = $${params.length}`);
    }

    const rows = await pgPool.query(
      SCHEMA,
      `
      SELECT COUNT(*) AS cnt FROM trades
      WHERE ${conditions.join(' AND ')}
    `,
      params,
    );
    return parseInt(rows[0]?.cnt || 0, 10);
  } catch (e) {
    console.warn('[capital] 일간 거래 횟수 조회 실패:', e.message);
    return 0;
  }
}

export async function getDailyTradeNotional({ exchange = null, tradeMode = null, paper = null, side = null } = {}) {
  try {
    const conditions = [`executed_at::date = CURRENT_DATE`];
    const params = [];

    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    if (paper !== null) {
      params.push(paper === true);
      conditions.push(`paper = $${params.length}`);
    }
    if (side) {
      params.push(String(side).toLowerCase());
      conditions.push(`LOWER(COALESCE(side, '')) = $${params.length}`);
    }

    const rows = await pgPool.query(
      SCHEMA,
      `
      SELECT COALESCE(SUM(ABS(COALESCE(total_usdt, amount * price, 0))), 0) AS notional
      FROM trades
      WHERE ${conditions.join(' AND ')}
    `,
      params,
    );
    return Number(rows[0]?.notional || 0);
  } catch (e) {
    console.warn('[capital] 일간 거래 금액 조회 실패:', e.message);
    return 0;
  }
}

async function getRecentClosedTrades(n, exchange = null, tradeMode = null) {
  try {
    const conditions = [`status = 'closed'`];
    const params = [];
    if (exchange) {
      params.push(exchange);
      conditions.push(`exchange = $${params.length}`);
    }
    if (tradeMode) {
      params.push(tradeMode);
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
    params.push(n);
    return pgPool.query(SCHEMA, `
      SELECT pnl_net, exit_time
      FROM trade_journal
      WHERE ${conditions.join(' AND ')}
      ORDER BY exit_time DESC
      LIMIT $${params.length}
    `, params);
  } catch (e) {
    console.warn('[capital] 최근 거래 조회 실패:', e.message);
    return [];
  }
}

export async function checkCorrelationGuard(symbol, direction, exchange = 'binance', tradeMode = null) {
  try {
    const normalizedDirection = normalizeTradeDirection(direction);
    if (!normalizedDirection) return { ok: true };

    const openPositions = await getOpenPositions(exchange, false, tradeMode);
    const sameDirectionCount = openPositions.filter((position) => {
      const sideDirection = normalizeTradeDirection(position.side || position.direction || 'buy');
      return sideDirection === normalizedDirection;
    }).length;

    const policy = await getCapitalConfigWithOverrides(exchange, tradeMode);
    const maxSameDirection = Number(policy.max_same_direction_positions || 3);
    if (sameDirectionCount >= maxSameDirection) {
      const softening = getCryptoGuardSofteningPolicy(exchange, tradeMode);
      const overflowLimit = maxSameDirection + Number(softening?.correlationGuard?.allowOverflowSlots || 0);
      const reductionMultiplier = Number(softening?.correlationGuard?.reductionMultiplier || 0);
      if (
        softening?.enabled === true
        && softening?.correlationGuard?.enabled === true
        && sameDirectionCount < overflowLimit
        && reductionMultiplier > 0
        && reductionMultiplier < 1
      ) {
        return {
          ok: true,
          softened: true,
          reason: `상관관계 가드 완화: 같은 방향(${normalizedDirection}) 포지션 ${sameDirectionCount}개 (한도: ${maxSameDirection}, 개발단계 감산 허용)`,
          softGuard: {
            kind: 'correlation_guard_softened',
            exchange,
            tradeMode: tradeMode || getInvestmentTradeMode(),
            reductionMultiplier,
            sameDirectionCount,
            maxSameDirection,
            allowOverflowSlots: Number(softening?.correlationGuard?.allowOverflowSlots || 0),
          },
        };
      }
      return {
        ok: false,
        reason: `상관관계 가드: 같은 방향(${normalizedDirection}) 포지션 ${sameDirectionCount}개 (한도: ${maxSameDirection})`,
      };
    }

    return { ok: true };
  } catch (e) {
    console.warn('[capital] 상관관계 가드 체크 실패:', e.message);
    return { ok: true };
  }
}

export function getVolatilityAdjustedRisk(baseRisk, fearGreedIndex, atrRatio = 1.0) {
  let multiplier = 1.0;
  const fng = Number(fearGreedIndex);
  const atr = Number(atrRatio);

  if (Number.isFinite(fng)) {
    if (fng > 85 || fng < 15) multiplier = 0.25;
    else if (fng > 75 || fng < 25) multiplier = 0.5;
  }

  if (Number.isFinite(atr) && atr > 2.0) multiplier *= 0.5;
  else if (Number.isFinite(atr) && atr > 1.5) multiplier *= 0.75;

  return Math.max(baseRisk * multiplier, 0.005);
}

// ─── 서킷 브레이커 ──────────────────────────────────────────────────

export async function checkCircuitBreaker(exchange = null, tradeMode = null) {
  try {
    const policy = await getCapitalConfigWithOverrides(exchange, tradeMode);
    const totalCapital = await getTotalCapital(exchange);
    if (totalCapital <= 0) return { triggered: false };

    // 1. 일간 손실 한도
    const dailyPnL = await getDailyPnL(exchange, tradeMode);
    if (dailyPnL < -(totalCapital * policy.max_daily_loss_pct)) {
      return {
        triggered: true,
        reason:    `일간 손실 한도 초과: ${dailyPnL.toFixed(2)} USDT (한도: -${(totalCapital * policy.max_daily_loss_pct).toFixed(2)})`,
        type:      'daily_loss',
      };
    }

    // 2. 주간 손실 한도
    const weeklyPnL = await getWeeklyPnL(exchange, tradeMode);
    if (weeklyPnL < -(totalCapital * policy.max_weekly_loss_pct)) {
      return {
        triggered: true,
        reason:    `주간 손실 한도 초과: ${weeklyPnL.toFixed(2)} USDT (한도: -${(totalCapital * policy.max_weekly_loss_pct).toFixed(2)})`,
        type:      'weekly_loss',
      };
    }

    // 3. 연속 손실 쿨다운
    const recentTrades = await getRecentClosedTrades(policy.cooldown_after_loss_streak, exchange, tradeMode);
    if (recentTrades.length >= policy.cooldown_after_loss_streak) {
      const allLosses = recentTrades.every(t => parseFloat(t.pnl_net || 0) < 0);
      if (allLosses) {
        const lastTime    = new Date(parseInt(recentTrades[0].exit_time, 10)).getTime();
        const cooldownEnd = lastTime + (policy.cooldown_minutes * 60 * 1000);
        if (Date.now() < cooldownEnd) {
          const remainMin = Math.ceil((cooldownEnd - Date.now()) / 60000);
          const softening = getCryptoGuardSofteningPolicy(exchange, tradeMode);
          const allowedTypes = Array.isArray(softening?.circuitBreaker?.allowedTypes)
            ? softening.circuitBreaker.allowedTypes
            : [];
          const reductionMultiplier = Number(softening?.circuitBreaker?.reductionMultiplier || 0);
          const maxRemainingCooldownMinutes = Number(softening?.circuitBreaker?.maxRemainingCooldownMinutes || 0);
          if (
            softening?.enabled === true
            && softening?.circuitBreaker?.enabled === true
            && allowedTypes.includes('loss_streak')
            && reductionMultiplier > 0
            && reductionMultiplier < 1
            && remainMin <= maxRemainingCooldownMinutes
          ) {
            return {
              triggered: false,
              softened: true,
              reason: `연속 ${policy.cooldown_after_loss_streak}회 손실이지만 개발단계 완화로 감산 허용 (${remainMin}분 잔여)`,
              type: 'loss_streak',
              softGuard: {
                kind: 'circuit_breaker_softened',
                exchange: exchange || 'binance',
                tradeMode: tradeMode || getInvestmentTradeMode(),
                reductionMultiplier,
                remainMinutes: remainMin,
                cooldownMinutes: Number(policy.cooldown_minutes || 0),
                cooldownAfterLossStreak: Number(policy.cooldown_after_loss_streak || 0),
              },
            };
          }
          return {
            triggered: true,
            reason:    `연속 ${policy.cooldown_after_loss_streak}회 손실 → 쿨다운 ${remainMin}분 남음`,
            type:      'loss_streak',
          };
        }
      }
    }

    return { triggered: false };
  } catch (e) {
    console.warn('[capital] 서킷 브레이커 체크 실패:', e.message);
    return { triggered: false };
  }
}

// ─── 매매 전 종합 체크 ──────────────────────────────────────────────

/**
 * @param {string} symbol       — 심볼 (BTC/USDT)
 * @param {string} direction    — 'BUY' | 'SELL'
 * @param {number} estimatedAmount — 예상 매매 금액 (USDT)
 * @param {string|null} exchange   — 포지션 제한을 적용할 거래소 (예: 'binance')
 * @returns {Promise<{ allowed: boolean, reason?: string, balance?: number, dailyTrades?: number, circuit?: boolean, circuitType?: string }>}
 */
export async function preTradeCheck(symbol, direction, estimatedAmount = 0, exchange = null, tradeMode = null) {
  const isBuy = direction === 'BUY' || direction === 'buy';
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const policy = await getCapitalConfigWithOverrides(exchange, effectiveTradeMode);
  const minOrderUsdt = await getDynamicMinOrderAmount(exchange || 'binance');
  /** @type {Array<Record<string, any>>} */
  const softGuards = [];

  // 1. 가용 잔고 (BUY만)
  if (isBuy) {
    const balance = await getAvailableBalance(exchange);
    if (balance < minOrderUsdt) {
      return { allowed: false, reason: `잔고 부족: ${balance.toFixed(2)} < 최소 ${minOrderUsdt}` };
    }

    // 2. 현금 보유 비율
    const totalCapital    = await getTotalCapital(exchange);
    const reserveRequired = totalCapital * policy.reserve_ratio;
    if (balance - estimatedAmount < reserveRequired) {
      return {
        allowed: false,
        reason:  `현금 보유 부족: 매매 후 ${(balance - estimatedAmount).toFixed(2)} USDT < 예비금 ${reserveRequired.toFixed(2)} USDT`,
      };
    }

    // 3. 동시 포지션 제한
    const openPositions = await getOpenPositions(exchange, false, effectiveTradeMode);
    if (openPositions.length >= policy.max_concurrent_positions) {
      return { allowed: false, reason: `최대 포지션 도달: ${openPositions.length}/${policy.max_concurrent_positions}` };
    }
  }

  // 4. 서킷 브레이커 (BUY/SELL 공통)
  const circuitCheck = await checkCircuitBreaker(exchange, effectiveTradeMode);
  if (circuitCheck.triggered) {
    return { allowed: false, reason: `서킷 브레이커: ${circuitCheck.reason}`, circuit: true, circuitType: circuitCheck.type };
  }
  if (circuitCheck.softened && circuitCheck.softGuard) {
    softGuards.push(circuitCheck.softGuard);
  }

  const correlationGuard = await checkCorrelationGuard(symbol, direction, exchange || 'binance', effectiveTradeMode);
  if (!correlationGuard.ok) {
    return {
      allowed: false,
      approved: false,
      reason: correlationGuard.reason,
      type: 'correlation_guard',
    };
  }
  if (correlationGuard.softened && correlationGuard.softGuard) {
    softGuards.push(correlationGuard.softGuard);
  }

  // 5. 일간 매매 횟수 (BUY만)
  if (isBuy) {
    const dailyTrades = await getDailyTradeCount({ exchange, tradeMode: effectiveTradeMode, side: 'buy' });
    if (dailyTrades >= policy.max_daily_trades) {
      return { allowed: false, reason: formatDailyTradeLimitReason(dailyTrades, policy.max_daily_trades) };
    }
    const liveFireDailyLimit = numEnv('LUNA_LIVE_FIRE_MAX_DAILY', 0);
    if (liveFireDailyLimit > 0) {
      const dailyNotional = await getDailyTradeNotional({ exchange, tradeMode: effectiveTradeMode, paper: false, side: 'buy' });
      const projectedNotional = dailyNotional + Number(estimatedAmount || 0);
      if (projectedNotional > liveFireDailyLimit) {
        return {
          allowed: false,
          reason: `live_fire_daily_notional_limit: ${(projectedNotional).toFixed(2)} > ${liveFireDailyLimit}`,
          dailyNotional,
          maxDailyNotional: liveFireDailyLimit,
        };
      }
    }
    return buildAllowedTradeDecision({ allowed: true, dailyTrades, softGuards });
  }

  return buildAllowedTradeDecision({ allowed: true, softGuards });
}

function getCryptoGuardSofteningPolicy(exchange = null, tradeMode = null) {
  const execution = getInvestmentExecutionRuntimeConfig();
  const root = execution?.cryptoGuardSoftening || {};
  const exchangeKey = exchange || 'binance';
  const tradeModeKey = tradeMode || getInvestmentTradeMode() || 'normal';
  const exchangePolicy = root.byExchange?.[exchangeKey] || {};
  const modePolicy = exchangePolicy.tradeModes?.[tradeModeKey] || {};
  return {
    enabled: root.enabled !== false && exchangePolicy.enabled !== false && modePolicy.enabled !== false,
    circuitBreaker: modePolicy.circuitBreaker || exchangePolicy.circuitBreaker || root.circuitBreaker || {},
    correlationGuard: modePolicy.correlationGuard || exchangePolicy.correlationGuard || root.correlationGuard || {},
  };
}

function buildAllowedTradeDecision(base = {}) {
  const softGuards = Array.isArray(base.softGuards) ? base.softGuards.filter(Boolean) : [];
  if (softGuards.length === 0) return base;
  const multipliers = softGuards
    .map((guard) => Number(guard?.reductionMultiplier || 0))
    .filter((value) => value > 0 && value < 1);
  const reducedAmountMultiplier = multipliers.length > 0 ? Math.min(...multipliers) : 1;
  return {
    ...base,
    softGuardApplied: softGuards.length > 0,
    softGuards,
    reducedAmountMultiplier,
  };
}

// ─── 동적 포지션 사이징 ─────────────────────────────────────────────

/**
 * 리스크 기반 포지션 사이징 (업계 표준)
 * @param {string} symbol
 * @param {number} entryPrice
 * @param {number} stopLossPrice  — 0이면 고정 3% 폴백
 * @returns {Promise<{ size: number, sizeInCoin?: number, riskAmount?: number, riskPercent?: number, capitalPct?: string|number, skip: boolean, reason?: string }>}
 */
export async function calculatePositionSize(symbol, entryPrice, stopLossPrice, exchange = null) {
  const policy = getCapitalConfig(exchange);
  const balance      = await getAvailableBalance(exchange);
  const totalCapital = await getTotalCapital(exchange);
  const minOrderUsdt = await getDynamicMinOrderAmount(exchange || 'binance');

  if (totalCapital <= 0) return { size: 0, skip: true, reason: '총 자본 없음' };

  // 리스크 기반 사이징
  const fearGreedIndex = await fetchFearGreedIndex().catch(() => 50);
  const adjustedRisk = getVolatilityAdjustedRisk(policy.risk_per_trade, fearGreedIndex, 1.0);
  const accountRisk = totalCapital * adjustedRisk;
  const tradeRisk   = (entryPrice > 0 && stopLossPrice > 0)
    ? Math.abs(entryPrice - stopLossPrice) / entryPrice
    : 0.03;  // SL 없으면 기본 3% 리스크

  let size = accountRisk / tradeRisk;

  // 단일 포지션 최대 비율 제한
  size = Math.min(size, totalCapital * policy.max_position_pct);

  // 현금 보유 비율 고려한 가용 한도
  const usable = balance - (totalCapital * policy.reserve_ratio);
  size = Math.min(size, Math.max(0, usable));

  if (size < minOrderUsdt) {
    return {
      size:   0,
      skip:   true,
      reason: `포지션 크기 ${size.toFixed(2)} < 최소 ${minOrderUsdt}`,
    };
  }

  return {
    size,
    sizeInCoin:  entryPrice > 0 ? size / entryPrice : 0,
    riskAmount:  accountRisk,
    riskPercent: adjustedRisk * 100,
    capitalPct:  (size / totalCapital * 100).toFixed(1),
    skip:        false,
  };
}

// ─── 루나 자본 상태 머신 ─────────────────────────────────────────────

export type LunaCapitalMode =
  | 'ACTIVE_DISCOVERY'
  | 'CASH_CONSTRAINED'
  | 'POSITION_MONITOR_ONLY'
  | 'BALANCE_UNAVAILABLE'
  | 'REDUCING_ONLY';

export interface LunaBuyingPowerSnapshot {
  exchange: 'binance' | 'kis' | 'kis_overseas';
  tradeMode: string;
  mode: LunaCapitalMode;
  reasonCode: string | null;
  freeCash: number;
  availableBalance: number;
  reservedCash: number;
  buyableAmount: number;
  minOrderAmount: number;
  feeBufferAmount: number;
  openPositionCount: number;
  maxPositionCount: number;
  remainingSlots: number;
  totalCapital: number;
  balanceStatus: 'ok' | 'unavailable' | 'stale';
  source: 'broker' | 'db_fallback' | 'paper' | 'unavailable';
  observedAt: string;
}

export type LunaOrderCandidateResult =
  | 'accepted'
  | 'reduced'
  | 'blocked_cash'
  | 'blocked_slots'
  | 'blocked_balance_unavailable'
  | 'reduce_only';

export interface LunaBudgetCheckResult {
  result: LunaOrderCandidateResult;
  desiredAmount: number;
  adjustedAmount: number;
  minOrderAmount: number;
  reason: string;
  effectiveSlots?: number;
  originalRemainingSlots?: number;
}

/**
 * USDT 잔고를 가져오되, 실패 시 null을 반환해 0과 구분한다.
 */
async function getAvailableUSDTOrNull(): Promise<number | null> {
  try {
    const bal = await getBinanceBalanceSnapshot({ omitZeroBalances: false });
    const usdt = bal.free?.USDT;
    if (usdt === undefined || usdt === null) return null;
    return Number(usdt);
  } catch {
    return null;
  }
}

/**
 * 거래소별 루나 매수 가능 파워 스냅샷을 반환한다.
 * - balanceStatus=unavailable이면 신규 BUY는 금지 (fail-closed)
 */
export async function getLunaBuyingPowerSnapshot(
  exchange: 'binance' | 'kis' | 'kis_overseas' = 'binance',
  tradeMode: string | null = null,
): Promise<LunaBuyingPowerSnapshot> {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode() || 'normal';
  const observedAt = new Date().toISOString();

  const policy = await getCapitalConfigWithOverrides(exchange, effectiveTradeMode);
  const minOrderAmount = await getDynamicMinOrderAmount(exchange, effectiveTradeMode);

  let freeCash = 0;
  let balanceStatus: 'ok' | 'unavailable' | 'stale' = 'ok';
  let source: 'broker' | 'db_fallback' | 'paper' | 'unavailable' = 'broker';

  if (exchange === 'binance') {
    const rawUsdt = await getAvailableUSDTOrNull();
    if (rawUsdt === null) {
      balanceStatus = 'unavailable';
      source = 'unavailable';
      freeCash = 0;
    } else {
      freeCash = rawUsdt;
    }
  } else if (exchange === 'kis') {
    try {
      const kis = await import('./kis-client.ts');
      const balance = await kis.getDomesticBalance(isKisPaper()).catch(() => null);
      freeCash = Math.max(0, Number(balance?.dnca_tot_amt || 0) - DOMESTIC_CASH_BUFFER_KRW);
      if (!balance) { balanceStatus = 'unavailable'; source = 'unavailable'; }
    } catch {
      balanceStatus = 'unavailable';
      source = 'unavailable';
    }
  } else if (exchange === 'kis_overseas') {
    try {
      const kis = await import('./kis-client.ts');
      const balance = await kis.getOverseasBalance(isKisPaper()).catch(() => null);
      freeCash = Math.max(0, Number(balance?.available_cash_usd || balance?.orderable_cash_usd || 0));
      if (!balance) { balanceStatus = 'unavailable'; source = 'unavailable'; }
    } catch {
      balanceStatus = 'unavailable';
      source = 'unavailable';
    }
  }

  const openPositions = await getOpenPositions(exchange, false, effectiveTradeMode).catch(() => []);
  const openPositionCount = openPositions.length;
  const maxPositionCount = Number(policy.max_concurrent_positions || 3);
  const remainingSlots = Math.max(0, maxPositionCount - openPositionCount);
  const circuit = balanceStatus === 'ok'
    ? await checkCircuitBreaker(exchange, effectiveTradeMode).catch(() => ({ triggered: false }))
    : { triggered: false };

  let totalCapital = freeCash;
  if (balanceStatus === 'ok') {
    const posValue = openPositions.reduce((s, p) => s + (p.amount || 0) * (p.avg_price || 0), 0);
    totalCapital = freeCash + posValue;
  }

  const reservedCash = totalCapital > 0 ? totalCapital * Number(policy.reserve_ratio || 0) : 0;
  const feeBufferAmount = freeCash > 0 ? freeCash * 0.002 : 0;
  const buyableAmount = Math.max(0, freeCash - reservedCash - feeBufferAmount);

  // 운용 모드 결정
  let mode: LunaCapitalMode = 'ACTIVE_DISCOVERY';
  let reasonCode: string | null = null;

  if (balanceStatus === 'unavailable') {
    mode = 'BALANCE_UNAVAILABLE';
    reasonCode = 'buying_power_unavailable';
  } else if (circuit?.triggered) {
    mode = 'REDUCING_ONLY';
    reasonCode = 'reducing_only_mode';
  } else if (openPositionCount >= maxPositionCount) {
    mode = 'POSITION_MONITOR_ONLY';
    reasonCode = 'position_slots_exhausted';
  } else if (buyableAmount < minOrderAmount) {
    mode = remainingSlots > 0 ? 'CASH_CONSTRAINED' : 'POSITION_MONITOR_ONLY';
    reasonCode = 'cash_constrained_monitor_only';
  }

  return {
    exchange,
    tradeMode: effectiveTradeMode,
    mode,
    reasonCode,
    freeCash,
    availableBalance: freeCash,
    reservedCash,
    buyableAmount,
    minOrderAmount,
    feeBufferAmount,
    openPositionCount,
    maxPositionCount,
    remainingSlots,
    totalCapital,
    balanceStatus,
    source,
    observedAt,
  };
}

/**
 * BUY 후보 금액을 가용 자본/잔여 슬롯 기준으로 조정한다.
 * - accepted: 원 금액 그대로 가능
 * - reduced: 감산 후 min order 이상이면 허용
 * - blocked_*: BUY 불가, HOLD로 전환
 */
export function adjustLunaBuyCandidate(
  desiredAmount: number,
  snapshot: LunaBuyingPowerSnapshot,
): LunaBudgetCheckResult {
  const { minOrderAmount, buyableAmount, balanceStatus, remainingSlots, mode } = snapshot;

  if (balanceStatus === 'unavailable') {
    return {
      result: 'blocked_balance_unavailable',
      desiredAmount,
      adjustedAmount: 0,
      minOrderAmount,
      reason: 'buying_power_unavailable: 잔고 조회 실패',
    };
  }

  if (mode === 'REDUCING_ONLY') {
    return {
      result: 'reduce_only',
      desiredAmount,
      adjustedAmount: 0,
      minOrderAmount,
      reason: 'reduce_only_mode: 신규 BUY 금지',
    };
  }

  if (remainingSlots <= 0) {
    return {
      result: 'blocked_slots',
      desiredAmount,
      adjustedAmount: 0,
      minOrderAmount,
      reason: 'position_slots_exhausted: 포지션 슬롯 없음',
    };
  }

  if (buyableAmount < minOrderAmount) {
    return {
      result: 'blocked_cash',
      desiredAmount,
      adjustedAmount: 0,
      minOrderAmount,
      reason: `cash_constrained_monitor_only: 매수가능금액 ${buyableAmount.toFixed(2)} < 최소 ${minOrderAmount}`,
    };
  }

  // 가용 현금이 전체 슬롯을 모두 채우지 못하면, 가능한 슬롯 수로 축소해 BUY를 보류 대신 감산한다.
  const feasibleSlotsByCash = Math.max(1, Math.floor(buyableAmount / Math.max(1, minOrderAmount)));
  const effectiveSlots = Math.max(1, Math.min(remainingSlots, feasibleSlotsByCash));
  const perSlotAmount = Math.floor(buyableAmount / effectiveSlots);
  const adjustedAmount = Math.min(desiredAmount, perSlotAmount);

  if (adjustedAmount < minOrderAmount) {
    return {
      result: 'blocked_cash',
      desiredAmount,
      adjustedAmount: 0,
      minOrderAmount,
      reason: `cash_constrained_monitor_only: 슬롯 배분 후 ${adjustedAmount.toFixed(2)} < 최소 ${minOrderAmount} (가용 슬롯 ${remainingSlots}→${effectiveSlots})`,
      effectiveSlots,
      originalRemainingSlots: remainingSlots,
    };
  }

  if (adjustedAmount < desiredAmount) {
    return {
      result: 'reduced',
      desiredAmount,
      adjustedAmount,
      minOrderAmount,
      reason: `buy_amount_adjusted: ${desiredAmount} → ${adjustedAmount} (가용 ${buyableAmount.toFixed(2)}, 슬롯 ${remainingSlots}→${effectiveSlots})`,
      effectiveSlots,
      originalRemainingSlots: remainingSlots,
    };
  }

  return {
    result: 'accepted',
    desiredAmount,
    adjustedAmount: desiredAmount,
    minOrderAmount,
    reason: 'accepted',
    effectiveSlots,
    originalRemainingSlots: remainingSlots,
  };
}

// ─── 자본 현황 요약 ──────────────────────────────────────────────────

export async function getCapitalStatus() {
  const [usdtBalance, btcUsd, openPositions, dailyPnL, weeklyPnL, dailyTradeCount, circuit] = await Promise.all([
    getAvailableUSDT(),
    getUntrackedBtcUsd(),
    getOpenPositions(),
    getDailyPnL(),
    getWeeklyPnL(),
    getDailyTradeCount(),
    checkCircuitBreaker(),
  ]);
  const balance       = usdtBalance + btcUsd;
  const positionValue = openPositions.reduce((s, p) => s + (p.amount || 0) * (p.avg_price || 0), 0);
  const totalCapital  = balance + positionValue;

  return {
    totalCapital,
    availableBalance:   balance,
    usdtBalance,                    // 순수 USDT
    untrackedBtcUsd:    btcUsd,     // 미추적 BTC USD 환산
    positionValue,
    openPositionCount:  openPositions.length,
    openPositions,
    dailyPnL,
    weeklyPnL,
    dailyTradeCount,
    circuit,
    config,
  };
}

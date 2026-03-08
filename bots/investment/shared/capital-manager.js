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

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require  = createRequire(import.meta.url);
const pgPool    = _require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'investment';

// ─── 설정 로드 ───────────────────────────────────────────────────────

function loadCapitalConfig() {
  try {
    const c  = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    const cm = c.capital_management || {};
    return {
      max_capital_usage:          cm.max_capital_usage          ?? 0.50,
      reserve_ratio:              cm.reserve_ratio              ?? 0.50,
      risk_per_trade:             cm.risk_per_trade             ?? 0.02,
      max_position_pct:           cm.max_position_pct           ?? 0.10,
      min_order_usdt:             cm.min_order_usdt             ?? 11,
      max_concurrent_positions:   cm.max_concurrent_positions   ?? 3,
      max_daily_trades:           cm.max_daily_trades           ?? 10,
      max_daily_loss_pct:         cm.max_daily_loss_pct         ?? 0.10,
      max_weekly_loss_pct:        cm.max_weekly_loss_pct        ?? 0.20,
      cooldown_after_loss_streak: cm.cooldown_after_loss_streak ?? 3,
      cooldown_minutes:           cm.cooldown_minutes           ?? 60,
    };
  } catch {
    return {
      max_capital_usage: 0.90,  reserve_ratio: 0.10,          risk_per_trade: 0.02,
      max_position_pct: 0.10,   min_order_usdt: 11,           max_concurrent_positions: 3,
      max_daily_trades: 10,     max_daily_loss_pct: 0.10,     max_weekly_loss_pct: 0.20,
      cooldown_after_loss_streak: 3, cooldown_minutes: 60,
    };
  }
}

export const config = loadCapitalConfig();

// ─── 바이낸스 클라이언트 (lazy) ─────────────────────────────────────

let _ex = null;

function getEx() {
  if (_ex) return _ex;
  try {
    const c = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    _ex = new ccxt.binance({
      apiKey: c.binance?.api_key || '',
      secret: c.binance?.api_secret || '',
      options: { defaultType: 'spot' },
    });
  } catch {
    _ex = new ccxt.binance({});
  }
  return _ex;
}

// ─── 잔고 / 자본 조회 ────────────────────────────────────────────────

/**
 * 가용 USDT 잔고 (실잔고)
 */
export async function getAvailableBalance() {
  try {
    const bal = await getEx().fetchBalance();
    return bal.free?.USDT || 0;
  } catch (e) {
    console.warn('[capital] 잔고 조회 실패:', e.message);
    return 0;
  }
}

/**
 * 총 자본 = USDT 잔고 + 포지션 평가금액 (avg_price 기준)
 */
export async function getTotalCapital() {
  try {
    const balance   = await getAvailableBalance();
    const positions = await getOpenPositions();
    const posValue  = positions.reduce((s, p) => s + (p.amount || 0) * (p.avg_price || 0), 0);
    return balance + posValue;
  } catch (e) {
    console.warn('[capital] 총 자본 계산 실패:', e.message);
    return 0;
  }
}

// ─── 포지션 조회 ─────────────────────────────────────────────────────

export async function getOpenPositions() {
  try {
    return pgPool.query(SCHEMA, 'SELECT * FROM positions WHERE amount > 0', []);
  } catch (e) {
    console.warn('[capital] 포지션 조회 실패:', e.message);
    return [];
  }
}

// ─── PnL / 거래 횟수 ─────────────────────────────────────────────────

export async function getDailyPnL() {
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT COALESCE(SUM(pnl_net), 0) AS pnl
      FROM trade_journal
      WHERE status = 'closed'
        AND to_timestamp(exit_time / 1000.0)::date = CURRENT_DATE
    `, []);
    return parseFloat(rows[0]?.pnl || 0);
  } catch (e) {
    console.warn('[capital] 일간 PnL 조회 실패:', e.message);
    return 0;
  }
}

export async function getWeeklyPnL() {
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT COALESCE(SUM(pnl_net), 0) AS pnl
      FROM trade_journal
      WHERE status = 'closed'
        AND to_timestamp(exit_time / 1000.0) >= date_trunc('week', CURRENT_TIMESTAMP)
    `, []);
    return parseFloat(rows[0]?.pnl || 0);
  } catch (e) {
    console.warn('[capital] 주간 PnL 조회 실패:', e.message);
    return 0;
  }
}

export async function getDailyTradeCount() {
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT COUNT(*) AS cnt FROM trades
      WHERE executed_at::date = CURRENT_DATE
    `, []);
    return parseInt(rows[0]?.cnt || 0, 10);
  } catch (e) {
    console.warn('[capital] 일간 거래 횟수 조회 실패:', e.message);
    return 0;
  }
}

async function getRecentClosedTrades(n) {
  try {
    return pgPool.query(SCHEMA, `
      SELECT pnl_net, exit_time
      FROM trade_journal
      WHERE status = 'closed'
      ORDER BY exit_time DESC
      LIMIT $1
    `, [n]);
  } catch (e) {
    console.warn('[capital] 최근 거래 조회 실패:', e.message);
    return [];
  }
}

// ─── 서킷 브레이커 ──────────────────────────────────────────────────

export async function checkCircuitBreaker() {
  try {
    const totalCapital = await getTotalCapital();
    if (totalCapital <= 0) return { triggered: false };

    // 1. 일간 손실 한도
    const dailyPnL = await getDailyPnL();
    if (dailyPnL < -(totalCapital * config.max_daily_loss_pct)) {
      return {
        triggered: true,
        reason:    `일간 손실 한도 초과: ${dailyPnL.toFixed(2)} USDT (한도: -${(totalCapital * config.max_daily_loss_pct).toFixed(2)})`,
        type:      'daily_loss',
      };
    }

    // 2. 주간 손실 한도
    const weeklyPnL = await getWeeklyPnL();
    if (weeklyPnL < -(totalCapital * config.max_weekly_loss_pct)) {
      return {
        triggered: true,
        reason:    `주간 손실 한도 초과: ${weeklyPnL.toFixed(2)} USDT (한도: -${(totalCapital * config.max_weekly_loss_pct).toFixed(2)})`,
        type:      'weekly_loss',
      };
    }

    // 3. 연속 손실 쿨다운
    const recentTrades = await getRecentClosedTrades(config.cooldown_after_loss_streak);
    if (recentTrades.length >= config.cooldown_after_loss_streak) {
      const allLosses = recentTrades.every(t => parseFloat(t.pnl_net || 0) < 0);
      if (allLosses) {
        const lastTime    = new Date(parseInt(recentTrades[0].exit_time, 10)).getTime();
        const cooldownEnd = lastTime + (config.cooldown_minutes * 60 * 1000);
        if (Date.now() < cooldownEnd) {
          const remainMin = Math.ceil((cooldownEnd - Date.now()) / 60000);
          return {
            triggered: true,
            reason:    `연속 ${config.cooldown_after_loss_streak}회 손실 → 쿨다운 ${remainMin}분 남음`,
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
 * @returns {{ allowed: boolean, reason?: string, balance?: number, dailyTrades?: number }}
 */
export async function preTradeCheck(symbol, direction, estimatedAmount = 0) {
  const isBuy = direction === 'BUY' || direction === 'buy';

  // 1. 가용 잔고 (BUY만)
  if (isBuy) {
    const balance = await getAvailableBalance();
    if (balance < config.min_order_usdt) {
      return { allowed: false, reason: `잔고 부족: ${balance.toFixed(2)} USDT < 최소 ${config.min_order_usdt} USDT` };
    }

    // 2. 현금 보유 비율
    const totalCapital    = await getTotalCapital();
    const reserveRequired = totalCapital * config.reserve_ratio;
    if (balance - estimatedAmount < reserveRequired) {
      return {
        allowed: false,
        reason:  `현금 보유 부족: 매매 후 ${(balance - estimatedAmount).toFixed(2)} USDT < 예비금 ${reserveRequired.toFixed(2)} USDT`,
      };
    }

    // 3. 동시 포지션 제한
    const openPositions = await getOpenPositions();
    if (openPositions.length >= config.max_concurrent_positions) {
      return { allowed: false, reason: `최대 포지션 도달: ${openPositions.length}/${config.max_concurrent_positions}` };
    }
  }

  // 4. 서킷 브레이커 (BUY/SELL 공통)
  const circuitCheck = await checkCircuitBreaker();
  if (circuitCheck.triggered) {
    return { allowed: false, reason: `서킷 브레이커: ${circuitCheck.reason}`, circuit: true, circuitType: circuitCheck.type };
  }

  // 5. 일간 매매 횟수 (BUY만)
  if (isBuy) {
    const dailyTrades = await getDailyTradeCount();
    if (dailyTrades >= config.max_daily_trades) {
      return { allowed: false, reason: `일간 매매 한도: ${dailyTrades}/${config.max_daily_trades}` };
    }
    return { allowed: true, dailyTrades };
  }

  return { allowed: true };
}

// ─── 동적 포지션 사이징 ─────────────────────────────────────────────

/**
 * 리스크 기반 포지션 사이징 (업계 표준)
 * @param {string} symbol
 * @param {number} entryPrice
 * @param {number} stopLossPrice  — 0이면 고정 3% 폴백
 * @returns {{ size, sizeInCoin, riskAmount, riskPercent, capitalPct, skip, reason? }}
 */
export async function calculatePositionSize(symbol, entryPrice, stopLossPrice) {
  const balance      = await getAvailableBalance();
  const totalCapital = await getTotalCapital();

  if (totalCapital <= 0) return { size: 0, skip: true, reason: '총 자본 없음' };

  // 리스크 기반 사이징
  const accountRisk = totalCapital * config.risk_per_trade;
  const tradeRisk   = (entryPrice > 0 && stopLossPrice > 0)
    ? Math.abs(entryPrice - stopLossPrice) / entryPrice
    : 0.03;  // SL 없으면 기본 3% 리스크

  let size = accountRisk / tradeRisk;

  // 단일 포지션 최대 비율 제한
  size = Math.min(size, totalCapital * config.max_position_pct);

  // 현금 보유 비율 고려한 가용 한도
  const usable = balance - (totalCapital * config.reserve_ratio);
  size = Math.min(size, Math.max(0, usable));

  if (size < config.min_order_usdt) {
    return {
      size:   0,
      skip:   true,
      reason: `포지션 크기 ${size.toFixed(2)} USDT < 최소 ${config.min_order_usdt} USDT`,
    };
  }

  return {
    size,
    sizeInCoin:  entryPrice > 0 ? size / entryPrice : 0,
    riskAmount:  accountRisk,
    riskPercent: config.risk_per_trade * 100,
    capitalPct:  (size / totalCapital * 100).toFixed(1),
    skip:        false,
  };
}

// ─── 자본 현황 요약 ──────────────────────────────────────────────────

export async function getCapitalStatus() {
  const [balance, openPositions, dailyPnL, weeklyPnL, dailyTradeCount, circuit] = await Promise.all([
    getAvailableBalance(),
    getOpenPositions(),
    getDailyPnL(),
    getWeeklyPnL(),
    getDailyTradeCount(),
    checkCircuitBreaker(),
  ]);
  const positionValue = openPositions.reduce((s, p) => s + (p.amount || 0) * (p.avg_price || 0), 0);
  const totalCapital  = balance + positionValue;

  return {
    totalCapital,
    availableBalance:   balance,
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

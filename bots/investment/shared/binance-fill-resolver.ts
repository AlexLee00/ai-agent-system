// @ts-nocheck
/**
 * Binance fill resolver for journal reconciliation.
 *
 * Read-only by design. It uses fetchMyTrades to infer a real exit VWAP for
 * open trade_journal rows that are already absent from local positions.
 *
 * H3: binance spot USDT-quoted pairs only. Non-USDT → unresolved.
 */

import ccxt from 'ccxt';
import { initHubSecrets, loadSecrets } from './secrets.ts';

// H2: lookback 10분 (기존 60초 → 서버 시간차로 fill이 entryTime보다 빠를 수 있음)
const DEFAULT_LOOKBACK_MS = Number(process.env.LUNA_FILL_RESOLVE_LOOKBACK_MS) > 0
  ? Number(process.env.LUNA_FILL_RESOLVE_LOOKBACK_MS)
  : 600_000;
const DEFAULT_LIMIT = 1000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol = '') {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return '';
  if (text.includes('/')) return text;
  if (text.endsWith('USDT')) return `${text.slice(0, -4)}/USDT`;
  return `${text}/USDT`;
}

function tolerance(value) {
  const n = Math.abs(num(value, 0));
  return Math.max(0.000001, n * 0.01);
}

async function getReadOnlyExchange() {
  await initHubSecrets().catch(() => false);
  const secrets = loadSecrets();
  if (!secrets.binance_api_key || !secrets.binance_api_secret) {
    throw new Error('binance_api_key_missing_after_hub_secret_init');
  }
  return new ccxt.binance({
    apiKey: secrets.binance_api_key,
    secret: secrets.binance_api_secret,
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
      warnOnFetchOpenOrdersWithoutSymbol: false,
    },
  });
}

function normalizeTrade(raw = {}) {
  const amount = num(raw.amount ?? raw.info?.qty, 0);
  const price = num(raw.price, 0);
  const cost = num(raw.cost, amount * price);
  const side = raw.side
    ? String(raw.side).toLowerCase()
    : raw.info?.isBuyer === false
      ? 'sell'
      : raw.info?.isBuyer === true
        ? 'buy'
        : '';
  return {
    id: raw.id || raw.info?.id || null,
    order: raw.order || raw.orderId || raw.info?.orderId || null,
    timestamp: num(raw.timestamp, Date.parse(raw.datetime || '') || 0),
    datetime: raw.datetime || null,
    side,
    amount,
    price,
    cost,
    fee: raw.fee || null,
  };
}

export async function resolveFillForClosedJournal({
  symbol,
  entryTime,
  entrySize,
  entryPrice,
  entryValue,
  paperMode = false,
  expectedSide = 'sell',  // H4: 호출부가 direction 기반으로 전달; 기본값 'sell' 유지
  orderIds = [],           // H1: 진입 스코프의 sl_order_id + tp_order_id 목록
  lookbackMs,              // H2: 미지정 시 DEFAULT_LOOKBACK_MS(10분)
  limit = DEFAULT_LIMIT,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const expectedQty = num(entrySize, 0);
  const expectedEntryValue = num(entryValue, expectedQty * num(entryPrice, 0));

  if (paperMode) {
    return { source: 'unresolved', reason: 'paper_mode_skip', symbol: normalizedSymbol, fillCount: 0 };
  }
  if (!normalizedSymbol || !(expectedQty > 0)) {
    return { source: 'unresolved', reason: 'invalid_symbol_or_qty', symbol: normalizedSymbol, fillCount: 0 };
  }
  // H3: binance spot은 USDT 기준; 비-USDT 쌍은 환산 없이 pnl 계산 불가
  if (!normalizedSymbol.endsWith('/USDT')) {
    return { source: 'unresolved', reason: 'non_usdt_pair_not_supported', symbol: normalizedSymbol, fillCount: 0 };
  }

  const resolvedLookbackMs = num(lookbackMs, DEFAULT_LOOKBACK_MS);
  const since = Math.max(0, num(entryTime, Date.now() - 30 * 24 * 3600_000) - resolvedLookbackMs);

  try {
    const ex = await getReadOnlyExchange();
    const rawTrades = await ex.fetchMyTrades(normalizedSymbol, since, Math.max(1, num(limit, DEFAULT_LIMIT)));
    const side = String(expectedSide || 'sell').toLowerCase();
    const candidates = (rawTrades || [])
      .map(normalizeTrade)
      .filter((t) => t.side === side && t.timestamp >= since && t.amount > 0 && t.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    // === 1차: order_id 매칭 ===
    // TP/SL 청산 fill의 order 필드는 정확히 sl_order_id 또는 tp_order_id와 일치한다.
    // 다른 진입의 청산 fill이 섞이지 않으므로 DCA 종목 오귀속 원천 차단.
    const oidSet = new Set((orderIds || []).filter(Boolean).map(String));
    if (oidSet.size > 0) {
      const matched = candidates.filter((t) => t.order && oidSet.has(String(t.order)));
      if (matched.length > 0) {
        const qty = matched.reduce((s, t) => s + t.amount, 0);
        const value = matched.reduce((s, t) => s + (t.cost || t.amount * t.price), 0);
        const exitPrice = value > 0 && qty > 0 ? value / qty : null;
        const pnlAmount = exitPrice != null ? value - expectedEntryValue : null;
        const pnlPercent = expectedEntryValue > 0 && pnlAmount != null
          ? (pnlAmount / expectedEntryValue) * 100
          : null;
        return {
          source: 'fetchMyTrades_orderid',
          matchedBy: 'order_id',
          symbol: normalizedSymbol,
          since,
          fillCount: matched.length,
          matchedQty: qty,
          expectedQty,
          partial: qty + tolerance(expectedQty) < expectedQty,
          exitPrice,
          exitValue: value,
          pnlAmount,
          pnlPercent,
          pnlNet: pnlAmount,
          firstFillAt: matched[0]?.datetime || (matched[0]?.timestamp ? new Date(matched[0].timestamp).toISOString() : null),
          lastFillAt: matched[matched.length - 1]?.datetime || (matched[matched.length - 1]?.timestamp ? new Date(matched[matched.length - 1].timestamp).toISOString() : null),
          tradeIds: matched.map((t) => t.id).filter(Boolean),
          orderIds: [...new Set(matched.map((t) => t.order).filter(Boolean))],
        };
      }
    }

    // === 2차: 보수적 fallback — 수량이 정확히 일치하는 단일 fill 한 건만 허용 ===
    // 누적 매칭은 DCA 종목에서 다른 진입 fill을 오귀속할 수 있으므로 사용하지 않는다.
    const singleMatch = candidates.find((t) => Math.abs(t.amount - expectedQty) <= tolerance(expectedQty));
    if (singleMatch) {
      const qty = singleMatch.amount;
      const value = singleMatch.cost || singleMatch.amount * singleMatch.price;
      const exitPrice = value > 0 && qty > 0 ? value / qty : null;
      const pnlAmount = exitPrice != null ? value - expectedEntryValue : null;
      const pnlPercent = expectedEntryValue > 0 && pnlAmount != null
        ? (pnlAmount / expectedEntryValue) * 100
        : null;
      return {
        source: 'fetchMyTrades',
        matchedBy: 'single_fill',
        symbol: normalizedSymbol,
        since,
        fillCount: 1,
        matchedQty: qty,
        expectedQty,
        partial: false,
        exitPrice,
        exitValue: value,
        pnlAmount,
        pnlPercent,
        pnlNet: pnlAmount,
        firstFillAt: singleMatch.datetime || (singleMatch.timestamp ? new Date(singleMatch.timestamp).toISOString() : null),
        lastFillAt: singleMatch.datetime || (singleMatch.timestamp ? new Date(singleMatch.timestamp).toISOString() : null),
        tradeIds: [singleMatch.id].filter(Boolean),
        orderIds: [singleMatch.order].filter(Boolean),
      };
    }

    // === 3차: unresolved — 부정확한 추정보다 미해결이 안전 ===
    return {
      source: 'unresolved',
      reason: candidates.length === 0 ? 'no_matching_side_fills' : 'ambiguous_no_orderid',
      symbol: normalizedSymbol,
      since,
      fillCount: 0,
      inspectedTrades: candidates.length,
    };
  } catch (error) {
    return {
      source: 'unresolved',
      reason: 'fetch_my_trades_failed',
      symbol: normalizedSymbol,
      fillCount: 0,
      error: String(error?.message || error || '').slice(0, 240),
    };
  }
}

export default {
  resolveFillForClosedJournal,
};

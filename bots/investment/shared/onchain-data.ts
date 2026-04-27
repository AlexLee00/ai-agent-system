// @ts-nocheck
/**
 * shared/onchain-data.js — 바이낸스 온체인 데이터 수집 (공유 모듈)
 *
 * oracle.ts, luna.ts 등에서 공용으로 사용하는 바이낸스 Futures 퍼블릭 API.
 * API 키 불필요 — 모두 공개 엔드포인트.
 *
 * 사용:
 *   import { getFundingRate, getOpenInterest, getLongShortRatio, getOnchainSummary } from '../shared/onchain-data.ts';
 */

import https from 'https';

const FAPI_HOST = 'fapi.binance.com';
const SAPI_HOST = 'api.binance.com';

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON 파싱 실패: ${raw.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('타임아웃')); });
    req.end();
  });
}

export async function getSpotTicker24h(symbol) {
  try {
    const data = await httpsGet(SAPI_HOST, `/api/v3/ticker/24hr?symbol=${symbol}`);
    if (!data?.symbol) return null;
    return {
      symbol: data.symbol,
      priceChangePercent: parseFloat(data.priceChangePercent || '0'),
      quoteVolume: parseFloat(data.quoteVolume || '0'),
      volume: parseFloat(data.volume || '0'),
      lastPrice: parseFloat(data.lastPrice || '0'),
      highPrice: parseFloat(data.highPrice || '0'),
      lowPrice: parseFloat(data.lowPrice || '0'),
      count: parseInt(data.count || '0', 10),
    };
  } catch (e) {
    console.warn(`[onchain] spot ticker 24h 조회 실패 (${symbol}):`, e.message);
    return null;
  }
}

export async function getSpotDepthImbalance(symbol, limit = 20) {
  try {
    const data = await httpsGet(SAPI_HOST, `/api/v3/depth?symbol=${symbol}&limit=${limit}`);
    const bids = Array.isArray(data?.bids) ? data.bids : [];
    const asks = Array.isArray(data?.asks) ? data.asks : [];
    const bidNotional = bids.reduce((sum, [price, qty]) => sum + (parseFloat(price || '0') * parseFloat(qty || '0')), 0);
    const askNotional = asks.reduce((sum, [price, qty]) => sum + (parseFloat(price || '0') * parseFloat(qty || '0')), 0);
    const total = bidNotional + askNotional;
    const imbalance = total > 0 ? (bidNotional - askNotional) / total : 0;
    return {
      bidNotional,
      askNotional,
      imbalance: Number(imbalance.toFixed(4)),
    };
  } catch (e) {
    console.warn(`[onchain] depth imbalance 조회 실패 (${symbol}):`, e.message);
    return null;
  }
}

export async function getRecentAggTradePressure(symbol, limit = 500) {
  try {
    const data = await httpsGet(SAPI_HOST, `/api/v3/aggTrades?symbol=${symbol}&limit=${limit}`);
    const rows = Array.isArray(data) ? data : [];
    let takerBuyNotional = 0;
    let takerSellNotional = 0;
    let totalNotional = 0;
    let tradeCount = 0;

    for (const row of rows) {
      const price = parseFloat(row?.p || '0');
      const qty = parseFloat(row?.q || '0');
      if (!(price > 0) || !(qty > 0)) continue;
      const notional = price * qty;
      totalNotional += notional;
      tradeCount += 1;
      // Binance aggTrade `m=true` means buyer was maker => seller taker => taker sell pressure
      if (row?.m) takerSellNotional += notional;
      else takerBuyNotional += notional;
    }

    const imbalance = totalNotional > 0
      ? (takerBuyNotional - takerSellNotional) / totalNotional
      : 0;
    const takerBuyRatio = totalNotional > 0 ? takerBuyNotional / totalNotional : 0;
    const takerSellRatio = totalNotional > 0 ? takerSellNotional / totalNotional : 0;

    return {
      tradeCount,
      totalNotional,
      takerBuyNotional,
      takerSellNotional,
      takerBuyRatio: Number(takerBuyRatio.toFixed(4)),
      takerSellRatio: Number(takerSellRatio.toFixed(4)),
      imbalance: Number(imbalance.toFixed(4)),
      signal:
        imbalance >= 0.12 ? 'taker_buy_pressure'
        : imbalance <= -0.12 ? 'taker_sell_pressure'
        : 'neutral',
    };
  } catch (e) {
    console.warn(`[onchain] agg trade pressure 조회 실패 (${symbol}):`, e.message);
    return null;
  }
}

/**
 * 현재 펀딩레이트 (premiumIndex 엔드포인트 — nextFundingTime 포함)
 * @param {string} symbol - 예: 'BTCUSDT'
 * @returns {{ symbol, fundingRate, fundingRatePct, nextFundingTime, markPrice } | null}
 */
export async function getFundingRate(symbol) {
  try {
    const data = await httpsGet(FAPI_HOST, `/fapi/v1/premiumIndex?symbol=${symbol}`);
    const fundingRate = parseFloat(data.lastFundingRate);
    const markPrice = parseFloat(data.markPrice);
    const nextFundingTimeMs = Number(data.nextFundingTime);
    const nextFundingTime = Number.isFinite(nextFundingTimeMs) && nextFundingTimeMs > 0
      ? new Date(nextFundingTimeMs).toISOString()
      : null;

    return {
      symbol:          data.symbol,
      fundingRate,
      fundingRatePct:  Number.isFinite(fundingRate) ? (fundingRate * 100).toFixed(4) : null,
      nextFundingTime,
      markPrice,
    };
  } catch (e) {
    console.warn(`[onchain] 펀딩레이트 조회 실패 (${symbol}):`, e.message);
    return null;
  }
}

/**
 * Open Interest (미결제 약정)
 * @param {string} symbol
 * @returns {{ symbol, openInterest } | null}
 */
export async function getOpenInterest(symbol) {
  try {
    const data = await httpsGet(FAPI_HOST, `/fapi/v1/openInterest?symbol=${symbol}`);
    if (!data?.openInterest) return null;
    return {
      symbol:       data.symbol,
      openInterest: parseFloat(data.openInterest),
    };
  } catch (e) {
    console.warn(`[onchain] OI 조회 실패 (${symbol}):`, e.message);
    return null;
  }
}

/**
 * 글로벌 롱/숏 비율
 * @param {string} symbol
 * @param {string} [period='1h']
 * @param {number} [limit=1]
 * @returns {{ longShortRatio, longAccount, shortAccount } | null}
 */
export async function getLongShortRatio(symbol, period = '1h', limit = 1) {
  try {
    const data = await httpsGet(
      FAPI_HOST,
      `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
    );
    const item = Array.isArray(data) ? data[0] : null;
    if (!item) return null;
    return {
      longShortRatio: parseFloat(item.longShortRatio),
      longAccount:    parseFloat(item.longAccount),
      shortAccount:   parseFloat(item.shortAccount),
    };
  } catch (e) {
    console.warn(`[onchain] 롱숏비율 실패 (${symbol}):`, e.message);
    return null;
  }
}

/**
 * 종합 온체인 요약 + 시그널 해석 (오라클·루나에서 공용)
 * @param {string} symbol - 예: 'BTCUSDT'
 * @returns {{ symbol, funding, openInterest, longShortRatio, timestamp }}
 */
export async function getOnchainSummary(symbol) {
  const [funding, oi, ls, spotTicker, depth, tradePressure] = await Promise.all([
    getFundingRate(symbol),
    getOpenInterest(symbol),
    getLongShortRatio(symbol, '1h', 1),
    getSpotTicker24h(symbol),
    getSpotDepthImbalance(symbol),
    getRecentAggTradePressure(symbol),
  ]);

  // 펀딩레이트 시그널: >0.05% = 롱 과열, <-0.01% = 숏 과열
  let fundingSignal = 'neutral';
  if (funding) {
    if (funding.fundingRate > 0.0005)       fundingSignal = 'overheated_long';
    else if (funding.fundingRate < -0.0001) fundingSignal = 'overheated_short';
  }

  // 롱숏 시그널: >1.8 = 군중 롱(역발상 숏 유리), <0.8 = 군중 숏(역발상 롱 유리)
  let lsSignal = 'neutral';
  if (ls) {
    if (ls.longShortRatio > 1.8)      lsSignal = 'crowd_long';
    else if (ls.longShortRatio < 0.8) lsSignal = 'crowd_short';
  }

  return {
    symbol,
    funding: funding ? {
      rate:     funding.fundingRate,
      ratePct:  funding.fundingRatePct,
      signal:   fundingSignal,
      nextTime: funding.nextFundingTime,
    } : null,
    openInterest: oi ? { value: oi.openInterest } : null,
    spotFlow: spotTicker ? {
      quoteVolume: spotTicker.quoteVolume,
      priceChangePercent: spotTicker.priceChangePercent,
      tradeCount: spotTicker.count,
      lastPrice: spotTicker.lastPrice,
      depthImbalance: depth?.imbalance ?? null,
      tradePressureImbalance: tradePressure?.imbalance ?? null,
      takerBuyRatio: tradePressure?.takerBuyRatio ?? null,
      takerSellRatio: tradePressure?.takerSellRatio ?? null,
      signal:
        spotTicker.priceChangePercent >= 4 && (depth?.imbalance ?? 0) > 0.08 && (tradePressure?.imbalance ?? 0) > 0.08 ? 'spot_momentum_bid' :
        spotTicker.priceChangePercent <= -4 && (depth?.imbalance ?? 0) < -0.08 && (tradePressure?.imbalance ?? 0) < -0.08 ? 'spot_pressure_ask' :
        (tradePressure?.imbalance ?? 0) >= 0.12 ? 'taker_buy_pressure' :
        (tradePressure?.imbalance ?? 0) <= -0.12 ? 'taker_sell_pressure' :
        spotTicker.quoteVolume >= 100_000_000 ? 'high_flow' :
        'neutral',
    } : null,
    longShortRatio: ls ? {
      ratio:    ls.longShortRatio,
      longPct:  (ls.longAccount * 100).toFixed(1),
      shortPct: (ls.shortAccount * 100).toFixed(1),
      signal:   lsSignal,
    } : null,
    timestamp: new Date().toISOString(),
  };
}

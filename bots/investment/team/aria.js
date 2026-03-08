/**
 * team/aria.js — 아리아 (TA MTF 기술분석가)
 *
 * 역할: 규칙 기반 멀티타임프레임 기술분석 (LLM 없음 — 순수 수학)
 * 암호화폐: 15m(15%) / 1h(35%) / 4h(30%) / 1d(20%) — Binance CCXT (변동성 기반 동적 가중치)
 * 국내주식:  1d(65%) / 1h(35%) — Yahoo Finance (.KS)
 * 미국주식:  1d(60%) / 1h(40%) — Yahoo Finance (ticker 직접)
 * 지표: RSI / MACD / 볼린저밴드 / MA정배열 / 스토캐스틱 / ATR / 거래량
 *
 * 실행: node team/aria.js --symbol=BTC/USDT
 *        node team/aria.js --symbol=005930 --exchange=kis
 *        node team/aria.js --symbol=AAPL   --exchange=kis_overseas
 */

import ccxt  from 'ccxt';
import https from 'https';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.js';
import { isKisMarketOpen, isKisOverseasMarketOpen } from '../shared/secrets.js';

// ─── 장 시간 체크 ────────────────────────────────────────────────────

/**
 * 주어진 exchange가 현재 장 시간인지 반환
 * @param {'binance'|'kis'|'kis_overseas'} exchange
 * @returns {{ open: boolean, reason: string }}
 */
export function isMarketOpen(exchange) {
  if (exchange === 'binance') return { open: true, reason: '암호화폐 24/7' };
  if (exchange === 'kis')          return isKisMarketOpen()
    ? { open: true,  reason: 'KST 09:00~15:30 장중' }
    : { open: false, reason: '국내주식 장 마감 시간 외' };
  if (exchange === 'kis_overseas') return isKisOverseasMarketOpen()
    ? { open: true,  reason: 'NYSE/NASDAQ 장중' }
    : { open: false, reason: '미국주식 장 마감 시간 외' };
  return { open: true, reason: '알 수 없는 거래소 — 분석 허용' };
}

// ─── CCXT public-only 인스턴스 (API 키 없음 — OHLCV 전용) ───────────

let _publicExchange = null;

function getPublicExchange() {
  if (_publicExchange) return _publicExchange;
  _publicExchange = new ccxt.binance({
    options: { defaultType: 'spot' },
  });
  return _publicExchange;
}

async function fetchOHLCV(symbol, timeframe, limit, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getPublicExchange().fetchOHLCV(symbol, timeframe, undefined, limit);
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ─── 시장별 파라미터 ────────────────────────────────────────────────

const MARKET_PARAMS = {
  binance: {
    rsiOversold:    30, rsiOverbought:    70,
    stochOversold:  20, stochOverbought:  80,
    signalThreshold: 1.5,
  },
  kis_overseas: {
    rsiOversold:    35, rsiOverbought:    65,
    stochOversold:  20, stochOverbought:  80,
    signalThreshold: 2.0,
  },
  kis: {
    rsiOversold:    30, rsiOverbought:    70,
    stochOversold:  20, stochOverbought:  80,
    signalThreshold: 1.5,
  },
};

// ─── 암호화폐 MTF 설정 ──────────────────────────────────────────────

const CRYPTO_TIMEFRAMES = [
  { tf: '15m', label: '15분봉', weight: 0.15 },
  { tf: '1h',  label: '1시간봉', weight: 0.35 },
  { tf: '4h',  label: '4시간봉', weight: 0.30 },
  { tf: '1d',  label: '일봉',    weight: 0.20 },
];

// ─── 변동성 기반 동적 가중치 ──────────────────────────────────────────

/**
 * ATR 비율에 따른 동적 타임프레임 가중치 계산
 * @param {number|null} atrRatio  ATR / currentPrice (예: 0.02 = 2%)
 * @returns {{ '15m': number, '1h': number, '4h': number, '1d': number }}
 */
function calculateAutoWeights(atrRatio) {
  if (atrRatio == null) {
    // 기본 가중치 (DEFAULT)
    return { '15m': 0.15, '1h': 0.35, '4h': 0.30, '1d': 0.20 };
  }
  if (atrRatio > 0.03) {
    // 고변동 — 단기 비중 높임
    return { '15m': 0.25, '1h': 0.35, '4h': 0.25, '1d': 0.15 };
  }
  if (atrRatio < 0.01) {
    // 저변동 — 장기 비중 높임
    return { '15m': 0.10, '1h': 0.25, '4h': 0.35, '1d': 0.30 };
  }
  // 중간 변동 (DEFAULT)
  return { '15m': 0.15, '1h': 0.35, '4h': 0.30, '1d': 0.20 };
}

// ─── 국내/미국주식 MTF 설정 ──────────────────────────────────────────

const KIS_TIMEFRAMES = [
  { tf: '1d', range: '6mo', label: '일봉',    weight: 0.65 },
  { tf: '1h', range: '1mo', label: '1시간봉', weight: 0.35 },
];

const KIS_OVERSEAS_TIMEFRAMES = [
  { tf: '1d', range: '6mo', label: '일봉',    weight: 0.60 },
  { tf: '1h', range: '1mo', label: '1시간봉', weight: 0.40 },
];

// ─── Yahoo Finance OHLCV (국내·미국주식) ────────────────────────────

/**
 * Yahoo Finance에서 OHLCV 데이터 수집
 * @param {string} ticker   Yahoo 심볼 (예: '005930.KS', 'AAPL')
 * @param {string} interval '1d' | '1h' | '5m'
 * @param {string} range    '1mo' | '3mo' | '6mo' | '1y'
 * @returns {Promise<Array>}  [[timestamp_ms, o, h, l, c, v], ...]
 */
function fetchYahooOHLCV(ticker, interval, range) {
  return new Promise((resolve, reject) => {
    const urlPath = `/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
    const req = https.request(
      {
        hostname: 'query1.finance.yahoo.com',
        path:     urlPath,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json  = JSON.parse(raw);
            const chart = json.chart?.result?.[0];
            if (!chart) { resolve([]); return; }
            const timestamps = chart.timestamp || [];
            const q          = chart.indicators.quote[0];
            const result     = timestamps
              .map((ts, i) => [
                ts * 1000,
                q.open[i]   || 0, q.high[i]  || 0,
                q.low[i]    || 0, q.close[i] || 0,
                q.volume[i] || 0,
              ])
              .filter(c => c[4] > 0);
            resolve(result);
          } catch (e) {
            reject(new Error(`Yahoo Finance 파싱 실패: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Yahoo Finance 타임아웃')); });
    req.end();
  });
}

/**
 * 심볼 → Yahoo 티커 변환
 * 국내주식: '005930' → '005930.KS'
 * 미국주식: 'AAPL' → 'AAPL' (변환 없음)
 */
function toYahooTicker(symbol, exchange) {
  if (exchange === 'kis' && /^\d{6}$/.test(symbol)) return `${symbol}.KS`;
  return symbol;
}

// ─── 기본 지표 계산 ────────────────────────────────────────────────

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  const gains   = changes.map(c => c > 0 ? c : 0);
  const losses  = changes.map(c => c < 0 ? -c : 0);
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const macdHistory = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const f = ema(closes.slice(0, i + 1), fast);
    const s = ema(closes.slice(0, i + 1), slow);
    macdHistory.push(f - s);
  }
  if (macdHistory.length < signal) return null;
  const macdLine   = macdHistory[macdHistory.length - 1];
  const signalLine = ema(macdHistory, signal);
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

export function calcBB(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice    = closes.slice(-period);
  const middle   = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const std      = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std, bandwidth: (2 * stdDev * std) / middle };
}

export function calcMovingAverages(closes) {
  return { ma5: sma(closes, 5), ma10: sma(closes, 10), ma20: sma(closes, 20), ma60: sma(closes, 60), ma120: sma(closes, 120) };
}

function getMaArrangement(mas) {
  const { ma5, ma10, ma20, ma60, ma120 } = mas;
  if (!ma5 || !ma10 || !ma20) return null;
  if (ma60 && ma120) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && ma60 > ma120) return 'golden';
    if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60 && ma60 < ma120) return 'dead';
  } else {
    if (ma5 > ma10 && ma10 > ma20) return 'golden';
    if (ma5 < ma10 && ma10 < ma20) return 'dead';
  }
  return 'mixed';
}

export function calcStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const h = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const l = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    kValues.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
  }
  if (kValues.length < dPeriod) return null;
  const k = kValues[kValues.length - 1];
  const d = kValues.slice(-dPeriod).reduce((a, b) => a + b) / dPeriod;
  return { k, d };
}

export function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

export function analyzeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg     = volumes.slice(-period - 1, -1).reduce((a, b) => a + b) / period;
  const current = volumes[volumes.length - 1];
  if (avg === 0) return null;
  const ratio = current / avg;
  return { current, avg, ratio, surge: ratio > 1.5 };
}

// ─── 신호 판단 ───────────────────────────────────────────────────────

export function judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol }, exchange = 'binance') {
  const p       = MARKET_PARAMS[exchange] || MARKET_PARAMS.binance;
  const factors = [];
  let score = 0;

  if (rsi !== null) {
    if (rsi < p.rsiOversold)        { score += 1.5; factors.push(`RSI ${rsi.toFixed(1)} 과매도`); }
    else if (rsi > p.rsiOverbought) { score -= 1.5; factors.push(`RSI ${rsi.toFixed(1)} 과매수`); }
    else                             { factors.push(`RSI ${rsi.toFixed(1)} 중립`); }
  }

  if (macd) {
    if (macd.histogram > 0)      { score += 1.0; factors.push(`MACD 상승 (${macd.histogram.toFixed(4)})`); }
    else if (macd.histogram < 0) { score -= 1.0; factors.push(`MACD 하락 (${macd.histogram.toFixed(4)})`); }
    else                          { factors.push('MACD 중립'); }
  }

  if (bb && currentPrice) {
    const bbRange = bb.upper - bb.lower;
    if (bbRange > 0) {
      const bbPct = (currentPrice - bb.lower) / bbRange; // 0=하단, 1=상단
      if (bbPct <= 0.05)      { score += 0.5; factors.push('BB 하단'); }
      else if (bbPct >= 0.95) { score -= 0.5; factors.push('BB 상단 근접'); }
      else                     { factors.push(`BB 중립 (${(bbPct * 100).toFixed(0)}%)`); }
    }
  }

  if (mas) {
    const arr = getMaArrangement(mas);
    if (arr === 'golden')     { score += 1.0; factors.push('이평 정배열'); }
    else if (arr === 'dead')  { score -= 1.0; factors.push('이평 역배열'); }
    else if (arr === 'mixed') { factors.push('이평 혼조'); }
  }

  if (stoch) {
    if (stoch.k < p.stochOversold && stoch.d < p.stochOversold)        { score += 0.5; factors.push(`스토캐스틱 과매도`); }
    else if (stoch.k > p.stochOverbought && stoch.d > p.stochOverbought){ score -= 0.5; factors.push(`스토캐스틱 과매수`); }
    else                                                                  { factors.push(`스토캐스틱 중립`); }
  }

  if (vol?.surge) {
    if (score > 0)      { score += 0.5; factors.push(`거래량 급등 상승 강화 (${vol.ratio.toFixed(1)}x)`); }
    else if (score < 0) { score -= 0.5; factors.push(`거래량 급등 하락 강화 (${vol.ratio.toFixed(1)}x)`); }
    else                { factors.push(`거래량 급등 방향 불명`); }
  }

  if (atr && currentPrice) {
    const atrPct = (atr / currentPrice) * 100;
    factors.push(`ATR ${atrPct.toFixed(2)}%`);
  }

  const maxScore   = 5.0;
  const confidence = Math.min(Math.abs(score) / maxScore, 1);
  const threshold  = p.signalThreshold;

  let signal;
  if (score >= threshold)       signal = ACTIONS.BUY;
  else if (score <= -threshold) signal = ACTIONS.SELL;
  else                          signal = ACTIONS.HOLD;

  return { signal, confidence, reasoning: factors.join(' | '), score, indicators: { rsi, macd, bb, mas, stoch, atr, vol } };
}

// ─── 단일 타임프레임 분석 ───────────────────────────────────────────

export async function analyzeTF(symbol, timeframe, exchange = 'binance') {
  const ohlcv = await fetchOHLCV(symbol, timeframe, 150);
  const highs   = ohlcv.map(c => c[2]);
  const lows    = ohlcv.map(c => c[3]);
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const currentPrice = closes[closes.length - 1];

  const rsi   = calcRSI(closes);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes);
  const mas   = calcMovingAverages(closes);
  const stoch = calcStochastic(highs, lows, closes);
  const atr   = calcATR(highs, lows, closes);
  const vol   = analyzeVolume(volumes);

  const result = judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol }, exchange);
  console.log(`  [아리아 ${timeframe}] ${symbol}: ${result.signal} (${(result.confidence * 100).toFixed(0)}%) | 점수: ${result.score.toFixed(2)}`);
  return { ...result, currentPrice, timeframe };
}

// ─── MTF 종합 분석 ──────────────────────────────────────────────────

/**
 * 암호화폐 멀티타임프레임 TA 분석
 * @param {string} symbol
 * @returns {Promise<{signal, confidence, reasoning, score, weightedScore, tfResults, currentPrice}>}
 */
export async function analyzeCryptoMTF(symbol) {
  console.log(`\n📊 [아리아] ${symbol} MTF 분석 (15m/1h/4h/1d)`);

  const tfResults = {};
  for (const { tf } of CRYPTO_TIMEFRAMES) {
    try {
      tfResults[tf] = await analyzeTF(symbol, tf, 'binance');
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`  ⚠️ [아리아] ${symbol} ${tf} 실패: ${e.message}`);
    }
  }

  // ATR 비율 → 동적 가중치 산출 (1h 기준, 없으면 4h 사용)
  const atrSource    = tfResults['1h'] || tfResults['4h'];
  const atrValue     = atrSource?.indicators?.atr ?? null;
  const currentPrice = tfResults['1h']?.currentPrice || tfResults['4h']?.currentPrice || tfResults['1d']?.currentPrice;
  const atrRatio     = (atrValue && currentPrice) ? atrValue / currentPrice : null;
  const weights      = calculateAutoWeights(atrRatio);

  let weightedScore = 0;
  let totalWeight   = 0;
  for (const { tf } of CRYPTO_TIMEFRAMES) {
    if (tfResults[tf]) {
      weightedScore += tfResults[tf].score * (weights[tf] || 0);
      totalWeight   += (weights[tf] || 0);
    }
  }
  if (totalWeight === 0) return null;

  const normalizedScore = weightedScore / totalWeight;
  const confidence      = Math.min(Math.abs(normalizedScore) / 5.0, 1);
  const threshold       = MARKET_PARAMS.binance.signalThreshold;

  let signal;
  if (normalizedScore >= threshold)       signal = ACTIONS.BUY;
  else if (normalizedScore <= -threshold) signal = ACTIONS.SELL;
  else                                     signal = ACTIONS.HOLD;

  const tfSummary = CRYPTO_TIMEFRAMES
    .filter(({ tf }) => tfResults[tf])
    .map(({ tf, label }) =>
      `[${label} ${((weights[tf] || 0) * 100).toFixed(0)}%] ${tfResults[tf].signal} (${(tfResults[tf].confidence * 100).toFixed(0)}%)`
    ).join(' | ');

  const reasoning = `MTF: ${tfSummary} → 가중점수 ${normalizedScore.toFixed(2)}`;
  const atrLabel  = atrRatio == null ? 'N/A' : atrRatio > 0.03 ? '고변동' : atrRatio < 0.01 ? '저변동' : '중간';
  console.log(`  → [아리아 MTF] ${signal} (${(confidence * 100).toFixed(0)}%) | ATR ${(atrRatio != null ? (atrRatio * 100).toFixed(2) : '?')}% (${atrLabel}) | ${reasoning}`);

  try {
    await db.insertAnalysis({
      symbol,
      analyst:   ANALYST_TYPES.TA_MTF,
      signal,
      confidence,
      reasoning: `[MTF] ${reasoning}`,
      metadata:  {
        weightedScore: normalizedScore,
        atrRatio,                // 네메시스 동적 TP/SL용
        weights,                 // 적용된 동적 가중치
        tfResults: Object.fromEntries(
          Object.entries(tfResults).map(([tf, r]) => [tf, { signal: r.signal, confidence: r.confidence, score: r.score }])
        ),
      },
    });
  } catch (e) {
    console.warn(`  ⚠️ [아리아] DB 저장 실패: ${e.message}`);
  }

  return { signal, confidence, reasoning, score: normalizedScore, weightedScore, tfResults, currentPrice, atrRatio };
}

// ─── 국내/미국주식 단일 타임프레임 분석 ─────────────────────────────

async function analyzeTFStock(symbol, exchange, { tf, range, label }) {
  const ticker = toYahooTicker(symbol, exchange);
  const ohlcv  = await fetchYahooOHLCV(ticker, tf, range);
  if (ohlcv.length < 30) throw new Error(`데이터 부족 (${ohlcv.length}캔들)`);

  const highs   = ohlcv.map(c => c[2]);
  const lows    = ohlcv.map(c => c[3]);
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const currentPrice = closes[closes.length - 1];

  const rsi   = calcRSI(closes);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes);
  const mas   = calcMovingAverages(closes);
  const stoch = calcStochastic(highs, lows, closes);
  const atr   = calcATR(highs, lows, closes);
  const vol   = analyzeVolume(volumes);

  const result = judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol }, exchange);
  console.log(`  [아리아 ${label}] ${symbol}: ${result.signal} (${(result.confidence * 100).toFixed(0)}%) | 점수: ${result.score.toFixed(2)}`);
  return { ...result, currentPrice, timeframe: tf };
}

// ─── 공통 주식 MTF 분석 헬퍼 ────────────────────────────────────────

async function analyzeStockMTF(symbol, exchange, timeframes, exchangeLabel) {
  console.log(`\n📊 [아리아] ${symbol} ${exchangeLabel} TA 분석 (일봉/1h)`);

  const tfResults = {};
  for (const tfCfg of timeframes) {
    try {
      tfResults[tfCfg.tf] = await analyzeTFStock(symbol, exchange, tfCfg);
      await new Promise(r => setTimeout(r, 300)); // Yahoo Finance 호출 간격
    } catch (e) {
      console.warn(`  ⚠️ [아리아] ${symbol} ${tfCfg.label} 실패: ${e.message}`);
    }
  }

  let weightedScore = 0;
  let totalWeight   = 0;
  for (const { tf, weight } of timeframes) {
    if (tfResults[tf]) {
      weightedScore += tfResults[tf].score * weight;
      totalWeight   += weight;
    }
  }
  if (totalWeight === 0) return null;

  const normalizedScore = weightedScore / totalWeight;
  const confidence      = Math.min(Math.abs(normalizedScore) / 5.0, 1);
  const threshold       = MARKET_PARAMS[exchange]?.signalThreshold ?? 1.5;

  let signal;
  if (normalizedScore >= threshold)       signal = ACTIONS.BUY;
  else if (normalizedScore <= -threshold) signal = ACTIONS.SELL;
  else                                     signal = ACTIONS.HOLD;

  const tfSummary = timeframes
    .filter(({ tf }) => tfResults[tf])
    .map(({ tf, label, weight }) =>
      `[${label} ${(weight * 100).toFixed(0)}%] ${tfResults[tf].signal} (${(tfResults[tf].confidence * 100).toFixed(0)}%)`
    ).join(' | ');

  const currentPrice = tfResults['1d']?.currentPrice || tfResults['1h']?.currentPrice;
  const reasoning    = `${exchangeLabel} MTF: ${tfSummary} → 가중점수 ${normalizedScore.toFixed(2)}`;

  console.log(`  → [아리아 ${exchange}] ${signal} (${(confidence * 100).toFixed(0)}%) | ${reasoning}`);

  try {
    await db.insertAnalysis({
      symbol,
      analyst:   ANALYST_TYPES.TA_MTF,
      signal,
      confidence,
      reasoning: `[${exchange.toUpperCase()} MTF] ${reasoning}`,
      metadata:  {
        weightedScore: normalizedScore,
        exchange,
        tfResults: Object.fromEntries(
          Object.entries(tfResults).map(([tf, r]) => [tf, { signal: r.signal, confidence: r.confidence, score: r.score }])
        ),
      },
    });
  } catch (e) {
    console.warn(`  ⚠️ [아리아] DB 저장 실패: ${e.message}`);
  }

  return { signal, confidence, reasoning, score: normalizedScore, tfResults, currentPrice };
}

/**
 * 국내주식 MTF 분석 (일봉 65% + 1시간봉 35%)
 * @param {string} symbol   6자리 종목코드 (예: '005930')
 * @param {boolean} force   장 마감 시간 외에도 강제 실행
 */
export async function analyzeKisMTF(symbol, force = false) {
  if (!force) {
    const mkt = isMarketOpen('kis');
    if (!mkt.open) {
      console.log(`  ⏰ [아리아] ${symbol} 분석 스킵 — ${mkt.reason}`);
      return null;
    }
  }
  return analyzeStockMTF(symbol, 'kis', KIS_TIMEFRAMES, '국내주식');
}

/**
 * 미국주식 MTF 분석 (일봉 60% + 1시간봉 40%)
 * @param {string} symbol   Yahoo 티커 (예: 'AAPL', 'TSLA')
 * @param {boolean} force   장 마감 시간 외에도 강제 실행
 */
export async function analyzeKisOverseasMTF(symbol, force = false) {
  if (!force) {
    const mkt = isMarketOpen('kis_overseas');
    if (!mkt.open) {
      console.log(`  ⏰ [아리아] ${symbol} 분석 스킵 — ${mkt.reason}`);
      return null;
    }
  }
  return analyzeStockMTF(symbol, 'kis_overseas', KIS_OVERSEAS_TIMEFRAMES, '미국주식');
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args     = process.argv.slice(2);
  const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  await db.initSchema();
  try {
    let r;
    if (exchange === 'kis')          r = await analyzeKisMTF(symbol);
    else if (exchange === 'kis_overseas') r = await analyzeKisOverseasMTF(symbol);
    else                              r = await analyzeCryptoMTF(symbol);
    console.log('\n결과:', JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('❌ 아리아 오류:', e.message);
    process.exit(1);
  }
}

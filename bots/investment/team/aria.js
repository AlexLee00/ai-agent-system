'use strict';

/**
 * team/aria.js — 아리아 (TA MTF 기술분석가)
 *
 * 역할: 규칙 기반 멀티타임프레임 기술분석 (LLM 없음 — 순수 수학)
 * 타임프레임: 5m(20%) / 1h(35%) / 4h(45%) — 암호화폐 전용
 * 지표: RSI / MACD / 볼린저밴드 / MA정배열 / 스토캐스틱 / ATR / 거래량
 *
 * bots/invest/src/analysts/ta-analyst.js v2 로직 재사용
 *
 * 실행: node team/aria.js --symbol=BTC/USDT
 */

const db      = require('../shared/db');
const { ANALYST_TYPES, ACTIONS } = require('../shared/signal');

// ─── CCXT public-only 인스턴스 (API 키 없음 — OHLCV 전용) ───────────
// API 키가 있는 CCXT는 loadMarkets 시 private 엔드포인트 호출 → 타임아웃 발생
// OHLCV는 public 엔드포인트만 필요하므로 키 없는 인스턴스를 별도 생성

let _publicExchange = null;

function getPublicExchange() {
  if (_publicExchange) return _publicExchange;
  const ccxt = require('ccxt');
  _publicExchange = new ccxt.binance({
    options: { defaultType: 'spot' },
  });
  return _publicExchange;
}

async function fetchOHLCV(symbol, timeframe, limit) {
  return getPublicExchange().fetchOHLCV(symbol, timeframe, undefined, limit);
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
  { tf: '4h', label: '4시간봉', weight: 0.45 },
  { tf: '1h', label: '1시간봉', weight: 0.35 },
  { tf: '5m', label: '5분봉',   weight: 0.20 },
];

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

function calcRSI(closes, period = 14) {
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

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
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

function calcBB(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice    = closes.slice(-period);
  const middle   = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const std      = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std, bandwidth: (2 * stdDev * std) / middle };
}

function calcMovingAverages(closes) {
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

function calcStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
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

function calcATR(highs, lows, closes, period = 14) {
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

function analyzeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg     = volumes.slice(-period - 1, -1).reduce((a, b) => a + b) / period;
  const current = volumes[volumes.length - 1];
  if (avg === 0) return null;
  const ratio = current / avg;
  return { current, avg, ratio, surge: ratio > 1.5 };
}

// ─── 신호 판단 ───────────────────────────────────────────────────────

function judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol }, exchange = 'binance') {
  const p       = MARKET_PARAMS[exchange] || MARKET_PARAMS.binance;
  const factors = [];
  let score = 0;

  if (rsi !== null) {
    if (rsi < p.rsiOversold)       { score += 1.5; factors.push(`RSI ${rsi.toFixed(1)} 과매도`); }
    else if (rsi > p.rsiOverbought){ score -= 1.5; factors.push(`RSI ${rsi.toFixed(1)} 과매수`); }
    else                            { factors.push(`RSI ${rsi.toFixed(1)} 중립`); }
  }

  if (macd) {
    if (macd.histogram > 0)      { score += 1.0; factors.push(`MACD 상승 (${macd.histogram.toFixed(4)})`); }
    else if (macd.histogram < 0) { score -= 1.0; factors.push(`MACD 하락 (${macd.histogram.toFixed(4)})`); }
    else                          { factors.push('MACD 중립'); }
  }

  if (bb && currentPrice) {
    if (currentPrice <= bb.lower)      { score += 0.5; factors.push('BB 하단'); }
    else if (currentPrice >= bb.upper) { score -= 0.5; factors.push('BB 상단'); }
    else                                { factors.push(`BB 중립`); }
  }

  if (mas) {
    const arr = getMaArrangement(mas);
    if (arr === 'golden')      { score += 1.0; factors.push('이평 정배열'); }
    else if (arr === 'dead')   { score -= 1.0; factors.push('이평 역배열'); }
    else if (arr === 'mixed')  { factors.push('이평 혼조'); }
  }

  if (stoch) {
    if (stoch.k < p.stochOversold && stoch.d < p.stochOversold)       { score += 0.5; factors.push(`스토캐스틱 과매도`); }
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

async function analyzeTF(symbol, timeframe, exchange = 'binance') {
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
async function analyzeCryptoMTF(symbol) {
  console.log(`\n📊 [아리아] ${symbol} MTF 분석 (5m/1h/4h)`);

  const tfResults = {};
  for (const { tf } of CRYPTO_TIMEFRAMES) {
    try {
      tfResults[tf] = await analyzeTF(symbol, tf, 'binance');
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`  ⚠️ [아리아] ${symbol} ${tf} 실패: ${e.message}`);
    }
  }

  // 가중치 합산
  let weightedScore = 0;
  let totalWeight   = 0;
  for (const { tf, weight } of CRYPTO_TIMEFRAMES) {
    if (tfResults[tf]) {
      weightedScore += tfResults[tf].score * weight;
      totalWeight   += weight;
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
    .map(({ tf, label, weight }) =>
      `[${label} ${(weight * 100).toFixed(0)}%] ${tfResults[tf].signal} (${(tfResults[tf].confidence * 100).toFixed(0)}%)`
    ).join(' | ');

  const currentPrice = tfResults['1h']?.currentPrice || tfResults['4h']?.currentPrice;
  const reasoning    = `MTF: ${tfSummary} → 가중점수 ${normalizedScore.toFixed(2)}`;

  console.log(`  → [아리아 MTF] ${signal} (${(confidence * 100).toFixed(0)}%) | ${reasoning}`);

  // DB 저장
  try {
    await db.insertAnalysis({
      symbol,
      analyst:   ANALYST_TYPES.TA_MTF,
      signal,
      confidence,
      reasoning: `[MTF] ${reasoning}`,
      metadata:  {
        weightedScore:  normalizedScore,
        tfResults:      Object.fromEntries(
          Object.entries(tfResults).map(([tf, r]) => [tf, { signal: r.signal, confidence: r.confidence, score: r.score }])
        ),
      },
    });
  } catch (e) {
    console.warn(`  ⚠️ [아리아] DB 저장 실패: ${e.message}`);
  }

  return { signal, confidence, reasoning, score: normalizedScore, weightedScore, tfResults, currentPrice };
}

// CLI 실행
if (require.main === module) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  db.initSchema()
    .then(() => analyzeCryptoMTF(symbol))
    .then(r => { console.log('\n결과:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('❌ 아리아 오류:', e.message); process.exit(1); });
}

module.exports = {
  analyzeCryptoMTF, analyzeTF,
  judgeSignal, calcRSI, calcMACD, calcBB, calcMovingAverages, calcStochastic, calcATR, analyzeVolume,
};

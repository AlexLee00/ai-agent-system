'use strict';

/**
 * src/analysts/ta-analyst.js — 기술분석가 v2
 *
 * 지표: RSI / MACD / 볼린저밴드 / 이평정배열(MA5/10/20/60/120) / 스토캐스틱 / ATR / 거래량
 * CCXT OHLCV 기반 (외부 라이브러리 없음)
 *
 * 실행: node src/analysts/ta-analyst.js [--symbol=BTC/USDT] [--timeframe=1h]
 */

const { fetchOHLCV } = require('../../lib/binance');
const { insertAnalysis } = require('../../lib/db');
const { ANALYST_TYPES, ACTIONS } = require('../../lib/signal');

// ─── 기본 지표 계산 ────────────────────────────────────────────────

/** 단순이동평균 */
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** 지수이동평균 */
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

/**
 * RSI (기본 14)
 * @param {number[]} closes
 * @returns {number|null} 0~100
 */
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

/**
 * MACD (12, 26, 9)
 * @param {number[]} closes
 * @returns {{ macd, signal, histogram }|null}
 */
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

/**
 * 볼린저 밴드 (20, 2)
 * @param {number[]} closes
 * @returns {{ upper, middle, lower, bandwidth }|null}
 */
function calcBB(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice    = closes.slice(-period);
  const middle   = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const std      = Math.sqrt(variance);
  const upper    = middle + stdDev * std;
  const lower    = middle - stdDev * std;
  return { upper, middle, lower, bandwidth: (upper - lower) / middle };
}

/**
 * 이동평균선 (MA5 / MA10 / MA20 / MA60 / MA120)
 * @param {number[]} closes
 * @returns {{ ma5, ma10, ma20, ma60, ma120 }}
 */
function calcMovingAverages(closes) {
  return {
    ma5:   sma(closes, 5),
    ma10:  sma(closes, 10),
    ma20:  sma(closes, 20),
    ma60:  sma(closes, 60),
    ma120: sma(closes, 120),
  };
}

/**
 * 이평 정배열/역배열 판단
 * @returns {'golden'|'dead'|'mixed'|null}
 */
function getMaArrangement(mas) {
  const { ma5, ma10, ma20, ma60, ma120 } = mas;
  if (!ma5 || !ma10 || !ma20) return null;

  // 단기 3개 정배열 (60, 120 없으면 3개만 체크)
  const hasLong = ma60 && ma120;
  if (hasLong) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && ma60 > ma120) return 'golden';
    if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60 && ma60 < ma120) return 'dead';
  } else {
    if (ma5 > ma10 && ma10 > ma20) return 'golden';
    if (ma5 < ma10 && ma10 < ma20) return 'dead';
  }
  return 'mixed';
}

/**
 * 스토캐스틱 %K / %D (기본 K=14, D=3)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @returns {{ k, d }|null}
 */
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

/**
 * ATR — 평균진실범위 (기본 14)
 * 변동성 지표: 포지션 크기 조절에 활용
 * @returns {number|null}
 */
function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

/**
 * 거래량 분석 — 현재 거래량 vs 20봉 평균
 * @returns {{ current, avg, ratio, surge }|null}
 */
function analyzeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg     = volumes.slice(-period - 1, -1).reduce((a, b) => a + b) / period;
  const current = volumes[volumes.length - 1];
  if (avg === 0) return null;
  const ratio = current / avg;
  return { current, avg, ratio, surge: ratio > 1.5 };
}

// ─── 신호 판단 ──────────────────────────────────────────────────────

/**
 * 기술지표 종합 신호 판단 (v2 — 지표 6종)
 *
 * 점수 구성 (BUY 양수):
 *   RSI          ±1.5
 *   MACD         ±1.0
 *   볼린저밴드    ±0.5
 *   이평정배열    ±1.0
 *   스토캐스틱    ±0.5
 *   거래량        ±0.5 (방향 강화)
 *   최대 합계     ±5.0
 *
 * @param {object} indicators 계산된 지표 모음
 * @returns {{ signal, confidence, reasoning, indicators }}
 */
function judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol }) {
  const factors = [];
  let score = 0;

  // 1. RSI
  if (rsi !== null) {
    if (rsi < 30) {
      score += 1.5;
      factors.push(`RSI ${rsi.toFixed(1)} 과매도`);
    } else if (rsi > 70) {
      score -= 1.5;
      factors.push(`RSI ${rsi.toFixed(1)} 과매수`);
    } else {
      factors.push(`RSI ${rsi.toFixed(1)} 중립`);
    }
  }

  // 2. MACD
  if (macd) {
    if (macd.histogram > 0) {
      score += 1.0;
      factors.push(`MACD 상승전환 (히스토그램 ${macd.histogram.toFixed(4)})`);
    } else if (macd.histogram < 0) {
      score -= 1.0;
      factors.push(`MACD 하락전환 (히스토그램 ${macd.histogram.toFixed(4)})`);
    } else {
      factors.push('MACD 중립');
    }
  }

  // 3. 볼린저 밴드
  if (bb && currentPrice) {
    if (currentPrice <= bb.lower) {
      score += 0.5;
      factors.push(`BB 하단 터치`);
    } else if (currentPrice >= bb.upper) {
      score -= 0.5;
      factors.push(`BB 상단 터치`);
    } else {
      factors.push(`BB 중립 (폭 ${(bb.bandwidth * 100).toFixed(1)}%)`);
    }
  }

  // 4. 이평정배열
  if (mas) {
    const arrangement = getMaArrangement(mas);
    if (arrangement === 'golden') {
      score += 1.0;
      factors.push(`이평 정배열 (MA5>${mas.ma5?.toFixed(0)} > MA20>${mas.ma20?.toFixed(0)})`);
    } else if (arrangement === 'dead') {
      score -= 1.0;
      factors.push(`이평 역배열 (MA5<${mas.ma5?.toFixed(0)} < MA20<${mas.ma20?.toFixed(0)})`);
    } else if (arrangement === 'mixed') {
      factors.push('이평 혼조');
    }
  }

  // 5. 스토캐스틱
  if (stoch) {
    if (stoch.k < 20 && stoch.d < 20) {
      score += 0.5;
      factors.push(`스토캐스틱 과매도 (K:${stoch.k.toFixed(1)} D:${stoch.d.toFixed(1)})`);
    } else if (stoch.k > 80 && stoch.d > 80) {
      score -= 0.5;
      factors.push(`스토캐스틱 과매수 (K:${stoch.k.toFixed(1)} D:${stoch.d.toFixed(1)})`);
    } else {
      factors.push(`스토캐스틱 중립 (K:${stoch.k.toFixed(1)})`);
    }
  }

  // 6. 거래량 (방향 강화)
  if (vol?.surge) {
    if (score > 0)      { score += 0.5; factors.push(`거래량 급등 상승 강화 (${vol.ratio.toFixed(1)}x)`); }
    else if (score < 0) { score -= 0.5; factors.push(`거래량 급등 하락 강화 (${vol.ratio.toFixed(1)}x)`); }
    else                { factors.push(`거래량 급등 방향 불명 (${vol.ratio.toFixed(1)}x)`); }
  } else if (vol) {
    factors.push(`거래량 평균 (${vol.ratio.toFixed(2)}x)`);
  }

  // ATR 로그 (점수에 영향 없음 — 포지션 크기 조절용)
  if (atr && currentPrice) {
    const atrPct = (atr / currentPrice) * 100;
    factors.push(`ATR ${atrPct.toFixed(2)}% (변동성)`);
  }

  // 신호 결정
  const maxScore  = 5.0;
  const absScore  = Math.abs(score);
  const confidence = Math.min(absScore / maxScore, 1);

  let signal;
  if (score >= 1.5)      signal = ACTIONS.BUY;
  else if (score <= -1.5) signal = ACTIONS.SELL;
  else                    signal = ACTIONS.HOLD;

  return {
    signal,
    confidence,
    reasoning: factors.join(' | '),
    score,
    indicators: { rsi, macd, bb, mas, stoch, atr, vol },
  };
}

// ─── 메인 실행 ──────────────────────────────────────────────────────

/**
 * 심볼 기술분석 실행 + DB 저장
 * @param {string} symbol    ex) 'BTC/USDT'
 * @param {string} timeframe ex) '1h', '4h', '1d'
 */
async function analyzeSymbol(symbol = 'BTC/USDT', timeframe = '1h') {
  console.log(`\n📊 [TA v2] ${symbol} 분석 시작 (${timeframe})`);

  // OHLCV 조회 (MA120 계산을 위해 최소 150개)
  const ohlcv   = await fetchOHLCV(symbol, timeframe, 150);
  const highs   = ohlcv.map(c => c[2]);
  const lows    = ohlcv.map(c => c[3]);
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const currentPrice = closes[closes.length - 1];

  // 지표 계산
  const rsi   = calcRSI(closes);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes);
  const mas   = calcMovingAverages(closes);
  const stoch = calcStochastic(highs, lows, closes);
  const atr   = calcATR(highs, lows, closes);
  const vol   = analyzeVolume(volumes);

  const { signal, confidence, reasoning, score, indicators } =
    judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol });

  // 로그 출력
  console.log(`  현재가: $${currentPrice?.toLocaleString()}`);
  console.log(`  RSI: ${rsi?.toFixed(1)} | MACD: ${macd?.histogram?.toFixed(4)} | BB폭: ${(bb?.bandwidth * 100)?.toFixed(1)}%`);
  console.log(`  MA5: ${mas.ma5?.toFixed(0)} | MA20: ${mas.ma20?.toFixed(0)} | MA60: ${mas.ma60?.toFixed(0)} | MA120: ${mas.ma120?.toFixed(0)}`);
  console.log(`  스토캐스틱 K: ${stoch?.k?.toFixed(1)} D: ${stoch?.d?.toFixed(1)} | ATR: ${atr?.toFixed(2)} | 거래량: ${vol?.ratio?.toFixed(2)}x`);
  console.log(`  → 점수: ${score.toFixed(2)} | 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%)`);
  console.log(`  근거: ${reasoning}`);

  // DB 저장
  try {
    await insertAnalysis({
      symbol,
      analyst:   ANALYST_TYPES.TA,
      signal,
      confidence,
      reasoning: `[${timeframe}] ${reasoning}`,
      metadata:  {
        timeframe,
        score,
        indicators: {
          rsi,
          macd:     macd?.histogram,
          bbWidth:  bb?.bandwidth,
          ma5:      mas.ma5,
          ma20:     mas.ma20,
          ma60:     mas.ma60,
          ma120:    mas.ma120,
          stochK:   stoch?.k,
          stochD:   stoch?.d,
          atr,
          volRatio: vol?.ratio,
        },
      },
    });
    console.log(`  ✅ DB 저장 완료 (${timeframe})`);
  } catch (e) {
    console.warn(`  ⚠️ DB 저장 실패: ${e.message}`);
  }

  return { symbol, timeframe, signal, confidence, reasoning, score, currentPrice, indicators };
}

// CLI 실행
if (require.main === module) {
  const args      = process.argv.slice(2);
  const symbol    = args.find(a => a.startsWith('--symbol='))?.split('=')[1]    || 'BTC/USDT';
  const timeframe = args.find(a => a.startsWith('--timeframe='))?.split('=')[1] || '1h';

  analyzeSymbol(symbol, timeframe)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ TA 분석 실패:', e.message); process.exit(1); });
}

module.exports = { analyzeSymbol, calcRSI, calcMACD, calcBB, calcMovingAverages, calcStochastic, calcATR, analyzeVolume, judgeSignal };

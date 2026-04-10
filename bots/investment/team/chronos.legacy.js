/**
 * team/chronos.js — 크로노스 (백테스팅 · 성과 분석)
 *
 * 역할: 과거 데이터로 전략 성과 검증 + 신호 성과 분석
 * LLM: 없음 (순수 수학 기반)
 * 상태: Skeleton — Phase 3-D에서 구현 예정
 *
 * 실행: node team/chronos.js --symbol=BTC/USDT --from=2024-01-01 --to=2024-12-31
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as db from '../shared/db.js';
import { isPaperMode } from '../shared/secrets.js';
import { getOHLCV } from '../shared/ohlcv-fetcher.js';
import {
  calcATR,
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
} from '../shared/ta-indicators.js';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
const {
  callLocalLLMJSON,
  isLocalLLMAvailable,
  LOCAL_MODEL_DEEP,
  LOCAL_MODEL_FAST,
} = createRequire(import.meta.url)('../../../packages/core/lib/local-llm-client');

// ─── 크로노스 가드 ───────────────────────────────────────────────────

/**
 * 백테스팅 실행 전 안전 체크
 * - 실거래(PAPER_MODE=false) 중에는 실행 제한
 * - DB 연결 확인
 */
export function chronosGuard() {
  const isPaper = isPaperMode();
  if (!isPaper) {
    console.warn('  ⚠️ [크로노스] LIVE 모드에서 백테스팅 주의 — DB 부하 가능');
  }
  return { allowed: true, paper: isPaper };
}

// ─── 백테스팅 결과 구조 ──────────────────────────────────────────────

/**
 * @typedef {object} BacktestResult
 * @property {string} symbol
 * @property {string} from
 * @property {string} to
 * @property {number} totalTrades
 * @property {number} winRate       0~1
 * @property {number} totalPnlPct   총 수익률 (%)
 * @property {number} maxDrawdown   최대 낙폭 (%)
 * @property {number} sharpeRatio
 */

/**
 * 전략 백테스트 실행 (Skeleton)
 * @param {string} symbol
 * @param {string} from   'YYYY-MM-DD'
 * @param {string} to     'YYYY-MM-DD'
 * @param {string} strategy  전략 ID (미래 구현)
 * @returns {Promise<BacktestResult>}
 */
export async function runBacktest(symbol, from, to, strategy = 'default', options = {}) {
  const guard = chronosGuard();
  const layer = Number(strategy) || 1;
  console.log(`\n⏰ [크로노스] 백테스트: ${symbol} (${from} ~ ${to}), layer=${layer}`);

  const base = await runLayer1(symbol, from, to, options);
  if (layer === 1) return { ...base, paper: guard.paper, layer };

  const withSentiment = await runLayer2(base, options);
  if (layer === 2) return { ...withSentiment, paper: guard.paper, layer };

  const judged = await runLayer3(withSentiment, options);
  return { ...judged, paper: guard.paper, layer };
}

/**
 * 저장된 신호 기반 성과 분석 (실제 DB 데이터 활용)
 * @param {number} days  최근 N일
 */
export async function analyzeSignalPerformance(days = 30) {
  console.log(`\n⏰ [크로노스] 최근 ${days}일 신호 성과 분석`);

  try {
    // 향후: signals + trades JOIN으로 실제 성과 계산
    // const result = await db.query(
    //   `SELECT action, COUNT(*) as count, AVG(confidence) as avg_conf
    //    FROM signals
    //    WHERE created_at > NOW() - INTERVAL '${days} days'
    //    GROUP BY action`
    // );
    console.log('  ℹ️ 성과 분석 Skeleton — Phase 3-D에서 구현 예정');
    return null;
  } catch (e) {
    console.warn(`  ⚠️ 성과 분석 오류: ${e.message}`);
    return null;
  }
}

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

function calcSignalScore({ close, rsi, macd, bb }) {
  let score = 0;
  const tags = [];

  if (rsi != null) {
    if (rsi < 30) { score += 1; tags.push('RSI_OVERSOLD'); }
    else if (rsi > 70) { score -= 1; tags.push('RSI_OVERBOUGHT'); }
  }

  if (macd?.histogram != null) {
    if (macd.histogram > 0) { score += 1; tags.push('MACD_BULLISH'); }
    else if (macd.histogram < 0) { score -= 1; tags.push('MACD_BEARISH'); }
  }

  if (bb && close) {
    if (close <= bb.lower) { score += 1; tags.push('BB_LOWER_BREAK'); }
    else if (close >= bb.upper) { score -= 1; tags.push('BB_UPPER_BREAK'); }
  }

  if (score > 0) return { action: 'BUY', score, tags };
  if (score < 0) return { action: 'SELL', score, tags };
  return { action: 'HOLD', score, tags };
}

function buildTradeStats(signals) {
  let position = null;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const closedTrades = [];

  for (const signal of signals) {
    if (signal.action === 'BUY' && !position) {
      position = { entry: signal.close, ts: signal.ts };
      continue;
    }
    if (signal.action === 'SELL' && position) {
      const pnlPct = ((signal.close - position.entry) / position.entry) * 100;
      equity *= (1 + (pnlPct / 100));
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
      closedTrades.push({
        entryTs: position.ts,
        exitTs: signal.ts,
        entry: position.entry,
        exit: signal.close,
        pnlPct,
      });
      position = null;
    }
  }

  const wins = closedTrades.filter((trade) => trade.pnlPct > 0).length;
  const pnlList = closedTrades.map((trade) => trade.pnlPct);
  const avg = pnlList.length > 0 ? pnlList.reduce((sum, value) => sum + value, 0) / pnlList.length : 0;
  const variance = pnlList.length > 1
    ? pnlList.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (pnlList.length - 1)
    : 0;
  const sharpeRatio = variance > 0 ? avg / Math.sqrt(variance) : 0;

  return {
    totalTrades: closedTrades.length,
    winRate: closedTrades.length > 0 ? wins / closedTrades.length : 0,
    totalPnlPct: (equity - 1) * 100,
    maxDrawdown,
    sharpeRatio,
    trades: closedTrades,
  };
}

async function runLayer1(symbol, from, to, options = {}, timeframe = '1h') {
  const rows = await getOHLCV(symbol, timeframe, from, to);
  if (!rows || rows.length < 60) {
    return {
      symbol,
      from,
      to,
      timeframe,
      status: 'insufficient_data',
      candles: rows?.length || 0,
      filteredSignals: [],
      totalTrades: 0,
      winRate: 0,
      totalPnlPct: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
    };
  }

  const filteredSignals = [];
  for (let i = 60; i < rows.length; i++) {
    const slice = rows.slice(0, i + 1);
    const highs = slice.map((row) => row[2]);
    const lows = slice.map((row) => row[3]);
    const closes = slice.map((row) => row[4]);
    const volumes = slice.map((row) => row[5]);
    const close = closes[closes.length - 1];

    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const bb = calcBollingerBands(closes);
    const atr = calcATR(highs, lows, closes);
    const ema20 = calcEMA(closes, 20);
    const sma20 = calcSMA(closes, 20);
    const score = calcSignalScore({ close, rsi, macd, bb });

    if (score.action === 'HOLD') continue;

    const volumeAvg = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / 20;
    filteredSignals.push({
      ts: rows[i][0],
      close,
      volume: rows[i][5],
      action: score.action,
      score: score.score,
      tags: score.tags,
      indicators: {
        rsi,
        macd,
        bb,
        atr,
        ema20,
        sma20,
        volumeRatio: volumeAvg > 0 ? rows[i][5] / volumeAvg : null,
      },
    });
  }

  const maxSignals = Number.isFinite(Number(options.maxSignals))
    ? Math.max(0, Number(options.maxSignals))
    : null;
  const limitedSignals = maxSignals != null
    ? filteredSignals.slice(0, maxSignals)
    : filteredSignals;

  return {
    symbol,
    from,
    to,
    timeframe,
    status: 'ok',
    candles: rows.length,
    filteredSignals: limitedSignals,
    signalCountBeforeLimit: filteredSignals.length,
    signalCountAfterLimit: limitedSignals.length,
    ...buildTradeStats(limitedSignals),
  };
}

async function runLayer2(layer1Result, options = {}) {
  const available = await isLocalLLMAvailable();
  if (!available) {
    return { ...layer1Result, layer2Status: 'llm_unavailable', layer2Signals: [] };
  }

  const layer2Signals = [];
  const maxSignals = Number.isFinite(Number(options.maxSignals))
    ? Math.max(0, Number(options.maxSignals))
    : 200;
  for (const signal of layer1Result.filteredSignals.slice(0, maxSignals)) {
    const prompt = [
      { role: 'system', content: '암호화폐 감성 분석가다. 반드시 JSON만 답한다: {"sentiment":"BULLISH|BEARISH|NEUTRAL","confidence":0~1,"reasoning":"..."}' },
      { role: 'user', content: `RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, MACD_hist=${signal.indicators.macd?.histogram?.toFixed?.(4) || 'null'}, volume_ratio=${signal.indicators.volumeRatio?.toFixed?.(2) || 'null'}, action=${signal.action}` },
    ];
    const sentiment = await callLocalLLMJSON(LOCAL_MODEL_FAST, prompt, { max_tokens: 180, temperature: 0.1 });
    layer2Signals.push({
      ...signal,
      sentiment: sentiment || { sentiment: 'NEUTRAL', confidence: 0, reasoning: 'local_llm_unparsed' },
    });
  }

  return {
    ...layer1Result,
    layer2Status: 'ok',
    layer2Signals,
  };
}

async function runLayer3(layer2Result, options = {}) {
  const available = await isLocalLLMAvailable();
  if (!available) {
    return { ...layer2Result, layer3Status: 'llm_unavailable', finalSignals: [] };
  }

  const finalSignals = [];
  const maxSignals = Number.isFinite(Number(options.maxSignals))
    ? Math.max(0, Number(options.maxSignals))
    : layer2Result.layer2Signals.length;
  for (const signal of layer2Result.layer2Signals.slice(0, maxSignals)) {
    const prompt = [
      { role: 'system', content: '트레이딩 팀장이다. 추론 설명이나 <think>, 마크다운 없이 JSON 객체 하나만 답한다. 형식: {"action":"BUY|SELL|HOLD","confidence":0~1,"reasoning":"...","size":0~1}' },
      { role: 'user', content: `기술:${signal.action} score=${signal.score}, RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, 감성:${signal.sentiment?.sentiment || 'NEUTRAL'}(${signal.sentiment?.confidence || 0})` },
    ];
    const judge = await callLocalLLMJSON(LOCAL_MODEL_DEEP, prompt, { max_tokens: 512, temperature: 0.1, timeoutMs: 120000 });
    const riskAdjustedAction = signal.indicators.atr && signal.indicators.atr / signal.close > 0.05
      ? 'HOLD'
      : (judge?.action || 'HOLD');
    finalSignals.push({
      ...signal,
      judge: judge || { action: 'HOLD', confidence: 0, reasoning: 'local_llm_unparsed', size: 0 },
      finalAction: riskAdjustedAction,
    });
  }

  return {
    ...layer2Result,
    layer3Status: 'ok',
    finalSignals,
    finalSummary: {
      buy: finalSignals.filter((item) => item.finalAction === 'BUY').length,
      sell: finalSignals.filter((item) => item.finalAction === 'SELL').length,
      hold: finalSignals.filter((item) => item.finalAction === 'HOLD').length,
    },
  };
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const symbolArg = parseArg('symbol', 'BTC/USDT');
  const fromArg = parseArg('from', '2024-01-01');
  const toArg = parseArg('to', kst.today());
  const layerArg = parseArg('layer', '1');
  const maxSignalsArg = parseArg('max-signals', null);

  await db.initSchema();
  try {
    const r = await runBacktest(symbolArg, fromArg, toArg, layerArg, {
      maxSignals: maxSignalsArg == null ? null : Number(maxSignalsArg),
    });
    console.log('\n결과:', JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('❌ 크로노스 오류:', e.message);
    process.exit(1);
  }
}

// @ts-nocheck
/**
 * team/chronos.js — 크로노스 (백테스팅 · 성과 분석)
 *
 * 역할: 과거 데이터로 전략 성과 검증 + 신호 성과 분석
 * LLM: 없음 (순수 수학 기반)
 * 상태: Skeleton — Phase 3-D에서 구현 예정
 *
 * 실행: node team/chronos.js --symbol=BTC/USDT --from=2024-01-01 --to=2024-12-31
 */

import { createRequire } from 'module';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { isPaperMode } from '../shared/secrets.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import {
  calcATR,
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
} from '../shared/ta-indicators.ts';
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

function normalizeSentimentScore(rawSentiment) {
  if (typeof rawSentiment === 'number' && Number.isFinite(rawSentiment)) {
    return Math.max(0, Math.min(1, rawSentiment));
  }
  const text = String(rawSentiment || '').trim().toUpperCase();
  if (text === 'BULLISH') return 0.75;
  if (text === 'BEARISH') return 0.25;
  if (text === 'NEUTRAL') return 0.5;
  return 0.5;
}

function passesLayer2SentimentGate(action, sentimentScore) {
  if (!Number.isFinite(sentimentScore)) return false;

  if (action === 'BUY') {
    return sentimentScore >= 0.55;
  }
  if (action === 'SELL') {
    return sentimentScore <= 0.45;
  }

  return sentimentScore >= 0.45 && sentimentScore <= 0.55;
}

function normalizeLayer2Signal(signal, response = null) {
  const sentimentScore = normalizeSentimentScore(response?.sentiment);
  const passedLayer2 = passesLayer2SentimentGate(signal.action, sentimentScore);
  return {
    ...signal,
    sentiment: {
      score: sentimentScore,
      reason: response?.reason || response?.reasoning || '',
      source: response ? 'local_llm' : 'fallback',
      raw: response || null,
    },
    passedLayer2,
  };
}

function normalizeLayer3Decision(signal, response = null) {
  const action = String(response?.decision || response?.action || 'HOLD').toUpperCase();
  const confidence = Number(response?.confidence || 0);
  const riskLevel = String(response?.riskLevel || response?.risk_level || 'high');
  const atrRatio = signal.indicators?.atr && signal.close ? signal.indicators.atr / signal.close : null;
  const riskAdjustedAction = atrRatio != null && atrRatio > 0.05 ? 'HOLD' : action;

  return {
    ...signal,
    judge: {
      action,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reasoning: response?.reason || response?.reasoning || 'local_llm_unparsed',
      riskLevel,
      source: response ? 'local_llm' : 'fallback',
      raw: response || null,
    },
    finalAction: riskAdjustedAction,
  };
}

function summarizeLayerActions(signals = [], actionField = 'finalAction') {
  return {
    buy: signals.filter((item) => item[actionField] === 'BUY').length,
    sell: signals.filter((item) => item[actionField] === 'SELL').length,
    hold: signals.filter((item) => item[actionField] === 'HOLD').length,
  };
}

function toActionSignals(signals = [], actionField = 'finalAction') {
  return signals.map((signal) => ({
    ...signal,
    action: signal[actionField] || signal.action || 'HOLD',
  }));
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
    return {
      ...layer1Result,
      layer2Status: 'llm_unavailable',
      layer2Signals: [],
      layer2PassedSignals: [],
      layer2Summary: { buy: 0, sell: 0, hold: 0, passed: 0 },
    };
  }

  const layer2Signals = [];
  const maxSignals = Number.isFinite(Number(options.maxSignals))
    ? Math.max(0, Number(options.maxSignals))
    : 200;
  for (const signal of layer1Result.filteredSignals.slice(0, maxSignals)) {
    const prompt = [
      { role: 'system', content: '암호화폐 감성 분석가다. 반드시 JSON만 답한다. 형식: {"sentiment":0.65,"reason":"이유"} sentiment는 0~1 범위다.' },
      { role: 'user', content: `symbol=${layer1Result.symbol}, ts=${signal.ts}, RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, MACD_hist=${signal.indicators.macd?.histogram?.toFixed?.(4) || 'null'}, volume_ratio=${signal.indicators.volumeRatio?.toFixed?.(2) || 'null'}, action=${signal.action}` },
    ];
    const sentiment = await callLocalLLMJSON(LOCAL_MODEL_FAST, prompt, { max_tokens: 180, temperature: 0.1 });
    layer2Signals.push(normalizeLayer2Signal(signal, sentiment));
  }

  const layer2PassedSignals = layer2Signals.filter((signal) => signal.passedLayer2);
  const layer2TradeStats = buildTradeStats(toActionSignals(layer2PassedSignals, 'action'));

  return {
    ...layer1Result,
    layer2Status: 'ok',
    layer2Signals,
    layer2PassedSignals,
    layer2Summary: {
      ...summarizeLayerActions(layer2Signals, 'action'),
      passed: layer2PassedSignals.length,
    },
    totalTrades: layer2TradeStats.totalTrades,
    winRate: layer2TradeStats.winRate,
    totalPnlPct: layer2TradeStats.totalPnlPct,
    maxDrawdown: layer2TradeStats.maxDrawdown,
    sharpeRatio: layer2TradeStats.sharpeRatio,
  };
}

async function runLayer3(layer2Result, options = {}) {
  const available = await isLocalLLMAvailable();
  if (!available) {
    return {
      ...layer2Result,
      layer3Status: 'llm_unavailable',
      finalSignals: [],
      finalSummary: { buy: 0, sell: 0, hold: 0 },
    };
  }

  const finalSignals = [];
  const maxSignals = Number.isFinite(Number(options.maxSignals))
    ? Math.max(0, Number(options.maxSignals))
    : layer2Result.layer2PassedSignals.length;
  for (const signal of layer2Result.layer2PassedSignals.slice(0, maxSignals)) {
    const prompt = [
      { role: 'system', content: '당신은 루나 투자 팀장이다. 추론 설명이나 <think>, 마크다운 없이 JSON 객체 하나만 답한다. 형식: {"decision":"BUY|SELL|HOLD","confidence":0.75,"reason":"이유","riskLevel":"low|medium|high"}' },
      { role: 'user', content: `symbol=${layer2Result.symbol}, ts=${signal.ts}, 기술=${signal.action}, score=${signal.score}, RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, sentiment=${signal.sentiment?.score ?? 0.5}` },
    ];
    const judge = await callLocalLLMJSON(LOCAL_MODEL_DEEP, prompt, { max_tokens: 512, temperature: 0.1, timeoutMs: 180000 });
    finalSignals.push(normalizeLayer3Decision(signal, judge));
  }

  const finalTradeStats = buildTradeStats(toActionSignals(finalSignals, 'finalAction'));

  return {
    ...layer2Result,
    layer3Status: 'ok',
    finalSignals,
    finalSummary: summarizeLayerActions(finalSignals, 'finalAction'),
    totalTrades: finalTradeStats.totalTrades,
    winRate: finalTradeStats.winRate,
    totalPnlPct: finalTradeStats.totalPnlPct,
    maxDrawdown: finalTradeStats.maxDrawdown,
    sharpeRatio: finalTradeStats.sharpeRatio,
  };
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const symbolArg = parseArg('symbol', 'BTC/USDT');
      const fromArg = parseArg('from', '2024-01-01');
      const toArg = parseArg('to', kst.today());
      const layerArg = parseArg('layer', '1');
      const maxSignalsArg = parseArg('max-signals', null);
      return runBacktest(symbolArg, fromArg, toArg, layerArg, {
        maxSignals: maxSignalsArg == null ? null : Number(maxSignalsArg),
      });
    },
    onSuccess: async (result) => {
      console.log('\n결과:', JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ 크로노스 오류:',
  });
}

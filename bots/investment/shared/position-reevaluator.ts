// @ts-nocheck

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as db from './db.ts';
import { getPositionReevaluationRuntimeConfig } from './runtime-config.ts';

const execFileAsync = promisify(execFile);
const TRADINGVIEW_MCP_SCRIPT = new URL('../scripts/tradingview-mcp-server.py', import.meta.url);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toYahooTicker(symbol, exchange) {
  if (exchange === 'binance' && typeof symbol === 'string' && symbol.endsWith('/USDT')) {
    return symbol.replace('/USDT', '-USD');
  }
  if (exchange === 'kis' && /^\d{6}$/.test(String(symbol || ''))) {
    return `${symbol}.KS`;
  }
  return symbol;
}

function getIndicatorFramesForExchange(exchange = 'binance') {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.byExchange?.[exchange];
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((item) => String(item)).filter(Boolean);
  }
  if (exchange === 'kis') return ['1h', '1d'];
  return ['1h', '4h', '1d'];
}

function getIndicatorWeightsForExchange(exchange = 'binance', frames = []) {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.weightsByExchange?.[exchange];
  const weights = {};
  if (configured && typeof configured === 'object') {
    for (const frame of frames) {
      const raw = Number(configured?.[frame]);
      if (Number.isFinite(raw) && raw > 0) {
        weights[frame] = raw;
      }
    }
  }
  if (Object.keys(weights).length > 0) {
    return weights;
  }
  if (exchange === 'kis') {
    return { '1h': 0.35, '1d': 0.65 };
  }
  return { '1h': 0.2, '4h': 0.35, '1d': 0.45 };
}

function getIndicatorThresholdsForExchange(exchange = 'binance') {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.thresholdsByExchange?.[exchange];
  const buy = Number(configured?.buy);
  const sell = Number(configured?.sell);
  if (Number.isFinite(buy) && Number.isFinite(sell)) {
    return { buy, sell };
  }
  if (exchange === 'kis') {
    return { buy: 0.2, sell: -0.2 };
  }
  return { buy: 0.25, sell: -0.25 };
}

async function fetchTradingViewIndicatorSnapshot(symbol, exchange, interval = '1h') {
  const yahooSymbol = toYahooTicker(symbol, exchange);
  const { stdout } = await execFileAsync('python3', [
    TRADINGVIEW_MCP_SCRIPT.pathname,
    '--indicators',
    '--json',
    `--symbol=${yahooSymbol}`,
    `--interval=${interval}`,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
  });

  const payload = JSON.parse(String(stdout || '{}'));
  if (String(payload?.status || 'error') !== 'ok') {
    throw new Error(payload?.message || 'indicator fetch failed');
  }

  const signal = String(payload?.signal || 'HOLD').toUpperCase();
  const confidence = signal === 'HOLD'
    ? 0.4
    : Math.min(1, Math.max(
        Math.abs(safeNumber(payload?.macd_hist)) * 8,
        Math.abs(safeNumber(payload?.bb_pct) - 0.5),
        Math.abs((safeNumber(payload?.rsi) - 50) / 50),
      ));

  return {
    analyst: `tradingview_indicator_${interval}`,
    signal,
    confidence,
    reasoning: [
      `TV ${interval}`,
      `RSI ${safeNumber(payload?.rsi).toFixed(1)}`,
      `MACD ${safeNumber(payload?.macd).toFixed(4)}`,
      `BB ${safeNumber(payload?.bb_pct).toFixed(2)}`,
    ].join(' | '),
    snapshot: {
      symbol: yahooSymbol,
      interval,
      close: payload?.close ?? null,
      rsi: payload?.rsi ?? null,
      macd: payload?.macd ?? null,
      macdSignal: payload?.macd_signal ?? null,
      macdHist: payload?.macd_hist ?? null,
      bbPct: payload?.bb_pct ?? null,
      signal,
    },
  };
}

function normalizeIndicatorSignal(signal = '') {
  const normalized = String(signal || '').toUpperCase();
  if (normalized === 'BUY') return 'BUY';
  if (normalized === 'SELL') return 'SELL';
  return 'HOLD';
}

function buildTradingViewMtfAnalysis(snapshots = [], exchange = 'binance') {
  const valid = snapshots.filter(Boolean);
  if (valid.length === 0) return null;

  const frameIds = valid.map((item) => String(item?.snapshot?.interval || ''));
  const weights = getIndicatorWeightsForExchange(exchange, frameIds);
  const thresholds = getIndicatorThresholdsForExchange(exchange);
  let buy = 0;
  let sell = 0;
  let hold = 0;
  let confidenceSum = 0;
  let weightedBias = 0;
  let weightedTotal = 0;
  for (const item of valid) {
    const signal = normalizeIndicatorSignal(item.signal);
    const interval = String(item?.snapshot?.interval || '');
    const weight = Number(weights?.[interval] || 1);
    if (signal === 'BUY') buy += 1;
    else if (signal === 'SELL') sell += 1;
    else hold += 1;
    confidenceSum += safeNumber(item.confidence);
    const directional = signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0;
    weightedBias += directional * weight;
    weightedTotal += weight;
  }

  let signal = 'HOLD';
  const normalizedBias = weightedTotal > 0 ? (weightedBias / weightedTotal) : 0;
  if (normalizedBias >= thresholds.buy) signal = 'BUY';
  else if (normalizedBias <= thresholds.sell) signal = 'SELL';

  const avgConfidence = confidenceSum / valid.length;
  const reasoning = valid
    .map((item) => `${item.snapshot?.interval || 'n/a'} ${normalizeIndicatorSignal(item.signal)} RSI ${safeNumber(item.snapshot?.rsi).toFixed(1)} BB ${safeNumber(item.snapshot?.bbPct).toFixed(2)}`)
    .join(' | ');

  return {
    analyst: 'tradingview_indicator_mtf',
    signal,
    confidence: avgConfidence,
    reasoning: `TV-MTF ${reasoning}`,
    snapshot: {
      timeframes: valid.map((item) => item.snapshot),
      buy,
      sell,
      hold,
      weights,
      thresholds,
      weightedBias: normalizedBias,
      compositeSignal: signal,
      avgConfidence,
    },
  };
}

function calcPnlPct(position) {
  const amount = safeNumber(position?.amount);
  const avgPrice = safeNumber(position?.avg_price);
  const unrealizedPnl = safeNumber(position?.unrealized_pnl);
  const basis = amount * avgPrice;
  if (!(basis > 0)) return 0;
  return (unrealizedPnl / basis) * 100;
}

function summarizeAnalyses(rows = []) {
  const summary = {
    total: rows.length,
    buy: 0,
    hold: 0,
    sell: 0,
    avgConfidence: 0,
    analysts: {},
    liveIndicator: null,
    liveIndicatorFrames: [],
  };

  let confidenceSum = 0;
  for (const row of rows) {
    const signal = String(row?.signal || '').toUpperCase();
    const analyst = String(row?.analyst || 'unknown');
    const confidence = safeNumber(row?.confidence);
    if (signal === 'BUY') summary.buy += 1;
    else if (signal === 'SELL') summary.sell += 1;
    else summary.hold += 1;
    confidenceSum += confidence;
    summary.analysts[analyst] = {
      signal,
      confidence,
      reasoning: String(row?.reasoning || '').slice(0, 160) || null,
    };

    if (analyst === 'tradingview_indicator_mtf') {
      summary.liveIndicator = row?.snapshot || null;
    } else if (String(analyst).startsWith('tradingview_indicator_') && row?.snapshot) {
      summary.liveIndicatorFrames.push(row.snapshot);
    }
  }

  summary.avgConfidence = rows.length > 0 ? confidenceSum / rows.length : 0;
  return summary;
}

function getIndicatorFrame(summary = {}, interval = '4h') {
  const frames = Array.isArray(summary?.liveIndicatorFrames) ? summary.liveIndicatorFrames : [];
  return frames.find((item) => String(item?.interval || '') === interval) || null;
}

function decideReevaluation(position, analysisSummary) {
  const pnlPct = calcPnlPct(position);
  const buy = Number(analysisSummary.buy || 0);
  const hold = Number(analysisSummary.hold || 0);
  const sell = Number(analysisSummary.sell || 0);
  const avgConfidence = safeNumber(analysisSummary.avgConfidence);
  const tvComposite = String(analysisSummary?.liveIndicator?.compositeSignal || 'HOLD').toUpperCase();
  const tv4h = getIndicatorFrame(analysisSummary, '4h');
  const tv1d = getIndicatorFrame(analysisSummary, '1d');
  const tv4hSignal = String(tv4h?.signal || 'HOLD').toUpperCase();
  const tv4hRsi = safeNumber(tv4h?.rsi, null);
  const tv1dSignal = String(tv1d?.signal || 'HOLD').toUpperCase();
  const tv1dRsi = safeNumber(tv1d?.rsi, null);

  if (pnlPct <= -5) {
    return {
      recommendation: 'EXIT',
      reasonCode: 'stop_loss_threshold',
      reason: `미실현손익 ${pnlPct.toFixed(2)}%로 -5% 손절 기준 이하`,
    };
  }

  if (sell >= buy && pnlPct < 0 && sell > 0) {
    return {
      recommendation: 'EXIT',
      reasonCode: 'bearish_loss_consensus',
      reason: `SELL 우세(${sell} > ${buy})이며 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  }

  if (pnlPct < 0 && sell >= buy && sell > 0 && (tv4hSignal === 'SELL' || tv1dSignal === 'SELL' || tvComposite === 'SELL')) {
    return {
      recommendation: 'EXIT',
      reasonCode: 'mtf_bearish_consensus_exit',
      reason: `DB 약세 우세(BUY ${buy} / SELL ${sell})와 TV 약세(${tv4hSignal}/${tv1dSignal}/${tvComposite})가 겹친 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  }

  if (pnlPct < 0 && tv4hSignal === 'SELL') {
    return {
      recommendation: 'EXIT',
      reasonCode: 'tv_4h_bearish_reversal',
      reason: `4h TradingView 약세 전환(SELL)이며 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  }

  if (pnlPct >= 10) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'profit_lock_candidate',
      reason: `미실현수익 ${pnlPct.toFixed(2)}%로 부분익절/TP 조정 후보`,
    };
  }

  if (pnlPct >= 5 && (tv4hSignal === 'SELL' || tvComposite === 'SELL')) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'tv_trend_weakening',
      reason: `TradingView MTF 약세(${tv4hSignal}/${tvComposite})가 보여 수익 구간 ${pnlPct.toFixed(2)}% 보호 조정 후보`,
    };
  }

  if (pnlPct >= 8 && tv1dSignal === 'SELL') {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'tv_1d_bearish_reversal',
      reason: `1d TradingView 약세 전환(SELL)으로 수익 구간 ${pnlPct.toFixed(2)}% 보호 조정 후보`,
    };
  }

  if (pnlPct >= 3 && tv4hSignal === 'HOLD' && tv4hRsi != null && tv4hRsi < 45) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'tv_4h_momentum_cooling',
      reason: `4h RSI ${tv4hRsi.toFixed(2)}로 모멘텀 둔화가 보여 수익 구간 ${pnlPct.toFixed(2)}% 조정 후보`,
    };
  }

  if (pnlPct >= 5 && tv1dSignal === 'HOLD' && tv1dRsi != null && tv1dRsi < 48) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'tv_1d_momentum_cooling',
      reason: `1d RSI ${tv1dRsi.toFixed(2)}로 상위 추세 모멘텀 둔화가 보여 수익 구간 ${pnlPct.toFixed(2)}% 조정 후보`,
    };
  }

  if (buy === 0 && hold > 0 && avgConfidence < 0.35) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'weak_support',
      reason: `BUY 지지 없이 HOLD 중심(${hold})이며 평균 확신도 ${avgConfidence.toFixed(2)}`,
    };
  }

  return {
    recommendation: 'HOLD',
    reasonCode: 'hold_bias',
    reason: `보유 유지 조건 충족 (BUY ${buy} / HOLD ${hold} / SELL ${sell}, PnL ${pnlPct.toFixed(2)}%)`,
  };
}

async function ensurePositionReevaluationSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS position_reevaluation_runs (
      id SERIAL PRIMARY KEY,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      paper BOOLEAN DEFAULT false,
      trade_mode TEXT DEFAULT 'normal',
      recommendation TEXT NOT NULL,
      reason_code TEXT,
      reason TEXT,
      pnl_pct DOUBLE PRECISION,
      position_snapshot JSONB,
      analysis_snapshot JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function persistRuns(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensurePositionReevaluationSchema();
  for (const row of rows) {
    await db.run(`
      INSERT INTO position_reevaluation_runs (
        exchange, symbol, paper, trade_mode, recommendation, reason_code, reason,
        pnl_pct, position_snapshot, analysis_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
    `, [
      row.exchange,
      row.symbol,
      row.paper === true,
      row.tradeMode || 'normal',
      row.recommendation,
      row.reasonCode || null,
      row.reason || null,
      row.pnlPct ?? null,
      JSON.stringify(row.positionSnapshot || {}),
      JSON.stringify(row.analysisSnapshot || {}),
    ]);
  }
  return rows.length;
}

export async function reevaluateOpenPositions({
  exchange = null,
  paper = false,
  tradeMode = null,
  minutesBack = 180,
  persist = true,
  liveIndicators = true,
} = {}) {
  const positions = await db.getOpenPositions(exchange, paper, tradeMode);
  const results = [];

  for (const position of positions) {
    const analyses = await db.getRecentAnalysis(position.symbol, minutesBack, position.exchange).catch(() => []);
    let indicatorAnalyses = [];
    let indicatorAnalysis = null;
    if (liveIndicators) {
      const intervals = getIndicatorFramesForExchange(position.exchange);
      const indicatorFrames = await Promise.all(
        intervals.map((interval) =>
          fetchTradingViewIndicatorSnapshot(position.symbol, position.exchange, interval).catch(() => null),
        ),
      );
      indicatorAnalyses = indicatorFrames.filter(Boolean);
      indicatorAnalysis = buildTradingViewMtfAnalysis(indicatorAnalyses, position.exchange);
    }
    const mergedAnalyses = [
      ...analyses,
      ...indicatorAnalyses,
      ...(indicatorAnalysis ? [indicatorAnalysis] : []),
    ];
    const analysisSummary = summarizeAnalyses(mergedAnalyses);
    const decision = decideReevaluation(position, analysisSummary);
    results.push({
      exchange: position.exchange,
      symbol: position.symbol,
      paper: position.paper === true,
      tradeMode: position.trade_mode || 'normal',
      pnlPct: calcPnlPct(position),
      recommendation: decision.recommendation,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      positionSnapshot: {
        amount: safeNumber(position.amount),
        avgPrice: safeNumber(position.avg_price),
        unrealizedPnl: safeNumber(position.unrealized_pnl),
        entryTime: position.entry_time || null,
      },
      analysisSnapshot: analysisSummary,
    });
  }

  let persisted = 0;
  if (persist && results.length > 0) {
    persisted = await persistRuns(results);
  }

  return {
    ok: true,
    count: results.length,
    persisted,
    summary: {
      hold: results.filter((item) => item.recommendation === 'HOLD').length,
      adjust: results.filter((item) => item.recommendation === 'ADJUST').length,
      exit: results.filter((item) => item.recommendation === 'EXIT').length,
    },
    rows: results,
  };
}

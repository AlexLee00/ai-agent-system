// @ts-nocheck

import * as db from './db.ts';

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  }

  summary.avgConfidence = rows.length > 0 ? confidenceSum / rows.length : 0;
  return summary;
}

function decideReevaluation(position, analysisSummary) {
  const pnlPct = calcPnlPct(position);
  const buy = Number(analysisSummary.buy || 0);
  const hold = Number(analysisSummary.hold || 0);
  const sell = Number(analysisSummary.sell || 0);
  const avgConfidence = safeNumber(analysisSummary.avgConfidence);

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

  if (pnlPct >= 10) {
    return {
      recommendation: 'ADJUST',
      reasonCode: 'profit_lock_candidate',
      reason: `미실현수익 ${pnlPct.toFixed(2)}%로 부분익절/TP 조정 후보`,
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
} = {}) {
  const positions = await db.getOpenPositions(exchange, paper, tradeMode);
  const results = [];

  for (const position of positions) {
    const analyses = await db.getRecentAnalysis(position.symbol, minutesBack, position.exchange).catch(() => []);
    const analysisSummary = summarizeAnalyses(analyses);
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

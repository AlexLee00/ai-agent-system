// @ts-nocheck
import { query, run, get } from './core.ts';

export async function insertRiskLog({ traceId, symbol, exchange, decision, riskScore, reason }) {
  await run(
    `INSERT INTO risk_log (trace_id, symbol, exchange, decision, risk_score, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [traceId, symbol ?? null, exchange ?? null, decision, riskScore ?? null, reason ?? null],
  );
}

export async function insertAssetSnapshot(equity, valueUsd = null) {
  await run(`INSERT INTO asset_snapshot (equity, value_usd) VALUES ($1,$2)`, [equity, valueUsd]);
}

export async function getLatestEquity() {
  const row = await get(`SELECT equity FROM asset_snapshot ORDER BY snapped_at DESC LIMIT 1`);
  return row?.equity ?? null;
}

export async function getEquityHistory(limit = 200, options = {}) {
  const normalizedLimit = Math.max(1, Number.parseInt(String(limit), 10) || 200);
  const positiveOnly = options?.positiveOnly !== false;
  const since = options?.since ? new Date(options.since) : null;
  const params = [];
  const clauses = [];

  if (positiveOnly) {
    params.push(0);
    clauses.push(`equity > $${params.length}`);
  }

  if (since && !Number.isNaN(since.getTime())) {
    params.push(since.toISOString());
    clauses.push(`snapped_at >= $${params.length}`);
  }

  params.push(normalizedLimit);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return query(
    `SELECT equity, snapped_at FROM asset_snapshot ${whereClause} ORDER BY snapped_at ASC LIMIT $${params.length}`,
    params,
  );
}

export async function insertMarketRegimeSnapshot({
  market,
  regime,
  confidence = 0.5,
  indicators = {},
} = {}) {
  if (!market || !regime) return null;
  return get(
    `INSERT INTO market_regime_snapshots (
       market,
       regime,
       confidence,
       indicators
     ) VALUES ($1, $2, $3, $4)
     RETURNING id, market, regime, confidence, indicators, captured_at`,
    [
      String(market),
      String(regime),
      Number(confidence || 0.5),
      JSON.stringify(indicators || {}),
    ],
  );
}

// @ts-nocheck
import * as db from './db.ts';

const REFLECTION_STATE_TABLE = 'discovery_reflection_state';

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== 'object') return fallback;
  return value;
}

async function ensureReflectionStateTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS ${REFLECTION_STATE_TABLE} (
      scope_key        TEXT PRIMARY KEY,
      last_reported_at TIMESTAMPTZ,
      report_meta      JSONB DEFAULT '{}'::jsonb,
      updated_at       TIMESTAMPTZ DEFAULT now()
    )
  `);
}

export async function shouldPublishDiscoveryReflectionReport({
  exchange = 'all',
  minHours = Number(process.env.LUNA_DISCOVERY_REFLECTION_REPORT_MIN_HOURS || 24),
  now = new Date(),
  reportMeta = {},
} = {}) {
  const hours = Math.max(1, Number(minHours || 24));
  const scopeKey = `reflection_report:${String(exchange || 'all')}`;
  await ensureReflectionStateTable();
  const existing = await db.get(
    `SELECT last_reported_at FROM ${REFLECTION_STATE_TABLE} WHERE scope_key = $1`,
    [scopeKey],
  );
  const last = existing?.last_reported_at ? new Date(existing.last_reported_at).getTime() : 0;
  if (last > 0 && Number.isFinite(last) && now.getTime() - last < hours * 3600_000) {
    return { publish: false, scopeKey, minHours: hours, lastReportedAt: existing.last_reported_at };
  }
  await db.run(
    `INSERT INTO ${REFLECTION_STATE_TABLE} (scope_key, last_reported_at, report_meta, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (scope_key) DO UPDATE SET
       last_reported_at = EXCLUDED.last_reported_at,
       report_meta = EXCLUDED.report_meta,
       updated_at = now()`,
    [scopeKey, now.toISOString(), JSON.stringify(safeJson(reportMeta, {}))],
  );
  return { publish: true, scopeKey, minHours: hours, lastReportedAt: now.toISOString() };
}

export async function recordDiscoveryAttribution({
  signalId,
  source = null,
  setupType = null,
  triggerType = null,
  discoveryScore = null,
  predictiveScore = null,
  note = null,
} = {}) {
  if (!signalId) return null;
  const patch = {
    discoveryAttribution: {
      source: source || null,
      setupType: setupType || null,
      triggerType: triggerType || null,
      discoveryScore: discoveryScore != null ? Number(discoveryScore) : null,
      predictiveScore: predictiveScore != null ? Number(predictiveScore) : null,
      note: note || null,
      updatedAt: new Date().toISOString(),
    },
  };
  await db.mergeSignalBlockMeta(signalId, patch).catch(() => null);
  return patch.discoveryAttribution;
}

export async function buildDiscoveryReflectionSummary({ days = 30, exchange = null } = {}) {
  const conds = [`tj.status = 'closed'`, `tj.exit_time IS NOT NULL`, `to_timestamp(tj.exit_time / 1000.0) >= now() - ($1::int * INTERVAL '1 day')`];
  const params = [Math.max(1, Number(days || 30))];
  if (exchange) {
    params.push(exchange);
    conds.push(`tj.exchange = $${params.length}`);
  }

  const rows = await db.query(
    `SELECT
       s.symbol,
       s.exchange,
       COALESCE(s.block_meta->'discoveryAttribution'->>'source', 'unknown') AS source,
       COALESCE(s.block_meta->'discoveryAttribution'->>'setupType', 'unknown') AS setup_type,
       COALESCE(s.block_meta->'discoveryAttribution'->>'triggerType', 'unknown') AS trigger_type,
       AVG(COALESCE(tj.pnl_pct, 0))::float AS avg_pnl_pct,
       AVG(CASE WHEN COALESCE(tj.pnl_pct, 0) > 0 THEN 1 ELSE 0 END)::float AS win_rate,
       COUNT(*)::int AS closed_count
     FROM trade_journal tj
     JOIN signals s ON s.id::text = tj.signal_id::text
     WHERE ${conds.join(' AND ')}
     GROUP BY s.symbol, s.exchange, source, setup_type, trigger_type
     ORDER BY closed_count DESC, avg_pnl_pct DESC`,
    params,
  ).catch(() => []);

  const sourceAgg = new Map();
  for (const row of rows) {
    const key = String(row.source || 'unknown');
    const prev = sourceAgg.get(key) || { closed: 0, winRateSum: 0, pnlSum: 0, setups: new Set() };
    const closed = Number(row.closed_count || 0);
    prev.closed += closed;
    prev.winRateSum += Number(row.win_rate || 0) * closed;
    prev.pnlSum += Number(row.avg_pnl_pct || 0) * closed;
    prev.setups.add(String(row.setup_type || 'unknown'));
    sourceAgg.set(key, prev);
  }

  const bySource = Array.from(sourceAgg.entries()).map(([source, value]) => ({
    source,
    closed: value.closed,
    avgWinRate: value.closed > 0 ? Number((value.winRateSum / value.closed).toFixed(4)) : 0,
    avgPnlPct: value.closed > 0 ? Number((value.pnlSum / value.closed).toFixed(4)) : 0,
    setupCount: value.setups.size,
  })).sort((a, b) => b.closed - a.closed);

  return {
    generatedAt: new Date().toISOString(),
    days: Math.max(1, Number(days || 30)),
    exchange: exchange || 'all',
    totalRows: rows.length,
    bySource,
    topSetups: rows.slice(0, 10).map((row) => ({
      symbol: row.symbol,
      setupType: row.setup_type,
      triggerType: row.trigger_type,
      source: row.source,
      winRate: Number(row.win_rate || 0),
      avgPnlPct: Number(row.avg_pnl_pct || 0),
      closed: Number(row.closed_count || 0),
    })),
  };
}

export default {
  recordDiscoveryAttribution,
  buildDiscoveryReflectionSummary,
  shouldPublishDiscoveryReflectionReport,
};

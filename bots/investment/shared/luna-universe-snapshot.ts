// @ts-nocheck

import * as db from './db.ts';

function toDateString(value: any) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeMarket(market: any) {
  const value = String(market || '').trim();
  return ['domestic', 'overseas', 'crypto'].includes(value) ? value : null;
}

export async function persistUniverseSnapshot(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const dryRun = options.dryRun === true;
  const snapshotDate = options.snapshotDate || null;

  if (dryRun) {
    const rows = await queryFn(
      `WITH active AS (
         SELECT 1
           FROM candidate_universe
          WHERE expires_at > NOW()
       )
       SELECT COALESCE($1::date, CURRENT_DATE)::text AS snapshot_date,
              COUNT(*)::int AS total_active,
              0::int AS inserted
         FROM active`,
      [snapshotDate]
    );
    const row = rows?.[0] || {};
    return {
      ok: true,
      dryRun: true,
      snapshotDate: toDateString(row.snapshot_date),
      inserted: 0,
      totalActive: Number(row.total_active || 0),
    };
  }

  const rows = await queryFn(
    `WITH active AS (
       SELECT COALESCE($1::date, CURRENT_DATE) AS snapshot_date,
              symbol,
              market,
              source,
              source_tier,
              score,
              confidence,
              COALESCE(quality_flags, '[]'::jsonb) AS quality_flags,
              reason_code
         FROM candidate_universe
        WHERE expires_at > NOW()
     ),
     inserted AS (
       INSERT INTO universe_snapshot
         (snapshot_date, symbol, market, source, source_tier, score, confidence, quality_flags, reason_code)
       SELECT snapshot_date, symbol, market, source, source_tier, score, confidence, quality_flags, reason_code
         FROM active
       ON CONFLICT (snapshot_date, symbol, market, source) DO NOTHING
       RETURNING 1
     )
     SELECT COALESCE($1::date, CURRENT_DATE)::text AS snapshot_date,
            (SELECT COUNT(*)::int FROM active) AS total_active,
            (SELECT COUNT(*)::int FROM inserted) AS inserted`,
    [snapshotDate]
  );
  const row = rows?.[0] || {};
  return {
    ok: true,
    dryRun: false,
    snapshotDate: toDateString(row.snapshot_date),
    inserted: Number(row.inserted || 0),
    totalActive: Number(row.total_active || 0),
  };
}

export async function getUniverseSnapshotAsOf(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const asOfDate = options.asOfDate || options.asOf || null;
  if (!asOfDate) throw new Error('getUniverseSnapshotAsOf requires asOfDate');
  const market = normalizeMarket(options.market);

  const rows = await queryFn(
    `WITH latest AS (
       SELECT market, MAX(snapshot_date) AS snapshot_date
         FROM universe_snapshot
        WHERE snapshot_date <= $1::date
          AND ($2::text IS NULL OR market = $2)
        GROUP BY market
     )
     SELECT u.snapshot_date::text AS snapshot_date,
            u.symbol,
            u.market,
            u.source,
            u.source_tier,
            u.score,
            u.confidence,
            u.quality_flags,
            u.reason_code,
            u.captured_at
       FROM universe_snapshot u
       JOIN latest l ON l.market = u.market AND l.snapshot_date = u.snapshot_date
      WHERE ($2::text IS NULL OR u.market = $2)
      ORDER BY u.market ASC, u.symbol ASC, u.source ASC`,
    [asOfDate, market]
  );
  const snapshotDatesByMarket = {};
  for (const row of rows || []) {
    if (row.market && row.snapshot_date) snapshotDatesByMarket[row.market] = toDateString(row.snapshot_date);
  }
  const uniqueSnapshotDates = Array.from(new Set(Object.values(snapshotDatesByMarket).filter(Boolean)));

  return {
    ok: true,
    asOfDate: toDateString(asOfDate),
    snapshotDate: uniqueSnapshotDates.length === 1 ? uniqueSnapshotDates[0] : null,
    snapshotDatesByMarket,
    market,
    rows: rows || [],
    symbols: Array.from(new Set((rows || []).map((row: any) => row.symbol).filter(Boolean))),
  };
}

export default {
  persistUniverseSnapshot,
  getUniverseSnapshotAsOf,
};

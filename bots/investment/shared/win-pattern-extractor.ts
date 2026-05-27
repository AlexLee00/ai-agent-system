// @ts-nocheck
/**
 * Win pattern extractor based on trade_journal.
 */

import * as db from './db.ts';

export interface WinPattern {
  patternKey: string;
  market: string;
  symbolCount: number;
  tradeCount: number;
  avgWinPct: number;
  totalProfit: number;
  reasonCodes: string[];
  patternTypes: string[];
  regime: string | null;
  strategyFamily: string | null;
  priorityGuide: string;
  confidence: number;
  extractedAt: string;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureWinPatternTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_win_patterns (
      pattern_key TEXT PRIMARY KEY,
      market TEXT NOT NULL DEFAULT 'all',
      symbol_count INTEGER NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      avg_win_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_profit DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      pattern_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      regime TEXT,
      strategy_family TEXT,
      priority_guide TEXT,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => null);
}

async function fetchRecentWinTrades({ market, lookbackDays }: { market: string; lookbackDays: number }) {
  const params = market === 'all'
    ? [Math.max(1, lookbackDays)]
    : [Math.max(1, lookbackDays), market];
  const marketFilter = market === 'all' ? '' : 'AND market = $2';
  return db.query(
    `SELECT
       trade_id,
       symbol,
       market,
       exchange,
       pnl_percent,
       pnl_amount,
       pnl_net,
       exit_reason,
       market_regime,
       strategy_family,
       exit_time,
       created_at
     FROM investment.trade_journal
     WHERE COALESCE(pnl_percent, 0) > 0
       AND exit_time IS NOT NULL
       AND to_timestamp(exit_time / 1000.0) >= NOW() - ($1::int * INTERVAL '1 day')
       ${marketFilter}
     ORDER BY pnl_percent DESC, exit_time DESC
     LIMIT 500`,
    params,
  ).catch(() => []);
}

function clusterByPattern(rows: any[]) {
  const groups = new Map();
  for (const row of rows) {
    const market = String(row.market || 'crypto');
    const exitReason = String(row.exit_reason || 'unknown_exit');
    const regime = row.market_regime ? String(row.market_regime) : null;
    const strategyFamily = row.strategy_family ? String(row.strategy_family) : null;
    const key = `${market}:${strategyFamily || 'any'}:${exitReason}:${regime || 'any'}`;
    if (!groups.has(key)) {
      groups.set(key, { key, market, exitReason, regime, strategyFamily, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
}

function buildWinPattern(cluster): WinPattern {
  const symbols = [...new Set(cluster.rows.map((row) => String(row.symbol || '')).filter(Boolean))];
  const wins = cluster.rows.map((row) => asNumber(row.pnl_percent, 0)).filter((n) => n > 0);
  const avgWinPct = wins.length ? wins.reduce((sum, n) => sum + n, 0) / wins.length : 0;
  const totalProfit = cluster.rows.reduce((sum, row) => sum + asNumber(row.pnl_net ?? row.pnl_amount, 0), 0);
  const guideParts = [
    `${cluster.strategyFamily || 'unknown_strategy'} 패턴 ${cluster.rows.length}건`,
    `평균 수익 ${avgWinPct.toFixed(2)}%`,
  ];
  if (cluster.regime) guideParts.push(`${cluster.regime} 레짐`);
  if (symbols.length > 0) guideParts.push(`대상 ${symbols.slice(0, 3).join(', ')}`);
  return {
    patternKey: cluster.key,
    market: cluster.market,
    symbolCount: symbols.length,
    tradeCount: cluster.rows.length,
    avgWinPct,
    totalProfit,
    reasonCodes: [cluster.strategyFamily || 'unknown_strategy'],
    patternTypes: [cluster.exitReason],
    regime: cluster.regime,
    strategyFamily: cluster.strategyFamily,
    priorityGuide: `${guideParts.join(' - ')}: 동일 조건 재현 시 shadow 우선순위 상승 후보`,
    confidence: Math.min(0.9, 0.45 + cluster.rows.length * 0.05 + Math.min(0.25, avgWinPct / 100)),
    extractedAt: new Date().toISOString(),
  };
}

async function persistWinPatterns(patterns: WinPattern[]): Promise<void> {
  await ensureWinPatternTable();
  for (const p of patterns) {
    await db.run(
      `INSERT INTO investment.luna_win_patterns
         (pattern_key, market, symbol_count, trade_count, avg_win_pct, total_profit,
          reason_codes, pattern_types, regime, strategy_family, priority_guide, confidence, extracted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
       ON CONFLICT (pattern_key) DO UPDATE SET
         symbol_count = EXCLUDED.symbol_count,
         trade_count = EXCLUDED.trade_count,
         avg_win_pct = EXCLUDED.avg_win_pct,
         total_profit = EXCLUDED.total_profit,
         priority_guide = EXCLUDED.priority_guide,
         confidence = EXCLUDED.confidence,
         extracted_at = EXCLUDED.extracted_at`,
      [
        p.patternKey,
        p.market,
        p.symbolCount,
        p.tradeCount,
        p.avgWinPct,
        p.totalProfit,
        JSON.stringify(p.reasonCodes),
        JSON.stringify(p.patternTypes),
        p.regime,
        p.strategyFamily,
        p.priorityGuide,
        p.confidence,
        p.extractedAt,
      ],
    ).catch(() => null);
  }
}

export async function extractWinPatterns({
  market = 'all',
  lookbackDays = 30,
  minTradeCount = 2,
  persist = false,
}: {
  market?: string;
  lookbackDays?: number;
  minTradeCount?: number;
  llmEnabled?: boolean;
  persist?: boolean;
} = {}): Promise<WinPattern[]> {
  const rows = await fetchRecentWinTrades({ market, lookbackDays });
  const patterns = clusterByPattern(rows)
    .filter((cluster) => cluster.rows.length >= Math.max(1, minTradeCount))
    .map(buildWinPattern);
  if (persist && patterns.length > 0) await persistWinPatterns(patterns);
  return patterns;
}

export async function getTopWinPatterns({ market = 'all', limit = 10 }: { market?: string; limit?: number } = {}): Promise<WinPattern[]> {
  const params = market === 'all' ? [Math.max(1, limit)] : [Math.max(1, limit), market];
  const where = market === 'all' ? '' : 'WHERE market = $2';
  const rows = await db.query(
    `SELECT *
       FROM investment.luna_win_patterns
       ${where}
      ORDER BY total_profit DESC, avg_win_pct DESC, extracted_at DESC
      LIMIT $1`,
    params,
  ).catch(() => []);
  return rows.map((row: any) => ({
    patternKey: row.pattern_key,
    market: row.market,
    symbolCount: Number(row.symbol_count || 0),
    tradeCount: Number(row.trade_count || 0),
    avgWinPct: Number(row.avg_win_pct || 0),
    totalProfit: Number(row.total_profit || 0),
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes : [],
    patternTypes: Array.isArray(row.pattern_types) ? row.pattern_types : [],
    regime: row.regime || null,
    strategyFamily: row.strategy_family || null,
    priorityGuide: row.priority_guide || '',
    confidence: Number(row.confidence || 0),
    extractedAt: row.extracted_at || '',
  }));
}

export default { extractWinPatterns, getTopWinPatterns };

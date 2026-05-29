// @ts-nocheck
/**
 * Loss pattern extractor based on real Luna post-trade tables.
 */

import * as db from './db.ts';
import { learningPnlValidSql } from './trade-journal-learning-guard.ts';

export interface LossPattern {
  patternKey: string;
  market: string;
  symbolCount: number;
  tradeCount: number;
  avgLossPct: number;
  totalPenalty: number;
  reasonCodes: string[];
  patternTypes: string[];
  regime: string | null;
  strategyFamily: string | null;
  avoidanceGuide: string;
  confidence: number;
  extractedAt: string;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function ensureLossPatternTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_loss_patterns (
      pattern_key TEXT PRIMARY KEY,
      market TEXT NOT NULL DEFAULT 'all',
      symbol_count INTEGER NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      avg_loss_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_penalty DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      pattern_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      regime TEXT,
      strategy_family TEXT,
      avoidance_guide TEXT,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => null);
}

async function fetchRecentLossReflexions({ market, lookbackDays }: { market: string; lookbackDays: number }) {
  const params = market === 'all'
    ? [Math.max(1, lookbackDays)]
    : [Math.max(1, lookbackDays), market];
  const marketFilter = market === 'all'
    ? ''
    : `AND COALESCE(tj.market, lfr.avoid_pattern->>'market', 'crypto') = $2`;
  return db.query(
    `SELECT
       lfr.id,
       lfr.trade_id,
       lfr.five_why,
       lfr.stage_attribution,
       lfr.hindsight,
       lfr.avoid_pattern,
       lfr.created_at,
       tj.symbol,
       tj.market,
       tj.exchange,
       tj.pnl_percent,
       tj.exit_reason,
       tj.hold_duration,
       tj.market_regime,
       tj.strategy_family
     FROM investment.luna_failure_reflexions lfr
     LEFT JOIN investment.trade_journal tj ON tj.trade_id = lfr.trade_id::text
     WHERE lfr.created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${marketFilter}
       AND (tj.id IS NULL OR ${learningPnlValidSql('tj')})
     ORDER BY lfr.created_at DESC
     LIMIT 500`,
    params,
  ).catch(() => []);
}

function classifyReason(row: Record<string, unknown>): { reasonCode: string; patternType: string } {
  const text = [
    compactText(row.hindsight),
    compactText(row.five_why),
    compactText(row.stage_attribution),
    compactText(row.avoid_pattern),
    compactText(row.exit_reason),
  ].join(' ').toLowerCase();
  if (text.includes('stop') || text.includes('손절') || text.includes('청산')) {
    return { reasonCode: 'exit_timing_loss', patternType: 'exit' };
  }
  if (text.includes('size') || text.includes('sizing') || text.includes('비중')) {
    return { reasonCode: 'position_sizing_loss', patternType: 'risk' };
  }
  if (text.includes('regime') || text.includes('레짐')) {
    return { reasonCode: 'regime_mismatch_loss', patternType: 'regime' };
  }
  if (text.includes('entry') || text.includes('진입')) {
    return { reasonCode: 'entry_timing_loss', patternType: 'entry' };
  }
  return { reasonCode: 'unclassified_loss', patternType: 'general' };
}

function clusterByPattern(rows: any[]) {
  const groups = new Map();
  for (const row of rows) {
    const classified = classifyReason(row);
    const market = String(row.market || row.avoid_pattern?.market || 'crypto');
    const regime = row.market_regime ? String(row.market_regime) : null;
    const strategyFamily = row.strategy_family ? String(row.strategy_family) : null;
    const key = `${market}:${classified.reasonCode}:${classified.patternType}:${regime || 'any'}:${strategyFamily || 'any'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        market,
        reasonCode: classified.reasonCode,
        patternType: classified.patternType,
        regime,
        strategyFamily,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
}

function buildLossPattern(cluster): LossPattern {
  const symbols = [...new Set(cluster.rows.map((row) => String(row.symbol || row.avoid_pattern?.symbol || '')).filter(Boolean))];
  const losses = cluster.rows.map((row) => Math.abs(asNumber(row.pnl_percent, 0))).filter((n) => n > 0);
  const avgLossPct = losses.length ? losses.reduce((sum, n) => sum + n, 0) / losses.length : 0;
  const totalPenalty = cluster.rows.length * Math.max(0.1, avgLossPct / 100);
  const guideParts = [
    `${cluster.reasonCode} 패턴 ${cluster.rows.length}건`,
    avgLossPct > 0 ? `평균 손실 ${avgLossPct.toFixed(2)}%` : '손실률 미기록',
  ];
  if (cluster.regime) guideParts.push(`${cluster.regime} 레짐에서 감지`);
  if (symbols.length > 0) guideParts.push(`대상 ${symbols.slice(0, 3).join(', ')}`);

  return {
    patternKey: cluster.key,
    market: cluster.market,
    symbolCount: symbols.length,
    tradeCount: cluster.rows.length,
    avgLossPct,
    totalPenalty,
    reasonCodes: [cluster.reasonCode],
    patternTypes: [cluster.patternType],
    regime: cluster.regime,
    strategyFamily: cluster.strategyFamily,
    avoidanceGuide: `${guideParts.join(' - ')}: 동일 조건 신규 진입 bias/size를 shadow에서 축소`,
    confidence: Math.min(0.9, 0.45 + cluster.rows.length * 0.05 + Math.min(0.25, avgLossPct / 100)),
    extractedAt: new Date().toISOString(),
  };
}

async function persistLossPatterns(patterns: LossPattern[]): Promise<void> {
  await ensureLossPatternTable();
  for (const p of patterns) {
    await db.run(
      `INSERT INTO investment.luna_loss_patterns
         (pattern_key, market, symbol_count, trade_count, avg_loss_pct, total_penalty,
          reason_codes, pattern_types, regime, strategy_family, avoidance_guide, confidence, extracted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
       ON CONFLICT (pattern_key) DO UPDATE SET
         symbol_count = EXCLUDED.symbol_count,
         trade_count = EXCLUDED.trade_count,
         avg_loss_pct = EXCLUDED.avg_loss_pct,
         total_penalty = EXCLUDED.total_penalty,
         avoidance_guide = EXCLUDED.avoidance_guide,
         confidence = EXCLUDED.confidence,
         extracted_at = EXCLUDED.extracted_at`,
      [
        p.patternKey,
        p.market,
        p.symbolCount,
        p.tradeCount,
        p.avgLossPct,
        p.totalPenalty,
        JSON.stringify(p.reasonCodes),
        JSON.stringify(p.patternTypes),
        p.regime,
        p.strategyFamily,
        p.avoidanceGuide,
        p.confidence,
        p.extractedAt,
      ],
    ).catch(() => null);
  }
}

export async function extractLossPatterns({
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
} = {}): Promise<LossPattern[]> {
  const rows = await fetchRecentLossReflexions({ market, lookbackDays });
  const patterns = clusterByPattern(rows)
    .filter((cluster) => cluster.rows.length >= Math.max(1, minTradeCount))
    .map(buildLossPattern);
  if (persist && patterns.length > 0) await persistLossPatterns(patterns);
  return patterns;
}

export async function getTopLossPatterns({ market = 'all', limit = 10 }: { market?: string; limit?: number } = {}): Promise<LossPattern[]> {
  const params = market === 'all' ? [Math.max(1, limit)] : [Math.max(1, limit), market];
  const where = market === 'all' ? '' : 'WHERE market = $2';
  const rows = await db.query(
    `SELECT *
       FROM investment.luna_loss_patterns
       ${where}
      ORDER BY total_penalty DESC, extracted_at DESC
      LIMIT $1`,
    params,
  ).catch(() => []);
  return rows.map((row: any) => ({
    patternKey: row.pattern_key,
    market: row.market,
    symbolCount: Number(row.symbol_count || 0),
    tradeCount: Number(row.trade_count || 0),
    avgLossPct: Number(row.avg_loss_pct || 0),
    totalPenalty: Number(row.total_penalty || 0),
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes : [],
    patternTypes: Array.isArray(row.pattern_types) ? row.pattern_types : [],
    regime: row.regime || null,
    strategyFamily: row.strategy_family || null,
    avoidanceGuide: row.avoidance_guide || '',
    confidence: Number(row.confidence || 0),
    extractedAt: row.extracted_at || '',
  }));
}

export default { extractLossPatterns, getTopLossPatterns };

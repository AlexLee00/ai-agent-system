// @ts-nocheck
/**
 * C1 outcome attribution for vault shadow adjustments.
 *
 * Reads trade_journal/signals/pattern/shadow tables and writes only
 * investment.luna_vault_shadow_eval.
 */

import * as db from './db.ts';

const MS_PER_DAY = 86_400_000;
const POSITIVE_TYPES = new Set(['boost', 'enable']);
const NEGATIVE_TYPES = new Set(['penalize', 'disable']);

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
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

function adjustmentDirection(type: string | null | undefined): 'negative' | 'positive' | 'none' {
  const normalized = String(type || '').toLowerCase();
  if (NEGATIVE_TYPES.has(normalized)) return 'negative';
  if (POSITIVE_TYPES.has(normalized)) return 'positive';
  return 'none';
}

function correctness(type: string | null | undefined, avgPnl: number | null): boolean | null {
  if (avgPnl == null) return null;
  const direction = adjustmentDirection(type);
  if (direction === 'negative') return avgPnl < 0;
  if (direction === 'positive') return avgPnl > 0;
  return null;
}

function classifyLossReason(row: Record<string, unknown>): { reasonCode: string; patternType: string } {
  const text = [
    compactText(row.hindsight),
    compactText(row.five_why),
    compactText(row.stage_attribution),
    compactText(row.avoid_pattern),
    compactText(row.exit_reason),
    compactText(row.strategy_route),
    compactText(row.strategy_quality),
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

function splitPatternKey(patternKey: string): string[] {
  return String(patternKey || '').split(':').map((part) => part.trim());
}

function parsePattern(patternKey: string, baseAdjustmentType: string) {
  const parts = splitPatternKey(patternKey);
  const direction = adjustmentDirection(baseAdjustmentType);
  if (parts.length < 4) return { ok: false, type: 'unknown', reason: 'pattern_parts_lt_4' };

  if (direction === 'positive') {
    return {
      ok: true,
      type: 'win',
      market: parts[0],
      strategyFamily: parts[1],
      exitReason: parts.slice(2, -1).join(':') || 'any',
      regime: parts[parts.length - 1] || 'any',
    };
  }

  if (direction === 'negative' && parts.length >= 5) {
    return {
      ok: true,
      type: 'loss',
      market: parts[0],
      reasonCode: parts[1],
      patternType: parts[2],
      regime: parts[3] || 'any',
      strategyFamily: parts.slice(4).join(':') || 'any',
    };
  }

  return { ok: false, type: 'unknown', reason: `unsupported_direction:${baseAdjustmentType}` };
}

function matchesOptional(actual: unknown, expected: unknown): boolean {
  const exp = String(expected || '').trim();
  if (!exp || exp === 'any' || exp === 'all') return true;
  return String(actual || '').trim() === exp;
}

function tradeMatchesPattern(trade: any, parsed: any): boolean {
  if (!parsed?.ok) return false;
  if (!matchesOptional(trade.market, parsed.market)) return false;

  if (parsed.type === 'win') {
    return matchesOptional(trade.strategy_family, parsed.strategyFamily)
      && matchesOptional(trade.exit_reason, parsed.exitReason)
      && matchesOptional(trade.market_regime, parsed.regime);
  }

  if (parsed.type === 'loss') {
    const classified = classifyLossReason(trade);
    return classified.reasonCode === parsed.reasonCode
      && classified.patternType === parsed.patternType
      && matchesOptional(trade.market_regime, parsed.regime)
      && matchesOptional(trade.strategy_family, parsed.strategyFamily);
  }

  return false;
}

async function ensureEvalTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_eval (
      id                   BIGSERIAL PRIMARY KEY,
      shadow_id            BIGINT REFERENCES investment.luna_vault_shadow_adjustments(id) ON DELETE CASCADE,
      pattern_key          TEXT NOT NULL,
      market               TEXT,
      regime               TEXT,
      eval_window_start    BIGINT NOT NULL,
      eval_window_end      BIGINT NOT NULL,
      post_trade_count     INTEGER NOT NULL DEFAULT 0,
      post_avg_pnl         DOUBLE PRECISION,
      base_adjustment_type TEXT NOT NULL,
      vault_shadow_type    TEXT,
      base_correct         BOOLEAN,
      vault_correct        BOOLEAN,
      evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (shadow_id, eval_window_start, eval_window_end)
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_pattern ON investment.luna_vault_shadow_eval (pattern_key, evaluated_at DESC)`).catch(() => null);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_evaluated ON investment.luna_vault_shadow_eval (evaluated_at DESC)`).catch(() => null);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_market ON investment.luna_vault_shadow_eval (market, evaluated_at DESC)`).catch(() => null);
}

async function fetchShadowRows(limit: number) {
  return db.query(`
    SELECT id, pattern_key, market, regime, base_adjustment_type, vault_shadow_type, created_at
      FROM investment.luna_vault_shadow_adjustments
     ORDER BY created_at DESC, id DESC
     LIMIT $1
  `, [limit]);
}

async function fetchTradesInWindow(startMs: number, endMs: number) {
  return db.query(`
    SELECT tj.trade_id, tj.signal_id, tj.market, tj.symbol, tj.direction,
           tj.pnl_net, tj.pnl_percent, tj.exit_reason, tj.market_regime,
           tj.strategy_family, tj.strategy_quality, tj.strategy_route,
           tj.entry_time, tj.exit_time, tj.created_at,
           s.strategy_family AS signal_strategy_family,
           s.strategy_quality AS signal_strategy_quality,
           s.strategy_route AS signal_strategy_route
      FROM investment.trade_journal tj
      LEFT JOIN investment.signals s ON s.id = tj.signal_id
     WHERE COALESCE(tj.exit_time, tj.created_at, tj.entry_time) > $1
       AND COALESCE(tj.exit_time, tj.created_at, tj.entry_time) <= $2
       AND tj.pnl_net IS NOT NULL
       AND COALESCE(tj.exclude_from_learning, false) IS FALSE
     ORDER BY COALESCE(tj.exit_time, tj.created_at, tj.entry_time) ASC
  `, [startMs, endMs]);
}

async function persistEval(row: any) {
  await db.run(`
    INSERT INTO investment.luna_vault_shadow_eval
      (shadow_id, pattern_key, market, regime, eval_window_start, eval_window_end,
       post_trade_count, post_avg_pnl, base_adjustment_type, vault_shadow_type,
       base_correct, vault_correct, metadata, evaluated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW())
    ON CONFLICT (shadow_id, eval_window_start, eval_window_end) DO UPDATE SET
      post_trade_count = EXCLUDED.post_trade_count,
      post_avg_pnl = EXCLUDED.post_avg_pnl,
      base_adjustment_type = EXCLUDED.base_adjustment_type,
      vault_shadow_type = EXCLUDED.vault_shadow_type,
      base_correct = EXCLUDED.base_correct,
      vault_correct = EXCLUDED.vault_correct,
      metadata = EXCLUDED.metadata,
      evaluated_at = NOW()
  `, [
    row.shadowId,
    row.patternKey,
    row.market,
    row.regime,
    row.windowStartMs,
    row.windowEndMs,
    row.postTradeCount,
    row.postAvgPnl,
    row.baseAdjustmentType,
    row.vaultShadowType,
    row.baseCorrect,
    row.vaultCorrect,
    JSON.stringify(row.metadata || {}),
  ]);
}

export async function evaluateVaultShadowOutcomes({
  windowDays = 14,
  limit = 200,
  write = false,
} = {}) {
  const safeWindowDays = Math.floor(boundedNumber(windowDays, 14, 1, 90));
  const safeLimit = Math.floor(boundedNumber(limit, 200, 1, 1000));
  const shadowRows = await fetchShadowRows(safeLimit);
  const evalRows = [];
  let mappable = 0;
  let withPostTrades = 0;

  for (const shadow of shadowRows) {
    const createdAtMs = new Date(shadow.created_at).getTime();
    const windowStartMs = createdAtMs;
    const windowEndMs = createdAtMs + safeWindowDays * MS_PER_DAY;
    const parsed = parsePattern(shadow.pattern_key, shadow.base_adjustment_type);
    if (parsed.ok) mappable += 1;

    const trades = parsed.ok ? await fetchTradesInWindow(windowStartMs, windowEndMs) : [];
    const matchedTrades = trades.filter((trade: any) => tradeMatchesPattern(trade, parsed));
    if (matchedTrades.length > 0) withPostTrades += 1;
    const pnlValues = matchedTrades
      .map((trade: any) => Number(trade.pnl_net))
      .filter((value: number) => Number.isFinite(value));
    const postAvgPnl = pnlValues.length
      ? pnlValues.reduce((sum: number, value: number) => sum + value, 0) / pnlValues.length
      : null;

    const evalRow = {
      shadowId: Number(shadow.id),
      patternKey: shadow.pattern_key,
      market: shadow.market,
      regime: shadow.regime,
      windowStartMs,
      windowEndMs,
      postTradeCount: pnlValues.length,
      postAvgPnl,
      baseAdjustmentType: shadow.base_adjustment_type,
      vaultShadowType: shadow.vault_shadow_type,
      baseCorrect: correctness(shadow.base_adjustment_type, postAvgPnl),
      vaultCorrect: correctness(shadow.vault_shadow_type, postAvgPnl),
      metadata: {
        matchingMethod: 'pattern_extractor_replay',
        parsedPattern: parsed,
        futureLeakageGuard: 'trade_ts_ms > shadow.created_at_ms AND <= eval_window_end',
        sampleTrades: matchedTrades.slice(0, 5).map((trade: any) => ({
          tradeId: trade.trade_id,
          symbol: trade.symbol,
          market: trade.market,
          strategyFamily: trade.strategy_family,
          exitReason: trade.exit_reason,
          marketRegime: trade.market_regime,
          pnlNet: trade.pnl_net,
          tradeTs: trade.exit_time || trade.created_at || trade.entry_time,
        })),
      },
    };
    evalRows.push(evalRow);
    if (write) await persistEval(evalRow);
  }

  const scored = evalRows.filter((row) => row.baseCorrect != null || row.vaultCorrect != null);
  const baseScored = evalRows.filter((row) => row.baseCorrect != null);
  const vaultScored = evalRows.filter((row) => row.vaultCorrect != null);
  const baseHitRate = baseScored.length
    ? baseScored.filter((row) => row.baseCorrect === true).length / baseScored.length
    : null;
  const vaultHitRate = vaultScored.length
    ? vaultScored.filter((row) => row.vaultCorrect === true).length / vaultScored.length
    : null;

  return {
    ok: true,
    write,
    windowDays: safeWindowDays,
    shadowRows: shadowRows.length,
    mappablePatterns: mappable,
    mappingRate: shadowRows.length ? Number((mappable / shadowRows.length).toFixed(4)) : null,
    patternsWithPostTrades: withPostTrades,
    postTradeMappingRate: shadowRows.length ? Number((withPostTrades / shadowRows.length).toFixed(4)) : null,
    evaluatedRows: evalRows.length,
    scoredRows: scored.length,
    baseHitRate: baseHitRate == null ? null : Number(baseHitRate.toFixed(4)),
    vaultHitRate: vaultHitRate == null ? null : Number(vaultHitRate.toFixed(4)),
    lift: baseHitRate == null || vaultHitRate == null ? null : Number((vaultHitRate - baseHitRate).toFixed(4)),
    rows: evalRows,
    matchingMethod: {
      selected: 'b',
      reason: 'signals has strategy_family but no phase; trade_journal has strategy_family/exit_reason/market_regime, so win/loss pattern extractor keys are replayed conservatively.',
    },
    safety: {
      readOnlyTables: ['investment.trade_journal', 'investment.signals', 'investment.luna_vault_shadow_adjustments', 'investment.luna_loss_patterns', 'investment.luna_win_patterns', 'investment.agent_curriculum_state'],
      writeTableOnly: write ? 'investment.luna_vault_shadow_eval' : null,
      liveTradeImpact: false,
    },
  };
}

export async function buildVaultShadowEvalReport({ limit = 500 } = {}) {
  const safeLimit = Math.floor(boundedNumber(limit, 500, 1, 5000));
  const rows = await db.query(`
    SELECT *
      FROM investment.luna_vault_shadow_eval
     ORDER BY evaluated_at DESC, id DESC
     LIMIT $1
  `, [safeLimit]).catch(() => []);

  function summarize(groupRows: any[]) {
    const baseScored = groupRows.filter((row) => row.base_correct != null);
    const vaultScored = groupRows.filter((row) => row.vault_correct != null);
    const baseHitRate = baseScored.length
      ? baseScored.filter((row) => row.base_correct === true).length / baseScored.length
      : null;
    const vaultHitRate = vaultScored.length
      ? vaultScored.filter((row) => row.vault_correct === true).length / vaultScored.length
      : null;
    return {
      sampleCount: groupRows.length,
      postTradeRows: groupRows.filter((row) => Number(row.post_trade_count || 0) > 0).length,
      baseScored: baseScored.length,
      vaultScored: vaultScored.length,
      baseHitRate: baseHitRate == null ? null : Number(baseHitRate.toFixed(4)),
      vaultHitRate: vaultHitRate == null ? null : Number(vaultHitRate.toFixed(4)),
      lift: baseHitRate == null || vaultHitRate == null ? null : Number((vaultHitRate - baseHitRate).toFixed(4)),
    };
  }

  const byMarket: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.market || 'unknown';
    if (!byMarket[key]) byMarket[key] = [];
    (byMarket[key] as any[]).push(row);
  }

  const byDirection: Record<string, unknown> = {};
  for (const row of rows) {
    const key = adjustmentDirection(row.vault_shadow_type) || 'none';
    if (!byDirection[key]) byDirection[key] = [];
    (byDirection[key] as any[]).push(row);
  }

  return {
    ok: true,
    totalRows: rows.length,
    overall: summarize(rows),
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([key, value]) => [key, summarize(value as any[])])),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([key, value]) => [key, summarize(value as any[])])),
    generatedAt: new Date().toISOString(),
  };
}

export default { evaluateVaultShadowOutcomes, buildVaultShadowEvalReport };

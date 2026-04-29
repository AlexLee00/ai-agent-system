// @ts-nocheck
import { query, run, get } from './core.ts';

export async function upsertStrategy(s) {
  await run(`
    INSERT INTO strategy_pool
      (strategy_name, market, source, source_url,
       entry_condition, exit_condition, risk_management,
       applicable_timeframe, quality_score, summary, applicable_now, collected_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT (strategy_name) DO UPDATE SET
      quality_score        = EXCLUDED.quality_score,
      summary              = EXCLUDED.summary,
      applicable_now       = EXCLUDED.applicable_now,
      collected_at         = EXCLUDED.collected_at
  `, [
    s.strategy_name, s.market, s.source ?? null, s.source_url ?? null,
    s.entry_condition ?? null, s.exit_condition ?? null, s.risk_management ?? null,
    s.applicable_timeframe ?? null, s.quality_score ?? 0, s.summary ?? null,
    s.applicable_now !== false,
  ]);
}

export async function getActiveStrategies(market = 'all', limit = 5) {
  const normalizedMarket = ['all', 'crypto', 'stocks'].includes(String(market)) ? String(market) : 'all';
  const normalizedLimit = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 5));

  return query(
    `
      SELECT * FROM strategy_pool
      WHERE applicable_now = true
        AND quality_score >= 0.6
        AND collected_at > now() - INTERVAL '7 days'
        AND ($1 = 'all' OR market = $1 OR market = 'all')
      ORDER BY quality_score DESC
      LIMIT $2
    `,
    [normalizedMarket, normalizedLimit],
  );
}

export async function recordStrategyResult(strategyName, won) {
  await run(`
    UPDATE strategy_pool
    SET applied_count = applied_count + 1,
        win_rate = (COALESCE(win_rate, 0.5) * applied_count + $1) / (applied_count + 1)
    WHERE strategy_name = $2
  `, [won ? 1 : 0, strategyName]);
}

export async function getLatestVectorbtBacktestForSymbol(symbol, days = 120) {
  if (!symbol) return null;
  return get(
    `SELECT symbol, days, tp_pct, sl_pct, label, status, sharpe, total_return, max_drawdown, win_rate, total_trades, metadata, created_at
     FROM vectorbt_backtest_runs
     WHERE symbol = $1
       AND created_at > now() - ($2::int || ' days')::interval
     ORDER BY created_at DESC
     LIMIT 1`,
    [symbol, days],
  );
}

export async function getLatestMarketRegimeSnapshot(market) {
  if (!market) return null;
  return get(
    `SELECT id, market, regime, confidence, indicators, captured_at
     FROM market_regime_snapshots
     WHERE market = $1
     ORDER BY captured_at DESC
     LIMIT 1`,
    [market],
  );
}

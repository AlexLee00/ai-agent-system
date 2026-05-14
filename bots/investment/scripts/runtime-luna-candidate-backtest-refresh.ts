#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ensureCandidateBacktestSchema, evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';

const SHADOW_MODE = process.env.LUNA_CANDIDATE_BACKTEST_SHADOW_MODE !== 'false';
const STALE_HOURS = Number(process.env.LUNA_BACKTEST_STALE_HOURS || 24);

const GATE = {
  MIN_SHARPE: 0,
  MAX_DRAWDOWN: 30,
  MIN_WIN_RATE: 30,
  STALE_HOURS,
};

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function periodsFrom(value: any) {
  return String(value || '30,90,180')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

async function getActiveCandidates(limit = 100) {
  return db.query(
    `SELECT DISTINCT symbol, market
       FROM candidate_universe
      WHERE expires_at > NOW()
        AND market = 'crypto'
      ORDER BY symbol ASC
      LIMIT $1`,
    [limit],
  ).catch(() => []);
}

async function getBacktestStatus(symbol: string, market: string) {
  return db.get(
    `SELECT fresh, healthy, last_backtest_at, gate_status, sharpe, max_drawdown, win_rate, would_block
       FROM candidate_backtest_status
      WHERE symbol = $1 AND market = $2`,
    [symbol, market],
  ).catch(() => null);
}

function isStale(lastBacktestAt: Date | string | null): boolean {
  if (!lastBacktestAt) return true;
  const ageMs = Date.now() - new Date(lastBacktestAt).getTime();
  return ageMs > GATE.STALE_HOURS * 3600 * 1000;
}

function safeNum(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function evaluateQuality(rows: any[]) {
  const usable = (rows || []).filter((r) => (!r?.status || r.status === 'ok') && safeNum(r?.total_trades) > 0);
  if (usable.length === 0) {
    return {
      sharpe: null,
      maxDrawdown: null,
      winRate: null,
      healthy: false,
      gateStatus: 'would_block_no_data',
      wouldBlock: true,
      reasons: ['backtest_no_data'],
    };
  }

  const avgSharpe = usable.reduce((s, r) => s + safeNum(r?.sharpe_ratio), 0) / usable.length;
  const maxDD = Math.max(...usable.map((r) => Math.abs(safeNum(r?.max_drawdown))));
  const avgWinRate = usable.reduce((s, r) => s + safeNum(r?.win_rate), 0) / usable.length;
  const reasons: string[] = [];
  if (avgSharpe < GATE.MIN_SHARPE) reasons.push(`sharpe_negative(${avgSharpe.toFixed(2)})`);
  if (maxDD > GATE.MAX_DRAWDOWN) reasons.push(`drawdown_high(${maxDD.toFixed(1)}%)`);
  if (avgWinRate < GATE.MIN_WIN_RATE) reasons.push(`win_rate_low(${avgWinRate.toFixed(1)}%)`);

  const wouldBlock = reasons.some((r) => r.startsWith('sharpe_') || r.startsWith('win_rate_'));
  return {
    sharpe: Number(avgSharpe.toFixed(4)),
    maxDrawdown: Number(maxDD.toFixed(4)),
    winRate: Number(avgWinRate.toFixed(4)),
    healthy: !wouldBlock,
    gateStatus: wouldBlock ? 'would_block_unhealthy' : 'pass',
    wouldBlock,
    reasons,
  };
}

function fixtureRows(symbol: string) {
  if (symbol.includes('NEG')) {
    return [{ status: 'ok', total_trades: 12, sharpe_ratio: -0.7, max_drawdown: 18, win_rate: 24 }];
  }
  return [{ status: 'ok', total_trades: 18, sharpe_ratio: 1.15, max_drawdown: 12, win_rate: 48 }];
}

async function upsertStatus(symbol: string, market: string, payload: any, dryRun = false) {
  if (dryRun) return;
  const nextRefreshAt = new Date(Date.now() + GATE.STALE_HOURS * 3600 * 1000).toISOString();
  await db.run(`
    INSERT INTO candidate_backtest_status
      (symbol, market, fresh, healthy, sharpe, max_drawdown, win_rate,
       last_backtest_at, next_refresh_at, gate_status, would_block, enforced,
       block_reasons, backtest_run_metadata, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12::jsonb,$13::jsonb,NOW())
    ON CONFLICT (symbol, market) DO UPDATE SET
      fresh = EXCLUDED.fresh,
      healthy = EXCLUDED.healthy,
      sharpe = EXCLUDED.sharpe,
      max_drawdown = EXCLUDED.max_drawdown,
      win_rate = EXCLUDED.win_rate,
      last_backtest_at = NOW(),
      next_refresh_at = EXCLUDED.next_refresh_at,
      gate_status = EXCLUDED.gate_status,
      would_block = EXCLUDED.would_block,
      enforced = EXCLUDED.enforced,
      block_reasons = EXCLUDED.block_reasons,
      backtest_run_metadata = EXCLUDED.backtest_run_metadata,
      updated_at = NOW()
  `, [
    symbol,
    market,
    payload.fresh,
    payload.healthy,
    payload.sharpe,
    payload.maxDrawdown,
    payload.winRate,
    nextRefreshAt,
    payload.gateStatus,
    payload.wouldBlock,
    false,
    JSON.stringify(payload.reasons || []),
    JSON.stringify({
      reasons: payload.reasons,
      periods: payload.periods,
      rowsByPeriod: payload.rowsByPeriod,
      shadowMode: SHADOW_MODE,
      qualityGate: GATE,
    }),
  ]);
}

async function recordPredictiveAudit(symbol: string, market: string, payload: any, dryRun = false) {
  if (dryRun) return;
  await db.run(`
    INSERT INTO predictive_validation_log
      (symbol, market, decision, score, threshold, component_coverage,
       blocked_reason, components, missing_components, candidate_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
  `, [
    symbol,
    market,
    payload.wouldBlock ? 'would_block_backtest' : 'pass_backtest',
    payload.sharpe,
    0,
    null,
    payload.reasons?.join(',') || null,
    JSON.stringify({ backtest: { fresh: payload.fresh, healthy: payload.healthy, sharpe: payload.sharpe } }),
    JSON.stringify([]),
    JSON.stringify({ symbol, market, gateStatus: payload.gateStatus, shadowMode: SHADOW_MODE }),
  ]).catch(() => null);
}

async function refreshCandidate(symbol: string, market: string, periods: number[], options: any = {}) {
  const { dryRun = false, fixture = false } = options;
  const existing = await getBacktestStatus(symbol, market);
  if (!fixture && existing && !isStale(existing.last_backtest_at)) {
    return {
      symbol,
      market,
      skipped: true,
      gateStatus: existing.gate_status,
      healthy: existing.healthy,
      fresh: true,
      wouldBlock: existing.would_block === true,
      reasons: [],
      error: null,
    };
  }

  try {
    const rowsByPeriod: any = {};
    const allRows = [];
    for (const days of periods) {
      const rows = fixture ? fixtureRows(symbol) : runVectorBtGrid(symbol, days);
      if (Array.isArray(rows)) {
        rowsByPeriod[String(days)] = rows;
        allRows.push(...rows.map((row) => ({ ...row, walk_forward_days: days })));
      }
    }
    const quality = evaluateQuality(allRows);
    const payload = { fresh: true, ...quality, periods, rowsByPeriod };
    await upsertStatus(symbol, market, payload, dryRun);
    await recordPredictiveAudit(symbol, market, payload, dryRun);
    return {
      symbol,
      market,
      skipped: false,
      gateStatus: quality.gateStatus,
      healthy: quality.healthy,
      fresh: true,
      wouldBlock: quality.wouldBlock,
      reasons: quality.reasons,
      error: null,
    };
  } catch (error) {
    const errMsg = String(error?.message || error);
    const payload = {
      fresh: false,
      healthy: false,
      sharpe: null,
      maxDrawdown: null,
      winRate: null,
      gateStatus: 'would_block_error',
      wouldBlock: true,
      reasons: [errMsg],
      periods,
      rowsByPeriod: {},
    };
    await upsertStatus(symbol, market, payload, dryRun).catch(() => null);
    await recordPredictiveAudit(symbol, market, payload, dryRun).catch(() => null);
    return { symbol, market, skipped: false, gateStatus: 'would_block_error', healthy: false, fresh: false, wouldBlock: true, reasons: [errMsg], error: errMsg };
  }
}

export async function runCandidateBacktestRefresh(options: any = {}): Promise<any> {
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const periods = periodsFrom(options.periods);
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100));
  if (!dryRun) {
    await db.initSchema();
    await ensureCandidateBacktestSchema();
  }

  const candidates = fixture
    ? [{ symbol: 'BTC/USDT', market: 'crypto' }, { symbol: 'NEG/USDT', market: 'crypto' }]
    : await getActiveCandidates(limit);

  if (!json) console.log(`[luna-backtest-refresh] 활성 후보 ${candidates.length}건 (shadow=${SHADOW_MODE}, dryRun=${dryRun})`);

  const results = [];
  for (const { symbol, market } of candidates) {
    const result = await refreshCandidate(symbol, market, periods, { dryRun, fixture });
    results.push(result);
    if (!json) {
      const icon = result.skipped ? 'skip' : result.wouldBlock ? 'would-block' : 'pass';
      console.log(`[luna-backtest-refresh] ${icon} ${symbol} gate=${result.gateStatus}`);
    }
  }

  const passed = results.filter((r) => r.gateStatus === 'pass').length;
  const wouldBlocked = results.filter((r) => r.wouldBlock || String(r.gateStatus).startsWith('would_block')).length;
  const skipped = results.filter((r) => r.skipped).length;
  const payload = {
    ok: true,
    shadowMode: SHADOW_MODE,
    dryRun,
    fixture,
    periods,
    total: results.length,
    passed,
    wouldBlocked,
    skipped,
    gateThresholds: GATE,
    results,
  };

  if (!json) console.log(`[luna-backtest-refresh] 완료: pass=${passed} wouldBlock=${wouldBlocked} skip=${skipped}`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

export { evaluateCandidateBacktestStatus };

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCandidateBacktestRefresh({
      periods: argValue('periods', argValue('days', '30,90,180')),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100)),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      json: hasFlag('json'),
    }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: 'runtime-luna-candidate-backtest-refresh error:',
  });
}

#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const SHADOW_MODE = process.env.LUNA_CANDIDATE_BACKTEST_SHADOW_MODE !== 'false';
const STALE_HOURS = Number(process.env.LUNA_BACKTEST_STALE_HOURS || 24);

// Quality Gate 기준 (Entry 차단 임계값)
const GATE = {
  MIN_SHARPE: 0,         // avg_sharpe < 0 → entry 차단
  MAX_DRAWDOWN: 30,      // max_drawdown > 30% → 경고
  MIN_WIN_RATE: 30,      // win_rate < 30% → 제외
  STALE_HOURS,
};

async function ensureSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS candidate_backtest_status (
      id                    BIGSERIAL PRIMARY KEY,
      symbol                TEXT NOT NULL,
      market                TEXT NOT NULL,
      fresh                 BOOLEAN DEFAULT FALSE,
      healthy               BOOLEAN DEFAULT FALSE,
      sharpe                DOUBLE PRECISION,
      max_drawdown          DOUBLE PRECISION,
      win_rate              DOUBLE PRECISION,
      last_backtest_at      TIMESTAMPTZ,
      next_refresh_at       TIMESTAMPTZ,
      gate_status           TEXT DEFAULT 'pending',
      backtest_run_metadata JSONB DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (symbol, market)
    )
  `);
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_cbs_gate   ON candidate_backtest_status(gate_status, fresh, healthy)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_cbs_symbol ON candidate_backtest_status(symbol, market)`);
  } catch { /* 무시 */ }

  await db.run(`
    CREATE TABLE IF NOT EXISTS predictive_validation_log (
      id                  BIGSERIAL PRIMARY KEY,
      symbol              TEXT,
      market              TEXT,
      decision            TEXT NOT NULL,
      score               DOUBLE PRECISION,
      threshold           DOUBLE PRECISION,
      component_coverage  DOUBLE PRECISION,
      blocked_reason      TEXT,
      components          JSONB DEFAULT '{}'::jsonb,
      missing_components  JSONB DEFAULT '[]'::jsonb,
      candidate_snapshot  JSONB DEFAULT '{}'::jsonb,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_pvl_symbol   ON predictive_validation_log(symbol, market, created_at DESC)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_pvl_decision ON predictive_validation_log(decision, created_at DESC)`);
  } catch { /* 무시 */ }
}

async function getActiveCandidates() {
  return db.query(
    `SELECT DISTINCT symbol, market
       FROM candidate_universe
      WHERE expires_at > NOW()
        AND market = 'crypto'
      ORDER BY score DESC
      LIMIT 20`,
  ).catch(() => []);
}

async function getBacktestStatus(symbol: string, market: string) {
  return db.get(
    `SELECT fresh, healthy, last_backtest_at, gate_status, sharpe, max_drawdown, win_rate
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

function evaluateQuality(rows: any[]): {
  sharpe: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  healthy: boolean;
  gateStatus: string;
  reasons: string[];
} {
  const usable = (rows || []).filter(r => (!r?.status || r.status === 'ok') && safeNum(r?.total_trades) > 0);
  if (usable.length === 0) {
    return { sharpe: null, maxDrawdown: null, winRate: null, healthy: false, gateStatus: 'block_no_data', reasons: ['백테스트 결과 없음'] };
  }

  const avgSharpe = usable.reduce((s, r) => s + safeNum(r?.sharpe_ratio), 0) / usable.length;
  const maxDD = Math.max(...usable.map(r => Math.abs(safeNum(r?.max_drawdown))));
  const avgWinRate = usable.reduce((s, r) => s + safeNum(r?.win_rate), 0) / usable.length;

  const reasons: string[] = [];
  if (avgSharpe < GATE.MIN_SHARPE) reasons.push(`sharpe_negative(${avgSharpe.toFixed(2)})`);
  if (maxDD > GATE.MAX_DRAWDOWN) reasons.push(`drawdown_high(${maxDD.toFixed(1)}%)`);
  if (avgWinRate < GATE.MIN_WIN_RATE) reasons.push(`win_rate_low(${avgWinRate.toFixed(1)}%)`);

  const healthy = reasons.filter(r => r.startsWith('sharpe_') || r.startsWith('win_rate_')).length === 0;
  const gateStatus = healthy ? 'pass' : 'block_unhealthy';

  return {
    sharpe: Number(avgSharpe.toFixed(4)),
    maxDrawdown: Number(maxDD.toFixed(4)),
    winRate: Number(avgWinRate.toFixed(4)),
    healthy,
    gateStatus,
    reasons,
  };
}

async function upsertStatus(symbol: string, market: string, payload: any) {
  const nextRefreshAt = new Date(Date.now() + GATE.STALE_HOURS * 3600 * 1000).toISOString();
  await db.run(`
    INSERT INTO candidate_backtest_status
      (symbol, market, fresh, healthy, sharpe, max_drawdown, win_rate,
       last_backtest_at, next_refresh_at, gate_status, backtest_run_metadata, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10::jsonb,NOW())
    ON CONFLICT (symbol, market) DO UPDATE SET
      fresh = EXCLUDED.fresh,
      healthy = EXCLUDED.healthy,
      sharpe = EXCLUDED.sharpe,
      max_drawdown = EXCLUDED.max_drawdown,
      win_rate = EXCLUDED.win_rate,
      last_backtest_at = NOW(),
      next_refresh_at = EXCLUDED.next_refresh_at,
      gate_status = EXCLUDED.gate_status,
      backtest_run_metadata = EXCLUDED.backtest_run_metadata,
      updated_at = NOW()
  `, [
    symbol, market,
    payload.fresh,
    payload.healthy,
    payload.sharpe,
    payload.maxDrawdown,
    payload.winRate,
    nextRefreshAt,
    payload.gateStatus,
    JSON.stringify({ reasons: payload.reasons, days: payload.days, shadowMode: SHADOW_MODE }),
  ]);
}

async function refreshCandidate(symbol: string, market: string, days = 30): Promise<{
  symbol: string;
  market: string;
  skipped: boolean;
  gateStatus: string;
  healthy: boolean;
  fresh: boolean;
  reasons: string[];
  error: string | null;
}> {
  try {
    const existing = await getBacktestStatus(symbol, market);
    if (existing && !isStale(existing.last_backtest_at)) {
      return { symbol, market, skipped: true, gateStatus: existing.gate_status, healthy: existing.healthy, fresh: true, reasons: [], error: null };
    }

    // extract ticker for vectorbt (BTC/USDT → BTC/USDT)
    const raw = runVectorBtGrid(symbol, days);
    if (!Array.isArray(raw)) {
      await upsertStatus(symbol, market, { fresh: false, healthy: false, sharpe: null, maxDrawdown: null, winRate: null, gateStatus: 'block_error', reasons: ['vectorbt 실행 실패'], days });
      return { symbol, market, skipped: false, gateStatus: 'block_error', healthy: false, fresh: false, reasons: ['vectorbt 실행 실패'], error: 'vectorbt_failed' };
    }

    const quality = evaluateQuality(raw);
    const payload = { fresh: true, ...quality, days };
    await upsertStatus(symbol, market, payload);

    return { symbol, market, skipped: false, gateStatus: quality.gateStatus, healthy: quality.healthy, fresh: true, reasons: quality.reasons, error: null };
  } catch (err) {
    const errMsg = String(err?.message || err);
    await upsertStatus(symbol, market, { fresh: false, healthy: false, sharpe: null, maxDrawdown: null, winRate: null, gateStatus: 'block_error', reasons: [errMsg], days }).catch(() => null);
    return { symbol, market, skipped: false, gateStatus: 'block_error', healthy: false, fresh: false, reasons: [errMsg], error: errMsg };
  }
}

export async function runCandidateBacktestRefresh({ days = 30, json = false } = {}): Promise<any> {
  await db.initSchema();
  await ensureSchema();

  const candidates = await getActiveCandidates();
  console.log(`[luna-backtest-refresh] 활성 후보 ${candidates.length}건 (shadow=${SHADOW_MODE})`);

  const results = [];
  for (const { symbol, market } of candidates) {
    const result = await refreshCandidate(symbol, market, days);
    results.push(result);
    const icon = result.skipped ? '⏭' : result.healthy ? '✅' : '🚫';
    console.log(`[luna-backtest-refresh] ${icon} ${symbol} gate=${result.gateStatus}`);
  }

  const passed = results.filter(r => r.gateStatus === 'pass').length;
  const blocked = results.filter(r => r.gateStatus.startsWith('block')).length;
  const skipped = results.filter(r => r.skipped).length;

  const payload = {
    ok: true,
    shadowMode: SHADOW_MODE,
    total: results.length,
    passed,
    blocked,
    skipped,
    gateThresholds: GATE,
    results,
  };

  console.log(`[luna-backtest-refresh] 완료: pass=${passed} block=${blocked} skip=${skipped}`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const days = Number(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 30);
      return runCandidateBacktestRefresh({ days, json: process.argv.includes('--json') });
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ runtime-luna-candidate-backtest-refresh 오류:',
  });
}

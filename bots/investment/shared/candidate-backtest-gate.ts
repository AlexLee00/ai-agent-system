// @ts-nocheck

import { get, run } from './db/core.ts';

const DISABLED = new Set(['0', 'false', 'off', 'disabled']);
const ENABLED = new Set(['1', 'true', 'on', 'enabled', 'yes']);

export function getCandidateBacktestGateMode(env = process.env) {
  const raw = String(env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE || 'shadow').trim().toLowerCase();
  if (DISABLED.has(raw)) return 'off';
  if (raw === 'enforce' || raw === 'hard' || raw === 'block') return 'enforce';
  return 'shadow';
}

export async function ensureCandidateBacktestSchema() {
  await run(`
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
      would_block           BOOLEAN DEFAULT FALSE,
      enforced              BOOLEAN DEFAULT FALSE,
      block_reasons         JSONB DEFAULT '[]'::jsonb,
      backtest_run_metadata JSONB DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (symbol, market)
    )
  `);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS would_block BOOLEAN DEFAULT FALSE`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS enforced BOOLEAN DEFAULT FALSE`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS block_reasons JSONB DEFAULT '[]'::jsonb`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS backtest_run_metadata JSONB DEFAULT '{}'::jsonb`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS sharpe_oos DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS sharpe_is DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS sharpe_oos_deflated DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS overfit_gap DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS n_grid_trials INT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS walk_forward_sharpe DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS n_obs_oos INT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS total_trades_oos INT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS oos_status TEXT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS selection_method TEXT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS fold_count INT`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS trial_sharpes JSONB`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS var_sharpe DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS oos_returns_skew DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS oos_returns_kurt DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS oos_bars INTEGER`);
  // Phase 1b: 정통 DSR/PSR 컬럼 (SHADOW — 기존 컬럼/판정 불변)
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS dsr DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS psr DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS sr0 DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS sr_oos_unann DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS periods_per_year DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS pbo DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS perf_degradation DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS prob_loss DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS dominance_first_order BOOLEAN`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS pbo_n_blocks INTEGER`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS pbo_n_combinations INTEGER`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS meta_label_dist JSONB`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS meta_label_pos_rate DOUBLE PRECISION`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS meta_label_n_trades INTEGER`);
  await run(`ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS meta_label_method TEXT`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cbs_gate ON candidate_backtest_status(gate_status, fresh, healthy)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cbs_symbol ON candidate_backtest_status(symbol, market)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cbs_would_block ON candidate_backtest_status(would_block, updated_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cbs_oos_deflated ON candidate_backtest_status(sharpe_oos_deflated DESC NULLS LAST, updated_at DESC)`);

  await run(`
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
  await run(`CREATE INDEX IF NOT EXISTS idx_pvl_symbol ON predictive_validation_log(symbol, market, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pvl_decision ON predictive_validation_log(decision, created_at DESC)`);
}

function normalizeMarket(market = '') {
  const value = String(market || '').trim().toLowerCase();
  if (value === 'binance') return 'crypto';
  if (value === 'kis') return 'domestic';
  if (value === 'kis_overseas') return 'overseas';
  return value || 'crypto';
}

function normalizeSymbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

function parseReasons(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envNumber(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function reliabilitySharpe(row = null) {
  return finiteNumber(row?.sharpe_oos_deflated ?? row?.sharpe_oos ?? row?.sharpe, null);
}

export function evaluateCandidateBacktestStatus(row = null, env = process.env) {
  const mode = getCandidateBacktestGateMode(env);
  if (mode === 'off') {
    return { ok: true, mode, blocked: false, wouldBlock: false, reason: null, row };
  }
  if (!row) {
    return {
      ok: mode !== 'enforce',
      mode,
      blocked: mode === 'enforce',
      wouldBlock: true,
      reason: 'candidate_backtest_missing',
      row: null,
    };
  }
  const fresh = row.fresh === true || String(row.fresh).toLowerCase() === 'true';
  const healthy = row.healthy === true || String(row.healthy).toLowerCase() === 'true';
  const maxDrawdown = Math.abs(Number(row.max_drawdown ?? row.maxDrawdown ?? 0));
  const maxDrawdownLimit = Number(env.LUNA_CANDIDATE_BACKTEST_MAX_DRAWDOWN || 30);
  const drawdownWouldBlock = Number.isFinite(maxDrawdown) && Number.isFinite(maxDrawdownLimit) && maxDrawdown > maxDrawdownLimit;

  // OOS 필드 — sharpe_oos_deflated 가 있으면 raw sharpe 대신 사용 (과적합 차단)
  const effectiveSharpe = reliabilitySharpe(row);
  const minSharpe = Number(env.LUNA_CANDIDATE_BACKTEST_MIN_SHARPE || 0);
  const sharpeWouldBlock = effectiveSharpe != null && Number.isFinite(minSharpe) && effectiveSharpe < minSharpe;
  const overfitGap = row.overfit_gap != null ? Number(row.overfit_gap) : null;
  const maxOverfitGap = Number(env.LUNA_BT_MAX_OVERFIT_GAP || 2.0);
  const overfitFlagged = overfitGap != null && Number.isFinite(overfitGap) && overfitGap > maxOverfitGap;

  // Phase 1b-2: DSR 게이트 (환경변수 기본 OFF — 마스터 명시적 활성화 필요)
  const dsrGateActive = ENABLED.has(String(env.LUNA_DSR_GATE_ENABLED || 'false').trim().toLowerCase());
  const dsrMin = envNumber(env.LUNA_DSR_MIN, 0.90);
  const dsrMinTrades = Math.max(1, Math.floor(envNumber(env.LUNA_DSR_MIN_TRADES, 30)));
  const dsr = row.dsr != null ? finiteNumber(row.dsr, null) : null;
  const totalTradesOos = row.total_trades_oos != null ? finiteNumber(row.total_trades_oos, null) : null;
  const insufficientTrades = totalTradesOos != null && totalTradesOos < dsrMinTrades;
  const dsrWouldBlock = dsrGateActive && dsr != null && (insufficientTrades || dsr < dsrMin);

  const wouldBlock = row.would_block === true || String(row.would_block).toLowerCase() === 'true' || !fresh || !healthy || drawdownWouldBlock || sharpeWouldBlock || dsrWouldBlock;
  const reasons = parseReasons(row.block_reasons);
  const gateStatus = String(row.gate_status || row.gateStatus || '').toLowerCase();
  const unstableBacktest = gateStatus.includes('unstable')
    || overfitFlagged
    || reasons.some((item) => String(item).startsWith('unrealistic_sharpe')
      || String(item).startsWith('backtest_unstable_sample')
      || String(item).startsWith('insufficient_oos_sample')
      || String(item).startsWith('overfit_gap_high'));
  const reason = !fresh
    ? 'candidate_backtest_stale'
    : unstableBacktest
      ? 'candidate_backtest_unstable'
    : sharpeWouldBlock
      ? 'candidate_backtest_sharpe_oos_deflated_low'
    : !healthy
      ? 'candidate_backtest_unhealthy'
      : drawdownWouldBlock
        ? 'candidate_backtest_drawdown_high'
        : dsrWouldBlock
          ? (insufficientTrades ? 'candidate_backtest_insufficient_trades' : 'candidate_backtest_dsr_low')
          : wouldBlock
            ? 'candidate_backtest_would_block'
          : null;
  const baseReasons = overfitFlagged && !reasons.some((item) => String(item).startsWith('overfit_gap_high'))
    ? [...reasons, `overfit_gap_high(${overfitGap!.toFixed(2)})`]
    : reasons;
  let effectiveReasons = baseReasons;
  if (drawdownWouldBlock && !effectiveReasons.some((item) => String(item).startsWith('drawdown_'))) {
    effectiveReasons = [...effectiveReasons, `drawdown_high(${maxDrawdown.toFixed(1)}%)`];
  }
  if (sharpeWouldBlock && !effectiveReasons.some((item) => String(item).startsWith('sharpe_oos_deflated_low'))) {
    effectiveReasons = [...effectiveReasons, `sharpe_oos_deflated_low(${effectiveSharpe.toFixed(2)}<${minSharpe})`];
  }
  if (dsrWouldBlock) {
    if (insufficientTrades && !effectiveReasons.some((item) => String(item).startsWith('candidate_backtest_insufficient_trades'))) {
      effectiveReasons = [...effectiveReasons, `candidate_backtest_insufficient_trades(${totalTradesOos}<${dsrMinTrades})`];
    }
    if (dsr < dsrMin && !effectiveReasons.some((item) => String(item).startsWith('candidate_backtest_dsr_low'))) {
      effectiveReasons = [...effectiveReasons, `candidate_backtest_dsr_low(${dsr.toFixed(4)}<${dsrMin})`];
    }
  }
  return {
    ok: mode !== 'enforce' || !wouldBlock,
    mode,
    blocked: mode === 'enforce' && wouldBlock,
    wouldBlock,
    reason,
    reasons: effectiveReasons,
    row,
  };
}

export async function getCandidateBacktestStatus(symbol, market) {
  if (!symbol) return null;
  return get(
    `SELECT *
       FROM candidate_backtest_status
      WHERE symbol = $1 AND market = $2
      ORDER BY updated_at DESC
      LIMIT 1`,
    [normalizeSymbol(symbol), normalizeMarket(market)],
  ).catch(() => null);
}

async function auditBacktestGate({ symbol, market, result, signal }) {
  if (!result?.wouldBlock) return;
  await run(`
    INSERT INTO predictive_validation_log
      (symbol, market, decision, score, threshold, component_coverage,
       blocked_reason, components, missing_components, candidate_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
  `, [
    symbol,
    market,
    result.blocked ? 'block_backtest_gate' : 'would_block_backtest_gate',
    reliabilitySharpe(result.row) ?? result.row?.sharpe ?? null,
    0,
    signal?.block_meta?.predictiveValidation?.componentCoverage ?? null,
    result.reason || result.reasons?.join(',') || 'candidate_backtest_gate',
    JSON.stringify({ backtest: result.row || null, sharpe_oos_deflated: result.row?.sharpe_oos_deflated ?? null }),
    JSON.stringify([]),
    JSON.stringify({ symbol, market, action: signal?.action || null, gateMode: result.mode }),
  ]).catch(() => null);
}

export async function evaluateCandidateBacktestEntryGate(signal = {}, env = process.env) {
  const mode = getCandidateBacktestGateMode(env);
  if (mode === 'off') return { ok: true, mode, blocked: false, wouldBlock: false, reason: null };
  const symbol = normalizeSymbol(signal.symbol);
  const market = normalizeMarket(signal.market || signal.exchange);
  const inline = signal?.block_meta?.candidateBacktestStatus || signal?.candidateBacktestStatus || null;
  const row = inline || await getCandidateBacktestStatus(symbol, market);
  const result = evaluateCandidateBacktestStatus(row, env);
  await auditBacktestGate({ symbol, market, result, signal });
  return result;
}

export default {
  ensureCandidateBacktestSchema,
  evaluateCandidateBacktestStatus,
  evaluateCandidateBacktestEntryGate,
  getCandidateBacktestGateMode,
};

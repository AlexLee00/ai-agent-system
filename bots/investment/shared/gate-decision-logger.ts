// @ts-nocheck
import { query as dbQuery } from './db/core.ts';

let gateDecisionLogTableEnsured = false;

function isTruthy(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeEntryTriggerMarket(exchange = 'binance') {
  const value = String(exchange || '').trim().toLowerCase();
  if (value === 'binance') return 'crypto';
  if (value === 'kis') return 'domestic';
  if (value === 'kis_overseas') return 'overseas';
  return value || 'crypto';
}

export async function ensureGateDecisionLogTable(queryFn = dbQuery) {
  if (gateDecisionLogTableEnsured) return;
  try {
    // Gate decision logging is advisory infrastructure. The migration is the SSOT;
    // this best-effort guard keeps hot-path inserts resilient if deploy order varies.
    await queryFn(`
      CREATE TABLE IF NOT EXISTS investment.gate_decision_log (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        evaluated_at timestamptz NOT NULL DEFAULT now(),
        exchange text NOT NULL,
        market text NOT NULL DEFAULT 'crypto',
        symbol text NOT NULL,
        gate_passed boolean NOT NULL,
        gate_status text,
        block_reasons jsonb DEFAULT '[]'::jsonb,
        dsr double precision,
        psr double precision,
        sharpe double precision,
        sharpe_oos double precision,
        win_rate double precision,
        max_drawdown double precision,
        walk_forward_sharpe double precision,
        decision_mode text,
        actually_fired boolean DEFAULT false,
        confidence double precision,
        signal_id text,
        trigger_type text,
        shadow_flags jsonb DEFAULT '{}'::jsonb
      )`);
    gateDecisionLogTableEnsured = true;
  } catch (error) {
    console.warn(`[GateDecisionLog] ensure table failed (ignored): ${error?.message || error}`);
  }
}

export function uniqueTextArray(values = []) {
  return [...new Set((values || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

export function backtestBlockReasons(backtest = null) {
  return uniqueTextArray(parseJsonMaybe(backtest?.blockReasons ?? backtest?.block_reasons, []));
}

export function resolveBacktestGatePassed(backtest = null) {
  if (!backtest) return false;
  const gateStatus = String(backtest.gateStatus ?? backtest.gate_status ?? '').trim().toLowerCase();
  if (isTruthy(backtest.wouldBlock ?? backtest.would_block)) return false;
  if (gateStatus.startsWith('would_block')) return false;
  if (backtestBlockReasons(backtest).length > 0) return false;
  return true;
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

export function buildGateDecisionShadowFlags(qualityGate = null, backtest = null) {
  const flags = {
    psrGate: backtest?.psrGate ?? backtest?.psr_gate,
    dsrGate: backtest?.dsrGate ?? backtest?.dsr_gate,
    shadowUnvalidated: backtest?.shadowUnvalidated ?? backtest?.shadow_unvalidated,
    dataIncomplete: backtest?.dataIncomplete,
    genuineFail: backtest?.genuineFail,
    universeBlock: backtest?.universeBlock,
    qualityGateOk: qualityGate?.ok,
    notifyMode: qualityGate?.notifyMode,
    hardBlock: qualityGate?.hardBlock,
  };
  return compactObject(flags);
}

export function signalIdFromTrigger(trigger = {}) {
  return trigger?.signal_id
    || trigger?.trigger_context?.signalId
    || trigger?.trigger_context?.signal_id
    || trigger?.trigger_meta?.signalId
    || trigger?.trigger_meta?.signal_id
    || null;
}

export function marketFromTrigger(trigger = {}, exchange = 'binance', context = {}) {
  return String(trigger?.market || trigger?.trigger_context?.market || context?.market || normalizeEntryTriggerMarket(exchange));
}

export async function logGateDecision(entry = {}, queryFn = dbQuery) {
  if (process.env.LUNA_GATE_DECISION_LOG_ENABLED === 'false') return;
  try {
    await ensureGateDecisionLogTable(queryFn);
    const bt = entry.backtest || {};
    await queryFn(
      `INSERT INTO investment.gate_decision_log
         (exchange, market, symbol, gate_passed, gate_status, block_reasons,
          dsr, psr, sharpe, sharpe_oos, win_rate, max_drawdown, walk_forward_sharpe,
          decision_mode, actually_fired, confidence, signal_id, trigger_type, shadow_flags)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
      [
        entry.exchange,
        entry.market || 'crypto',
        entry.symbol,
        entry.gatePassed === true,
        entry.gateStatus ?? null,
        JSON.stringify(Array.isArray(entry.blockReasons) ? entry.blockReasons : []),
        finiteOrNull(bt.dsr),
        finiteOrNull(bt.psr),
        finiteOrNull(bt.sharpe),
        finiteOrNull(bt.sharpeOos ?? bt.sharpe_oos),
        finiteOrNull(bt.winRate ?? bt.win_rate),
        finiteOrNull(bt.maxDrawdown ?? bt.max_drawdown),
        finiteOrNull(bt.walkForwardSharpe ?? bt.walk_forward_sharpe),
        entry.decisionMode ?? null,
        entry.actuallyFired === true,
        finiteOrNull(entry.confidence),
        entry.signalId ?? null,
        entry.triggerType ?? null,
        JSON.stringify(entry.shadowFlags || {}),
      ],
    );
  } catch (error) {
    console.warn(`[GateDecisionLog] insert failed (ignored) ${entry?.symbol || 'unknown'}: ${error?.message || error}`);
  }
}

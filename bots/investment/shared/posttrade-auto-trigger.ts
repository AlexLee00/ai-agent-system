// @ts-nocheck
/**
 * posttrade-auto-trigger — SELL 거래 감지 시 posttrade 파이프라인 자동 실행
 *
 * 파이프라인:
 *   1. realized PnL 계산 + 저장
 *   2. mapek_knowledge에 quality_evaluation_pending 이벤트 삽입
 *      → posttrade-feedback-worker가 polling 후 LLM 품질 평가 실행
 *   3. 손실 거래 → failed-signal-reflexion-trigger 호출
 *   4. 이익 거래 → posttrade-skill-extractor 호출 (dryRun 방지)
 */
import { run, get } from './db/core.ts';
import { computeAndPersistPnlForSymbol } from './realized-pnl-calculator.ts';
import { onSignalFailed } from './failed-signal-reflexion-trigger.ts';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

export function buildPosttradeAutoTrigger(trade = {}, opts = {}) {
  const side = String(trade.side || trade.action || '').toUpperCase();
  const closesPosition = side === 'SELL' || trade.closed === true || trade.closeout === true;
  const dryRun = opts.dryRun !== false;
  return {
    ok: true,
    dryRun,
    tradeId: trade.id ?? trade.tradeId ?? null,
    symbol: trade.symbol ?? null,
    closesPosition,
    shouldTrigger: closesPosition,
    pipeline: closesPosition
      ? ['realized_pnl', 'trade_quality_evaluator', 'reflexion_or_skill_extraction', 'agent_memory_write']
      : [],
    reasonCode: closesPosition ? 'closed_trade_detected' : 'not_a_close_trade',
  };
}

export function summarizePosttradeTriggers(trades = [], opts = {}) {
  const triggers = trades.map((trade) => buildPosttradeAutoTrigger(trade, opts));
  return {
    ok: true,
    total: triggers.length,
    triggerable: triggers.filter((item) => item.shouldTrigger).length,
    triggers,
  };
}

async function insertQualityEvaluationPending(tradeId, meta = {}) {
  if (!tradeId) return null;
  return run(
    `INSERT INTO mapek_knowledge
       (event_type, source, payload)
     VALUES ('quality_evaluation_pending', 'posttrade_auto_trigger', $1::jsonb)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify({ trade_id: String(tradeId), ...meta })],
  ).catch(() => null);
}

async function fetchSellTradeContext(tradeId) {
  if (!tradeId) return null;
  return get(
    `SELECT id, symbol, exchange, side, amount, price, signal_id, paper, trade_mode, executed_at
       FROM trades
      WHERE id = $1`,
    [String(tradeId)],
  ).catch(() => null);
}

/**
 * SELL 거래 1건에 대한 posttrade 파이프라인 실행.
 * dryRun=false + LUNA_POSTTRADE_AUTO_TRIGGER_ENABLED=true 일 때만 DB에 기록.
 */
export async function onTradeClosed(trade = {}, opts = {}) {
  const enabled = opts.force === true || boolEnv('LUNA_POSTTRADE_AUTO_TRIGGER_ENABLED', false);
  const dryRun = opts.dryRun !== false;
  const plan = buildPosttradeAutoTrigger(trade, { dryRun });

  if (!plan.shouldTrigger) {
    return { ok: true, status: 'skipped', reason: 'not_a_close_trade', plan };
  }

  const tradeId = plan.tradeId;
  if (!enabled) {
    return { ok: true, status: 'disabled', dryRun: true, plan };
  }

  // 1. Realized PnL 계산 + 저장
  let pnlResult = null;
  if (trade.symbol) {
    pnlResult = await computeAndPersistPnlForSymbol(trade.symbol, trade.exchange ?? null, { dryRun });
  }

  const realizedPnlPct = pnlResult?.realized
    ?.find((r) => r.sellTradeId === tradeId)?.realizedPnlPct ?? null;
  const isLoss = Number.isFinite(realizedPnlPct) && realizedPnlPct < 0;

  // 2. quality_evaluation_pending 이벤트 삽입 (worker가 polling)
  let knowledgeId = null;
  if (!dryRun) {
    await insertQualityEvaluationPending(tradeId, {
      symbol: trade.symbol,
      exchange: trade.exchange,
      signal_id: trade.signal_id ?? trade.signalId ?? null,
      realized_pnl_pct: realizedPnlPct,
    });
  }

  // 3. 손실 거래 → reflexion
  let reflexionResult = null;
  if (isLoss || opts.forceReflexion) {
    const signalCtx = {
      id: trade.signal_id ?? trade.signalId ?? null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      action: 'sell',
      reason: `realized_pnl_pct=${realizedPnlPct?.toFixed(4)}`,
      code: 'loss_trade',
      status: 'failed',
    };
    reflexionResult = await onSignalFailed(signalCtx, {
      dryRun,
      force: true,
    }).catch(() => null);
  }

  return {
    ok: true,
    status: dryRun ? 'dry_run' : 'executed',
    dryRun,
    tradeId,
    symbol: trade.symbol,
    realizedPnlPct,
    isLoss,
    knowledgeId,
    reflexionResult,
    pnlResult: pnlResult ? { matched: pnlResult.matched, skipped: pnlResult.skipped } : null,
  };
}

/**
 * 복수 SELL 거래 일괄 처리 (batch posttrade 트리거).
 */
export async function onTradesClosedBatch(trades = [], opts = {}) {
  const results = [];
  for (const trade of trades) {
    const r = await onTradeClosed(trade, opts);
    results.push(r);
  }
  return {
    ok: true,
    total: trades.length,
    executed: results.filter((r) => r.status === 'executed').length,
    dryRun: results.filter((r) => r.status === 'dry_run').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}

export default {
  buildPosttradeAutoTrigger,
  summarizePosttradeTriggers,
  onTradeClosed,
  onTradesClosedBatch,
};

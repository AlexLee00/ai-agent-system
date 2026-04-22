// @ts-nocheck
import * as db from '../shared/db.ts';
import { notifySignal, notifyTradeSkip } from '../shared/report.ts';
import { loadLatestNodePayload } from './helpers.ts';

const NODE_ID = 'L32';

async function run({ sessionId, market, symbol, saved: savedOverride = null }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const savedHit = savedOverride ? null : await loadLatestNodePayload(sessionId, 'L30', symbol);
  const saved = savedOverride || savedHit?.payload || null;
  if (!saved?.signalId) {
    return { symbol, market, skipped: true, reason: 'L30 저장 결과 없음' };
  }

  const signal = await db.getSignalById(saved.signalId);
  if (!signal) {
    return { symbol, market, skipped: true, reason: 'signal 조회 실패', signalId: saved.signalId };
  }

  if (saved.status !== 'approved') {
    return {
      symbol,
      market,
      skipped: true,
      reason: `승인 상태 아님: ${saved.status}`,
      signalId: saved.signalId,
    };
  }

  const isDustExitSell = signal.action === 'SELL' && Number(signal.amount_usdt || 0) <= 0;
  if (isDustExitSell) {
    await notifyTradeSkip({
      symbol: signal.symbol,
      action: signal.action,
      reason: '최소 수량 미만 잔여 포지션 가능성 — dust 청산 후보로 보류',
    }).catch(() => {});

    return {
      symbol,
      market,
      signalId: saved.signalId,
      notified: false,
      skipped: true,
      reason: 'dust_exit_sell_suppressed',
      status: saved.status,
    };
  }

  await notifySignal({
    symbol: signal.symbol,
    action: signal.action,
    amountUsdt: signal.amount_usdt,
    confidence: signal.confidence,
    reasoning: signal.reasoning,
    paper: true,
  }).catch(() => {});

  return {
    symbol,
    market,
    signalId: saved.signalId,
    notified: true,
    status: saved.status,
  };
}

export default {
  id: NODE_ID,
  type: 'execute',
  label: 'notify',
  run,
};

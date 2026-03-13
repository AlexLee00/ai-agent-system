import * as db from '../shared/db.js';
import { notifySignal } from '../shared/report.js';
import { loadLatestNodePayload } from './helpers.js';

const NODE_ID = 'L32';

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const savedHit = await loadLatestNodePayload(sessionId, 'L30', symbol);
  const saved = savedHit?.payload || null;
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

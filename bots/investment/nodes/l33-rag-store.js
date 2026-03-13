import * as db from '../shared/db.js';
import { store as storeRag } from '../shared/rag-client.js';
import { loadLatestNodePayload } from './helpers.js';

const NODE_ID = 'L33';

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

  const content = [
    `${signal.symbol} ${signal.action} 신호`,
    `신뢰도: ${signal.confidence ?? '?'}`,
    `판단: ${(signal.reasoning || '').slice(0, 100)}`,
    `상태: ${signal.status}`,
  ].join(' | ');

  await storeRag('trades', content, {
    signal_id: signal.id,
    symbol: signal.symbol,
    action: signal.action,
    confidence: signal.confidence,
    exchange: market,
    status: signal.status,
    session_id: sessionId,
    paper_mode: true,
  }, 'luna');

  return {
    symbol,
    market,
    signalId: signal.id,
    stored: true,
    status: signal.status,
  };
}

export default {
  id: NODE_ID,
  type: 'execute',
  label: 'rag-store',
  run,
};

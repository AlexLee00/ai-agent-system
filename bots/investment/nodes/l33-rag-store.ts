// @ts-nocheck
import * as db from '../shared/db.ts';
import { store as storeRag } from '../shared/rag-client.ts';
import { loadLatestNodePayload } from './helpers.ts';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { publishToRag } = require('../../../packages/core/lib/reporting-hub');

const NODE_ID = 'L33';

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

  const content = [
    `${signal.symbol} ${signal.action} 신호`,
    `신뢰도: ${signal.confidence ?? '?'}`,
    `판단: ${(signal.reasoning || '').slice(0, 100)}`,
    `상태: ${signal.status}`,
  ].join(' | ');

  await publishToRag({
    ragStore: {
      async store(collection, ragContent, metadata = {}, sourceBot = 'luna') {
        return storeRag(collection, ragContent, metadata, sourceBot);
      },
    },
    collection: 'trades',
    sourceBot: 'luna',
    event: {
      from_bot: 'luna',
      team: 'investment',
      event_type: 'trade_rag',
      alert_level: 1,
      message: content,
      payload: {
        title: `${signal.symbol} ${signal.action} 신호`,
        summary: `신뢰도 ${signal.confidence ?? '?'} | 상태 ${signal.status}`,
        details: [`판단: ${(signal.reasoning || '').slice(0, 100)}`],
      },
    },
    metadata: {
      signal_id: signal.id,
      symbol: signal.symbol,
      action: signal.action,
      confidence: signal.confidence,
      exchange: market,
      status: signal.status,
      session_id: sessionId,
      paper_mode: true,
    },
  });

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

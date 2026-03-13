import * as db from '../shared/db.js';
import { executeSignal as executeBinanceSignal } from '../team/hephaestos.js';
import { executeSignal as executeKisSignal, executeOverseasSignal } from '../team/hanul.js';
import { loadLatestNodePayload } from './helpers.js';

const NODE_ID = 'L31';

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const savedHit = await loadLatestNodePayload(sessionId, 'L30', symbol);
  const saved = savedHit?.payload || null;
  if (!saved?.signalId) {
    return { symbol, market, skipped: true, reason: 'L30 저장 결과 없음' };
  }
  if (saved.status !== 'approved') {
    return { symbol, market, skipped: true, reason: `승인 상태 아님: ${saved.status}`, signalId: saved.signalId };
  }

  const signal = await db.getSignalById(saved.signalId);
  if (!signal) {
    return { symbol, market, skipped: true, reason: '저장된 signal 조회 실패', signalId: saved.signalId };
  }

  const executionInput = {
    ...signal,
    amountUsdt: signal.amount_usdt,
    tpPrice: saved.risk?.tpPrice ?? null,
    slPrice: saved.risk?.slPrice ?? null,
    tpslSource: saved.risk?.tpslSource ?? null,
  };

  let result;
  if (market === 'binance') {
    result = await executeBinanceSignal(executionInput);
  } else if (market === 'kis') {
    result = await executeKisSignal(executionInput);
  } else if (market === 'kis_overseas') {
    result = await executeOverseasSignal(executionInput);
  } else {
    throw new Error(`지원하지 않는 market: ${market}`);
  }

  const updatedSignal = await db.getSignalById(saved.signalId).catch(() => null);
  const trade = await db.getLatestTradeBySignalId(saved.signalId).catch(() => null);

  return {
    symbol,
    market,
    signalId: saved.signalId,
    execution: result,
    signalStatus: updatedSignal?.status ?? null,
    trade,
  };
}

export default {
  id: NODE_ID,
  type: 'execute',
  label: 'order-execute',
  run,
};

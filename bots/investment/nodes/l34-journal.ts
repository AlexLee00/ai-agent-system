// @ts-nocheck
import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { loadLatestNodePayload } from './helpers.ts';

const NODE_ID = 'L34';

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const executeHit = await loadLatestNodePayload(sessionId, 'L31', symbol);
  const saveHit = await loadLatestNodePayload(sessionId, 'L30', symbol);
  const execution = executeHit?.payload || null;
  const saved = saveHit?.payload || null;
  const signalId = execution?.signalId || saved?.signalId || null;

  if (!signalId) {
    return { symbol, market, skipped: true, reason: 'signalId 없음' };
  }

  const signal = await db.getSignalById(signalId).catch(() => null);
  const trade = await db.getLatestTradeBySignalId(signalId).catch(() => null);
  const journalEntry = await journalDb.getLatestJournalEntryBySignalId(signalId).catch(() => null);
  const review = journalEntry?.trade_id
    ? await journalDb.getReviewByTradeId(journalEntry.trade_id).catch(() => null)
    : null;

  return {
    symbol,
    market,
    signalId,
    signalStatus: signal?.status ?? null,
    tradeId: journalEntry?.trade_id ?? null,
    tradeSide: trade?.side ?? null,
    journalStatus: journalEntry?.status ?? null,
    hasJournalEntry: Boolean(journalEntry),
    hasReview: Boolean(review),
    review,
  };
}

export default {
  id: NODE_ID,
  type: 'execute',
  label: 'journal',
  run,
};

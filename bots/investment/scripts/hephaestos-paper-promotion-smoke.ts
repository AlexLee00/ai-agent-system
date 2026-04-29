#!/usr/bin/env node
// @ts-nocheck

import { createPaperPromotionPolicy } from '../team/hephaestos/paper-promotion.ts';

const journalEntries = [];
const positions = [];
const trades = [];
const closedJournals = [];
const notifications = [];

const policy = createPaperPromotionPolicy({
  getCapitalConfig() {
    return {
      reserve_ratio: 0.2,
      max_position_pct: 0.1,
      max_concurrent_positions: 3,
    };
  },
  async getDynamicMinOrderAmount() {
    return 10;
  },
  async getAvailableUSDT() {
    return 1000;
  },
  async getOpenPositions() {
    return [];
  },
  async preTradeCheck(symbol, action, amount) {
    return { allowed: amount <= 1000, reason: amount <= 1000 ? null : '잔고 부족' };
  },
  isCapitalShortageReason(reason = '') {
    return String(reason).includes('잔고 부족');
  },
  db: {
    async getPaperPositions() {
      return [{ symbol: 'PROMO/USDT', amount: 2, avg_price: 25, trade_mode: 'normal' }];
    },
    async upsertPosition(row) {
      positions.push(row);
    },
    async insertTrade(row) {
      trades.push(row);
    },
  },
  journalDb: {
    async generateTradeId() {
      return 'TRD-PROMO';
    },
    async insertJournalEntry(row) {
      journalEntries.push(row);
    },
  },
  async marketBuy() {
    return { filled: 2, price: 25 };
  },
  async closeOpenJournalForSymbol(...args) {
    closedJournals.push(args);
  },
  notifyJournalEntry(payload) {
    notifications.push({ type: 'journal', payload });
  },
  notifyTrade(payload) {
    notifications.push({ type: 'trade', payload });
    return Promise.resolve();
  },
  async fetchTicker() {
    return 25;
  },
  async calculatePositionSize() {
    return { skip: false, size: 80 };
  },
  isPaperMode() {
    return false;
  },
  getInvestmentTradeMode() {
    return 'normal';
  },
});

const promoted = await policy.maybePromotePaperPositions({ reserveSlots: 1 });
const candidates = await policy.inspectPromotionCandidates();
const simulation = await policy.simulateBuyDecision({ symbol: 'PROMO/USDT', amountUsdt: 50 });

if (promoted.length !== 1 || positions[0]?.symbol !== 'PROMO/USDT' || trades[0]?.executionOrigin !== 'promotion') {
  throw new Error(`promotion path mismatch: ${JSON.stringify({ promoted, positions, trades })}`);
}
if (candidates.candidates[0]?.promotable !== true) {
  throw new Error(`promotion candidate mismatch: ${JSON.stringify(candidates)}`);
}
if (simulation.capitalPolicy.minOrderUsdt !== 10 || simulation.finalMode !== 'live') {
  throw new Error(`simulate buy mismatch: ${JSON.stringify(simulation)}`);
}

const payload = {
  ok: true,
  smoke: 'hephaestos-paper-promotion',
  promoted,
  candidate: candidates.candidates[0],
  simulation,
  journalEntries: journalEntries.length,
  closedJournals: closedJournals.length,
  notifications: notifications.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos paper promotion smoke passed');
}

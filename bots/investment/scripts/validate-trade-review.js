#!/usr/bin/env node

import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const daysArg = args.find(arg => arg.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
const FIX = args.includes('--fix');

function isSuspiciousPercent(value) {
  if (value == null) return false;
  const abs = Math.abs(Number(value));
  return abs > 0 && abs < 1;
}

export async function validateTradeReview({ days = 30, fix = false } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await db.query(`
    SELECT
      j.trade_id,
      j.symbol,
      j.exchange,
      j.is_paper,
      j.entry_value,
      j.pnl_amount,
      j.pnl_percent,
      j.status,
      j.exit_time,
      r.trade_id AS review_trade_id,
      r.max_favorable,
      r.max_adverse,
      r.reviewed_at
    FROM investment.trade_journal j
    LEFT JOIN investment.trade_review r ON r.trade_id = j.trade_id
    WHERE j.status = 'closed'
      AND j.exit_time IS NOT NULL
      AND j.created_at >= ?
    ORDER BY j.exit_time DESC, j.created_at DESC
  `, [since]);

  const findings = [];
  let fixed = 0;

  for (const row of rows) {
    const issues = [];
    const expectedPnlPercent = row.entry_value > 0 && row.pnl_amount != null
      ? Number(((Number(row.pnl_amount) / Number(row.entry_value)) * 100).toFixed(4))
      : null;

    if (!row.review_trade_id) {
      issues.push('missing_review');
    }
    if (isSuspiciousPercent(row.pnl_percent)) {
      issues.push('pnl_percent_ratio_scale');
    }
    if (row.review_trade_id && row.max_favorable == null) {
      issues.push('missing_max_favorable');
    }
    if (row.review_trade_id && row.max_adverse == null) {
      issues.push('missing_max_adverse');
    }
    if (
      expectedPnlPercent != null &&
      row.pnl_percent != null &&
      Math.abs(Number(row.pnl_percent) - expectedPnlPercent) > 0.02
    ) {
      issues.push('pnl_percent_mismatch');
    }

    if (issues.length === 0) continue;

    if (fix) {
      if (issues.includes('pnl_percent_ratio_scale') || issues.includes('pnl_percent_mismatch')) {
        await db.run(
          `UPDATE trade_journal
           SET pnl_percent = ?
           WHERE trade_id = ?`,
          [expectedPnlPercent, row.trade_id],
        );
      }

      if (
        issues.includes('missing_review') ||
        issues.includes('missing_max_favorable') ||
        issues.includes('missing_max_adverse')
      ) {
        await db.run(`DELETE FROM trade_review WHERE trade_id = ?`, [row.trade_id]);
        await journalDb.ensureAutoReview(row.trade_id);
      }
      fixed++;
    }

    findings.push({
      tradeId: row.trade_id,
      symbol: row.symbol,
      exchange: row.exchange,
      isPaper: Boolean(row.is_paper),
      issues,
      pnlPercentStored: row.pnl_percent == null ? null : Number(row.pnl_percent),
      pnlPercentExpected: expectedPnlPercent,
      hasReview: Boolean(row.review_trade_id),
      maxFavorable: row.max_favorable == null ? null : Number(row.max_favorable),
      maxAdverse: row.max_adverse == null ? null : Number(row.max_adverse),
    });
  }

  return {
    days,
    closedTrades: rows.length,
    findings: findings.length,
    fixed,
    items: findings,
  };
}

async function main() {
  const result = await validateTradeReview({ days: DAYS, fix: FIX });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('❌ trade_review 검증 실패:', err?.message || String(err));
    process.exit(1);
  });
}

export default {
  validateTradeReview,
};

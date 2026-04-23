#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const daysArg = args.find(arg => arg.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
const FIX = args.includes('--fix');
const scopeArg = args.find(arg => arg.startsWith('--scope='));
const SCOPE = args.includes('--paper-only')
  ? 'paper'
  : args.includes('--live-only')
    ? 'live'
    : ['paper', 'live', 'all'].includes(scopeArg?.split('=')[1])
      ? scopeArg.split('=')[1]
      : 'all';

function isRatioScaledPercent(storedPercent, expectedPercent) {
  if (storedPercent == null || expectedPercent == null) return false;
  const stored = Number(storedPercent);
  const expected = Number(expectedPercent);
  if (!Number.isFinite(stored) || !Number.isFinite(expected)) return false;
  if (expected === 0) return false;
  const ratioCandidate = Number((expected / 100).toFixed(6));
  return Math.abs(stored - ratioCandidate) <= 0.0005;
}

export function summarizeTradeReviewFindings(items = []) {
  const issueCounts = {};
  const byExchange = {};
  const bySymbol = {};
  let liveFindings = 0;
  let paperFindings = 0;
  for (const item of Array.isArray(items) ? items : []) {
    for (const issue of item.issues || []) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
    if (item.isPaper) paperFindings += 1;
    else liveFindings += 1;
    const exchange = String(item.exchange || 'unknown');
    const symbol = String(item.symbol || 'unknown');
    byExchange[exchange] = (byExchange[exchange] || 0) + 1;
    bySymbol[symbol] = (bySymbol[symbol] || 0) + 1;
  }

  const rank = (map) => Object.entries(map)
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || a.key.localeCompare(b.key));

  const topIssue = rank(issueCounts)[0] || null;
  const topExchange = rank(byExchange)[0] || null;
  const topSymbol = rank(bySymbol)[0] || null;
  const repairCommand = paperFindings > 0 && liveFindings === 0
    ? 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:fix:paper'
    : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:fix';

  let repairHint = 'trade_review 누락/불일치 항목을 재생성하고 pnl_percent를 entry_value 기준으로 재계산합니다.';
  if (topIssue?.key === 'missing_review') {
    repairHint = '누락된 trade_review를 우선 재생성해야 합니다.';
  } else if (topIssue?.key === 'pnl_percent_mismatch' || topIssue?.key === 'pnl_percent_ratio_scale') {
    repairHint = '저널 pnl_percent 계산 스케일을 우선 보정해야 합니다.';
  } else if (topIssue?.key === 'missing_max_favorable' || topIssue?.key === 'missing_max_adverse') {
    repairHint = 'MFE/MAE가 비어 있는 review를 재생성해야 합니다.';
  }

  return {
    issueCounts,
    topIssue,
    topExchange,
    topSymbol,
    liveFindings,
    paperFindings,
    paperOnly: paperFindings > 0 && liveFindings === 0,
    repairCommand,
    recheckCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review -- --days=90',
    repairHint,
  };
}

export async function validateTradeReview({ days = 30, fix = false, scope = 'all' } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();
  const safeScope = ['paper', 'live', 'all'].includes(String(scope)) ? String(scope) : 'all';

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
  let fixedLive = 0;
  let fixedPaper = 0;
  let scopedClosedTrades = 0;

  for (const row of rows) {
    const isPaper = Boolean(row.is_paper);
    if (safeScope === 'paper' && !isPaper) continue;
    if (safeScope === 'live' && isPaper) continue;
    scopedClosedTrades++;

    const issues = [];
    const expectedPnlPercent = row.entry_value > 0 && row.pnl_amount != null
      ? Number(((Number(row.pnl_amount) / Number(row.entry_value)) * 100).toFixed(4))
      : null;

    if (!row.review_trade_id) {
      issues.push('missing_review');
    }
    if (isRatioScaledPercent(row.pnl_percent, expectedPnlPercent)) {
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
      if (isPaper) fixedPaper++;
      else fixedLive++;
    }

    findings.push({
      tradeId: row.trade_id,
      symbol: row.symbol,
      exchange: row.exchange,
      isPaper,
      issues,
      pnlPercentStored: row.pnl_percent == null ? null : Number(row.pnl_percent),
      pnlPercentExpected: expectedPnlPercent,
      hasReview: Boolean(row.review_trade_id),
      maxFavorable: row.max_favorable == null ? null : Number(row.max_favorable),
      maxAdverse: row.max_adverse == null ? null : Number(row.max_adverse),
    });
  }

  const summary = summarizeTradeReviewFindings(findings);

  return {
    days,
    scope: safeScope,
    closedTrades: scopedClosedTrades,
    scannedClosedTrades: rows.length,
    findings: findings.length,
    fixed,
    fixedLive,
    fixedPaper,
    summary,
    items: findings,
  };
}

async function main() {
  const result = await validateTradeReview({ days: DAYS, fix: FIX, scope: SCOPE });
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

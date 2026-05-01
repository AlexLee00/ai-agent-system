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

async function resolveJournalEntryTimeRepairCandidate(row = {}) {
  const exitTime = Number(row.exit_time || 0);
  if (!(exitTime > 0)) return null;

  const buyTrade = await db.get(
    `SELECT EXTRACT(EPOCH FROM executed_at) * 1000 AS executed_ms
       FROM investment.trades
      WHERE signal_id = $1
        AND symbol = $2
        AND side = 'buy'
        AND exchange = $3
        AND COALESCE(trade_mode, 'normal') = COALESCE($4, 'normal')
      ORDER BY executed_at DESC
      LIMIT 1`,
    [row.signal_id || null, row.symbol, row.exchange, row.trade_mode || 'normal'],
  ).catch(() => null);
  const buyExecutedMs = Number(buyTrade?.executed_ms || 0);
  if (buyExecutedMs > 0 && buyExecutedMs < exitTime) return buyExecutedMs;

  const signalCreatedMs = row.signal_created_at ? Date.parse(String(row.signal_created_at)) : 0;
  if (Number.isFinite(signalCreatedMs) && signalCreatedMs > 0 && signalCreatedMs < exitTime) {
    return signalCreatedMs;
  }

  const currentEntryTime = Number(row.entry_time || 0);
  if (currentEntryTime > 0 && currentEntryTime < exitTime) return currentEntryTime;
  return exitTime - 1;
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
    ? 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:repair:paper'
    : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:repair';
  const fixCommand = paperFindings > 0 && liveFindings === 0
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
    fixCommand,
    recheckCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review -- --days=90',
    repairHint,
  };
}

export function buildTradeReviewRepairCloseout({ before = null, repair = null, after = null, fix = false } = {}) {
  const beforeFindings = Number(before?.findings || 0);
  const afterFindings = Number(after?.findings ?? beforeFindings);
  const fixed = Number(repair?.fixed || 0);
  const fixedLive = Number(repair?.fixedLive || 0);
  const fixedPaper = Number(repair?.fixedPaper || 0);
  const scope = repair?.scope || before?.scope || after?.scope || 'all';
  const dryRun = !fix;
  const beforeClosedTrades = Number(before?.closedTrades || 0);
  const afterClosedTrades = Number(after?.closedTrades ?? beforeClosedTrades);
  const beforeLiveClosedTrades = Number(before?.scopedLiveClosedTrades || 0);
  const beforePaperClosedTrades = Number(before?.scopedPaperClosedTrades || 0);
  const afterLiveClosedTrades = Number(after?.scopedLiveClosedTrades ?? beforeLiveClosedTrades);
  const afterPaperClosedTrades = Number(after?.scopedPaperClosedTrades ?? beforePaperClosedTrades);
  const liveSafe = scope === 'paper'
    ? fixedLive === 0 && beforeLiveClosedTrades === 0 && afterLiveClosedTrades === 0
    : fixedLive === 0 && Number((after || before)?.summary?.liveFindings || 0) === 0;

  let status = 'trade_review_repair_no_findings';
  if (dryRun && beforeFindings > 0) status = 'trade_review_repair_dry_run';
  else if (beforeFindings > 0 && afterFindings === 0) status = 'trade_review_repair_closed';
  else if (beforeFindings > 0 && afterFindings > 0 && afterFindings < beforeFindings) status = 'trade_review_repair_partial';
  else if (beforeFindings > 0 && afterFindings > 0) status = 'trade_review_repair_remaining';

  const actionItems = [];
  if (dryRun && before?.summary?.repairCommand) actionItems.push(before.summary.repairCommand);
  if (!dryRun && afterFindings > 0 && after?.summary?.repairCommand) actionItems.push(after.summary.repairCommand);
  if (!dryRun && after?.summary?.recheckCommand) actionItems.push(after.summary.recheckCommand);

  return {
    status,
    dryRun,
    scope,
    liveSafe,
    beforeFindings,
    afterFindings,
    beforeClosedTrades,
    afterClosedTrades,
    beforeLiveClosedTrades,
    beforePaperClosedTrades,
    afterLiveClosedTrades,
    afterPaperClosedTrades,
    fixed,
    fixedLive,
    fixedPaper,
    paperOnly: Boolean((after || before)?.summary?.paperOnly),
    headline: dryRun
      ? `trade_review 복구 dry-run: ${beforeFindings}건이 복구 후보입니다.`
      : `trade_review 복구 결과: ${fixed}건 처리, 재검증 잔여 ${afterFindings}건입니다.`,
    actionItems,
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
      j.signal_id,
      j.symbol,
      j.exchange,
      j.trade_mode,
      j.is_paper,
      j.entry_time,
      j.entry_value,
      j.pnl_amount,
      j.pnl_percent,
      j.status,
      j.exit_time,
      s.created_at AS signal_created_at,
      r.trade_id AS review_trade_id,
      r.max_favorable,
      r.max_adverse,
      r.reviewed_at
    FROM investment.trade_journal j
    LEFT JOIN investment.signals s ON s.id = j.signal_id
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
  let scopedLiveClosedTrades = 0;
  let scopedPaperClosedTrades = 0;

  for (const row of rows) {
    const isPaper = Boolean(row.is_paper);
    if (safeScope === 'paper' && !isPaper) continue;
    if (safeScope === 'live' && isPaper) continue;
    scopedClosedTrades++;
    if (isPaper) scopedPaperClosedTrades++;
    else scopedLiveClosedTrades++;

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
    if (Number(row.entry_time || 0) > 0 && Number(row.exit_time || 0) > 0 && Number(row.entry_time) >= Number(row.exit_time)) {
      issues.push('invalid_review_window');
    }

    if (issues.length === 0) continue;

    if (fix) {
      if (issues.includes('invalid_review_window')) {
        const repairedEntryTime = await resolveJournalEntryTimeRepairCandidate(row);
        if (repairedEntryTime != null && Number.isFinite(Number(repairedEntryTime)) && Number(repairedEntryTime) > 0) {
          await db.run(
            `UPDATE trade_journal
             SET entry_time = $1,
                 execution_time = CASE
                   WHEN execution_time IS NULL OR execution_time < $1 THEN $1
                   ELSE execution_time
                 END,
                 hold_duration = CASE
                   WHEN exit_time IS NOT NULL THEN exit_time - $1
                   ELSE hold_duration
                 END
             WHERE trade_id = $2`,
            [Number(repairedEntryTime), row.trade_id],
          );
        }
      }

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
      entryTime: Number(row.entry_time || 0) || null,
      exitTime: Number(row.exit_time || 0) || null,
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
    scopedLiveClosedTrades,
    scopedPaperClosedTrades,
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
  buildTradeReviewRepairCloseout,
  summarizeTradeReviewFindings,
};

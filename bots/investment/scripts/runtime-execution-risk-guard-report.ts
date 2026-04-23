#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const EXECUTION_GUARD_CODES = [
  'sec004_nemesis_bypass_guard',
  'sec004_stale_approval',
  'sec015_nemesis_bypass_guard',
  'sec015_stale_approval',
  'sec015_overseas_nemesis_bypass_guard',
  'sec015_overseas_stale_approval',
];

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function classifyCode(code = '') {
  const value = String(code || '');
  if (value.includes('stale_approval')) return 'stale_approval';
  if (value.includes('nemesis_bypass_guard')) return 'nemesis_bypass_guard';
  return 'risk_approval_execution';
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(`
    SELECT
      id,
      symbol,
      exchange,
      action,
      amount_usdt,
      confidence,
      block_code,
      block_reason,
      block_meta,
      created_at
    FROM investment.signals
    WHERE created_at >= NOW() - ($1::int || ' days')::interval
      AND status IN ('failed', 'blocked', 'rejected')
      AND (
        COALESCE(block_code, '') = ANY($2)
        OR block_meta ? 'risk_approval_execution'
      )
    ORDER BY created_at DESC
  `, [safeDays, EXECUTION_GUARD_CODES]).catch(() => []);
}

export function summarizeRuntimeExecutionRiskGuardRows(rows = []) {
  const byCode = {};
  const byExchange = {};
  const byKind = {};
  const byBlockedBy = {};
  let total = 0;
  let staleCount = 0;
  let bypassCount = 0;

  for (const row of rows) {
    total += 1;
    const code = String(row.block_code || 'risk_approval_execution');
    const exchange = String(row.exchange || 'unknown');
    const kind = classifyCode(code);
    const blockedBy = String(row.block_meta?.execution_blocked_by || 'unknown');

    byCode[code] = (byCode[code] || 0) + 1;
    byExchange[exchange] = (byExchange[exchange] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    byBlockedBy[blockedBy] = (byBlockedBy[blockedBy] || 0) + 1;
    if (kind === 'stale_approval') staleCount += 1;
    if (kind === 'nemesis_bypass_guard') bypassCount += 1;
  }

  const top = (map) => Object.entries(map)
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ko'));

  return {
    total,
    staleCount,
    bypassCount,
    byCode: top(byCode),
    byExchange: top(byExchange),
    byKind: top(byKind),
    byBlockedBy: top(byBlockedBy),
  };
}

export function buildRuntimeExecutionRiskGuardDecision(summary = {}) {
  let status = 'execution_risk_guard_ok';
  let headline = '실행 직전 리스크 승인 가드 차단이 관찰되지 않습니다.';
  const reasons = [
    `total ${summary.total || 0}`,
    `stale ${summary.staleCount || 0}`,
    `bypass ${summary.bypassCount || 0}`,
  ];
  const actionItems = ['실행 직전 승인 freshness와 네메시스 승인 누락 여부를 계속 관찰합니다.'];

  if (Number(summary.staleCount || 0) > 0) {
    status = 'execution_risk_guard_stale_attention';
    headline = '승인 후 실행까지 지연되어 실행 직전 stale 차단이 발생했습니다.';
    actionItems.unshift('승인→실행 큐 지연, broker preflight, market session wait 시간을 우선 확인합니다.');
  } else if (Number(summary.bypassCount || 0) > 0) {
    status = 'execution_risk_guard_bypass_attention';
    headline = '네메시스 승인 없이 실행 단계에 도달한 BUY 신호가 차단되었습니다.';
    actionItems.unshift('신호 생성→네메시스 승인→실행 큐 연결 경로에서 승인 메타 누락 여부를 확인합니다.');
  } else if (Number(summary.total || 0) > 0) {
    status = 'execution_risk_guard_watch';
    headline = '실행 직전 리스크 승인 가드가 일부 주문을 차단했습니다.';
  }

  return { status, headline, reasons, actionItems, metrics: summary };
}

function renderText(payload) {
  return [
    '🛡️ Runtime Execution Risk Guard',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '상위 코드:',
    ...(payload.summary.byCode.length
      ? payload.summary.byCode.slice(0, 6).map((row) => `- ${row.key}: ${row.count}`)
      : ['- 없음']),
    '',
    '샘플:',
    ...(payload.rows.length
      ? payload.rows.slice(0, 5).map((row) => `- ${row.exchange}/${row.symbol}: ${row.blockCode} / ${row.blockReason || 'n/a'}`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeExecutionRiskGuardReport({ days = 14, json = false } = {}) {
  await db.initSchema();
  const rows = await loadRows(days);
  const summary = summarizeRuntimeExecutionRiskGuardRows(rows);
  const decision = buildRuntimeExecutionRiskGuardDecision(summary);
  const payload = {
    ok: true,
    days: Number(days),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    summary,
    decision,
    rows: rows.slice(0, 25).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      exchange: row.exchange,
      action: row.action,
      amountUsdt: Number(row.amount_usdt || 0),
      confidence: row.confidence == null ? null : Number(row.confidence),
      blockCode: row.block_code,
      blockReason: row.block_reason,
      blockedBy: row.block_meta?.execution_blocked_by || null,
      riskApprovalExecution: row.block_meta?.risk_approval_execution || null,
      createdAt: row.created_at,
    })),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeExecutionRiskGuardReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-execution-risk-guard-report 오류:',
  });
}

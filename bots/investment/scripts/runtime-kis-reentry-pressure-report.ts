#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

const REENTRY_CODES = [
  'live_position_reentry_blocked',
  'paper_position_reentry_blocked',
  'same_day_reentry_blocked',
];

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function buildDecision(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const byCode = rows.reduce((acc, row) => {
    const code = String(row.code || 'unknown');
    acc[code] = (acc[code] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const top = rows[0] || null;

  let status = 'kis_reentry_ok';
  let headline = '최근 국내장 재진입 차단 압력이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 국내장 재진입 차단 실패가 없습니다.');
  } else {
    reasons.push(`최근 국내장 재진입 차단 ${total}건`);
    const summary = Object.entries(byCode)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .map(([code, count]) => `${code} ${count}건`)
      .join(' | ');
    if (summary) reasons.push(`코드별: ${summary}`);
    if (top?.symbol && top?.reason) {
      reasons.push(`최다 사례: ${top.symbol} / ${top.reason} (${top.count}건)`);
    }
  }

  if (total >= 10) {
    status = 'kis_reentry_pressure';
    headline = '국내장 동일 포지션/당일 재진입 차단이 반복적으로 실행을 막고 있습니다.';
  } else if (total > 0) {
    status = 'kis_reentry_watch';
    headline = '국내장 재진입 차단이 간헐적으로 관찰됩니다.';
  }

  if (status === 'kis_reentry_pressure') {
    actionItems.push('국내장 live reentry와 same-day reentry 차단이 의도된 정책인지 운영 기준으로 다시 확인합니다.');
    actionItems.push('차단이 과도하면 진입 신호 수보다 포지션 보유/청산 정책을 먼저 조정합니다.');
  } else if (status === 'kis_reentry_watch') {
    actionItems.push('watch 수준으로 유지하며 다음 리포트에서 live/same-day 차단 추이를 비교합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 국내장 재진입 차단만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      live: Number(byCode.live_position_reentry_blocked || 0),
      paper: Number(byCode.paper_position_reentry_blocked || 0),
      sameDay: Number(byCode.same_day_reentry_blocked || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🔁 Runtime KIS Reentry Pressure',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '상위 차단:',
    ...(payload.rows.length > 0
      ? payload.rows.slice(0, 5).map((row) => `- ${row.symbol} | ${row.code} | ${row.reason} (${row.count}건)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'kis_reentry_pressure') {
    return '국내장 재진입 차단이 반복돼, 진입 필터보다 포지션 보유와 same-day 재진입 정책을 먼저 점검하는 것이 좋습니다.';
  }
  if (payload.decision.status === 'kis_reentry_watch') {
    return '국내장 재진입 차단이 간헐적으로 보여, 다음 리포트에서 live/same-day 차단 추이를 비교하면 좋습니다.';
  }
  return '최근 국내장 재진입 차단은 두드러지지 않아 현 수준 관찰이면 충분합니다.';
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  const codeList = REENTRY_CODES.map((code) => `'${code}'`).join(', ');
  return db.query(`
    SELECT
      symbol,
      COALESCE(block_code, '') AS code,
      LEFT(COALESCE(block_reason, ''), 160) AS reason,
      COUNT(*)::INTEGER AS count
    FROM investment.signals
    WHERE exchange = 'kis'
      AND status = 'failed'
      AND created_at > now() - INTERVAL '${safeDays} days'
      AND COALESCE(block_code, '') IN (${codeList})
    GROUP BY symbol, COALESCE(block_code, ''), LEFT(COALESCE(block_reason, ''), 160)
    ORDER BY count DESC
    LIMIT 20
  `);
}

export async function buildRuntimeKisReentryPressureReport({ days = 14, json = false } = {}) {
  const rows = await loadRows(days);
  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    days,
    count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    rows,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-kis-reentry-pressure',
    requestType: 'runtime-kis-reentry-pressure',
    title: '투자 국내장 재진입 차단 압박 요약',
    data: {
      days,
      count: payload.count,
      topRows: rows.slice(0, 5),
      decision,
    },
    fallback: buildFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisReentryPressureReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-reentry-pressure-report 오류:',
  });
}

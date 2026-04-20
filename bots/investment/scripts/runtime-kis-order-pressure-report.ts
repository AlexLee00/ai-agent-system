#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

const ORDER_CAPACITY_REASONS = [
  '주문 가능한 수량을 초과했습니다',
  '주문가능금액을 초과',
];

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function inferCode(reason = '') {
  const text = String(reason || '');
  if (text.includes('APBK0400')) return 'APBK0400';
  if (text.includes('APBK0952')) return 'APBK0952';
  return 'unknown';
}

function buildDecision(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const byCode = rows.reduce((acc, row) => {
    const code = inferCode(row.reason);
    acc[code] = (acc[code] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const top = rows[0] || null;

  let status = 'kis_order_ok';
  let headline = '최근 국내장 주문 수량/금액 초과 압력이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 국내장 주문 초과 실패가 없습니다.');
  } else {
    reasons.push(`최근 국내장 주문 초과 실패 ${total}건`);
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
    status = 'kis_order_pressure';
    headline = '국내장 주문 가능 수량/금액 제약이 반복적으로 실행을 막고 있습니다.';
  } else if (total > 0) {
    status = 'kis_order_watch';
    headline = '국내장 주문 가능 수량/금액 제약이 간헐적으로 관찰됩니다.';
  }

  if (status === 'kis_order_pressure') {
    actionItems.push('주문 수량 계산 안전 버퍼와 1주 감산 재시도가 실제로 압력을 낮추는지 추적합니다.');
    actionItems.push('필요하면 국내장 기본 주문값과 주문 직전 가용금액 가드를 함께 조정합니다.');
  } else if (status === 'kis_order_watch') {
    actionItems.push('watch 수준으로 유지하며 다음 리포트에서 코드별 감소 추이를 비교합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 국내장 주문 초과 실패만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      apbk0400: Number(byCode.APBK0400 || 0),
      apbk0952: Number(byCode.APBK0952 || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🏦 Runtime KIS Order Pressure',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '상위 실패:',
    ...(payload.rows.length > 0
      ? payload.rows.slice(0, 5).map((row) => `- ${row.symbol} | ${row.reason} (${row.count}건)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'kis_order_pressure') {
    return '국내장 주문 가능 수량/금액 초과가 반복돼, 주문 버퍼 적용 후 감소 추이를 우선 확인하는 것이 좋습니다.';
  }
  if (payload.decision.status === 'kis_order_watch') {
    return '국내장 주문 초과 실패가 간헐적으로 보여, 다음 리포트에서 코드별 감소 추이를 비교하면 좋습니다.';
  }
  return '최근 국내장 주문 가능 수량/금액 초과는 두드러지지 않아 현 수준 관찰이면 충분합니다.';
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  const patterns = ORDER_CAPACITY_REASONS.map((reason) => `block_reason ILIKE '%${reason.replace(/'/g, "''")}%'`).join(' OR ');
  return db.query(`
    SELECT
      symbol,
      LEFT(COALESCE(block_reason, ''), 160) AS reason,
      COUNT(*)::INTEGER AS count
    FROM investment.signals
    WHERE exchange = 'kis'
      AND status = 'failed'
      AND created_at > now() - INTERVAL '${safeDays} days'
      AND (${patterns})
    GROUP BY symbol, LEFT(COALESCE(block_reason, ''), 160)
    ORDER BY count DESC
    LIMIT 20
  `);
}

export async function buildRuntimeKisOrderPressureReport({ days = 14, json = false } = {}) {
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
    bot: 'runtime-kis-order-pressure',
    requestType: 'runtime-kis-order-pressure',
    title: '투자 국내장 주문 초과 압박 요약',
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
  const result = await buildRuntimeKisOrderPressureReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-order-pressure-report 오류:',
  });
}

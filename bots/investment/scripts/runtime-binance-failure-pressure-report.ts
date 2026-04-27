#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function classify(row) {
  const code = String(row.code || '');
  const reason = String(row.reason || '');
  if (code === 'capital_backpressure') {
    if (reason.includes('buying_power_unavailable') || reason.includes('잔고 조회 실패')) return 'buying_power_unavailable';
    if (reason.includes('position_slots_exhausted') || reason.includes('최대 포지션')) return 'max_positions';
    return 'capital_backpressure';
  }
  if (code === 'capital_circuit_breaker') return 'circuit_breaker';
  if (code === 'capital_guard_rejected') {
    if (reason.includes('일간 매매 한도')) return 'daily_trade_limit';
    if (reason.includes('상관관계 가드')) return 'correlation_guard';
    return 'capital_guard_other';
  }
  if (
    code === 'live_position_reentry_blocked' ||
    code === 'paper_position_reentry_blocked' ||
    code === 'position_reentry_blocked' ||
    code === 'same_day_reentry_blocked'
  ) return 'reentry';
  if (code === 'broker_execution_error' && reason.includes('precision')) return 'precision';
  if (code === 'broker_execution_error' && reason.includes('insufficient balance')) return 'insufficient_balance';
  return code || 'other';
}

function labelForGroup(group) {
  switch (group) {
    case 'circuit_breaker': return 'circuit breaker';
    case 'daily_trade_limit': return 'daily trade limit';
    case 'correlation_guard': return 'correlation guard';
    case 'capital_guard_other': return 'capital guard';
    case 'reentry': return 'reentry';
    case 'precision': return 'precision';
    case 'insufficient_balance': return 'insufficient balance';
    case 'capital_backpressure': return 'capital backpressure';
    case 'buying_power_unavailable': return 'buying power unavailable';
    case 'max_positions': return 'max positions';
    default: return group;
  }
}

function buildDecision(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const grouped = rows.reduce((acc, row) => {
    const group = classify(row);
    acc[group] = (acc[group] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const topGroups = Object.entries(grouped)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));

  let status = 'binance_failure_ok';
  let headline = '최근 크립토 실행 실패 압력이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 바이낸스 failed 신호가 없습니다.');
  } else {
    reasons.push(`최근 바이낸스 failed 신호 ${total}건`);
    if (topGroups.length > 0) {
      reasons.push(`주요 축: ${topGroups.slice(0, 4).map(([group, count]) => `${labelForGroup(group)} ${count}건`).join(' | ')}`);
    }
  }

  if (total >= 20) {
    status = 'binance_failure_pressure';
    headline = '크립토 실행 실패 압력이 반복적으로 관찰됩니다.';
  } else if (total > 0) {
    status = 'binance_failure_watch';
    headline = '크립토 실행 실패가 간헐적으로 관찰됩니다.';
  }

  if (status === 'binance_failure_pressure') {
    actionItems.push('circuit breaker, capital guard, reentry, precision 중 어느 축이 계속 우세한지 추세 비교를 우선합니다.');
    actionItems.push('실패 총량보다 상위 실패 축이 바뀌는지 먼저 확인합니다.');
  } else if (status === 'binance_failure_watch') {
    actionItems.push('watch 수준으로 유지하며 다음 리포트에서 실패 축 이동 여부를 비교합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 바이낸스 실패 축만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      circuitBreaker: Number(grouped.circuit_breaker || 0),
      capitalGuard: Number(grouped.daily_trade_limit || 0) + Number(grouped.correlation_guard || 0) + Number(grouped.capital_guard_other || 0),
      capitalBackpressure: Number(grouped.capital_backpressure || 0) + Number(grouped.buying_power_unavailable || 0),
      reentry: Number(grouped.reentry || 0),
      precision: Number(grouped.precision || 0),
      insufficientBalance: Number(grouped.insufficient_balance || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🪙 Runtime Binance Failure Pressure',
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
      ? payload.rows.slice(0, 6).map((row) => `- ${row.code} | ${row.reason} (${row.count}건)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'binance_failure_pressure') {
    return '크립토 실패가 반복돼, circuit breaker와 capital guard 중심으로 실패 축 이동을 먼저 보는 것이 좋습니다.';
  }
  if (payload.decision.status === 'binance_failure_watch') {
    return '크립토 실패가 간헐적으로 보여, 다음 리포트에서 circuit/reentry/precision 축 변화를 비교하면 좋습니다.';
  }
  return '최근 크립토 실패 압력은 크지 않아 현 수준 관찰이면 충분합니다.';
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(`
    SELECT
      COALESCE(block_code, '') AS code,
      LEFT(COALESCE(block_reason, ''), 180) AS reason,
      COUNT(*)::INTEGER AS count
    FROM investment.signals
    WHERE exchange = 'binance'
      AND status = 'failed'
      AND created_at > now() - INTERVAL '${safeDays} days'
    GROUP BY COALESCE(block_code, ''), LEFT(COALESCE(block_reason, ''), 180)
    ORDER BY count DESC
    LIMIT 20
  `);
}

export async function buildRuntimeBinanceFailurePressureReport({ days = 14, json = false } = {}) {
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
    bot: 'runtime-binance-failure-pressure',
    requestType: 'runtime-binance-failure-pressure',
    title: '투자 크립토 실패 압박 요약',
    data: {
      days,
      count: payload.count,
      topRows: rows.slice(0, 8),
      decision,
    },
    fallback: buildFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceFailurePressureReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-failure-pressure-report 오류:',
  });
}

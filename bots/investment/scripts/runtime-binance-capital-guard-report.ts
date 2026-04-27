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

function classifyReason(row = {}) {
  const code = String(row.code || '');
  const text = String(row.reason || '');
  if (code === 'capital_backpressure') {
    if (text.includes('buying_power_unavailable') || text.includes('잔고 조회 실패')) return 'buying_power_unavailable';
    if (text.includes('position_slots_exhausted') || text.includes('최대 포지션')) return 'max_positions';
    if (text.includes('reducing_only_mode')) return 'reducing_only';
    return 'cash_constrained';
  }
  if (text.includes('상관관계 가드')) return 'correlation_guard';
  if (text.includes('일간 매매 한도')) return 'daily_trade_limit';
  if (text.includes('최대 포지션 도달') || text.includes('최대 동시 포지션')) return 'max_positions';
  return 'capital_guard_other';
}

function labelForGroup(group) {
  switch (group) {
    case 'correlation_guard': return 'correlation guard';
    case 'daily_trade_limit': return 'daily trade limit';
    case 'max_positions': return 'max positions';
    case 'buying_power_unavailable': return 'buying power unavailable';
    case 'cash_constrained': return 'cash constrained';
    case 'reducing_only': return 'reducing only mode';
    default: return 'capital guard';
  }
}

function buildDecision(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const byGroup = rows.reduce((acc, row) => {
    const group = classifyReason(row);
    acc[group] = (acc[group] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  const topGroups = Object.entries(byGroup)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));

  let status = 'binance_capital_guard_ok';
  let headline = '최근 크립토 capital guard 압력이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 크립토 capital guard 차단이 없습니다.');
  } else {
    reasons.push(`최근 크립토 capital guard ${total}건`);
    if (topGroups.length > 0) {
      reasons.push(`주요 축: ${topGroups.map(([group, count]) => `${labelForGroup(group)} ${count}건`).join(' | ')}`);
    }
  }

  if (total >= 10) {
    status = 'binance_capital_guard_pressure';
    headline = '크립토 capital guard가 반복적으로 실행을 막고 있습니다.';
  } else if (total > 0) {
    status = 'binance_capital_guard_watch';
    headline = '크립토 capital guard가 간헐적으로 관찰됩니다.';
  }

  if (status === 'binance_capital_guard_pressure') {
    actionItems.push('daily trade limit와 correlation guard 중 어느 축이 우세한지 추세 비교를 우선합니다.');
    actionItems.push('집중 축에 맞춰 포지션 보유 수 또는 일간 매매 한도를 먼저 복기합니다.');
  } else if (status === 'binance_capital_guard_watch') {
    actionItems.push('watch 수준으로 유지하며 다음 리포트에서 가드 축 이동 여부를 비교합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 capital guard 차단만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      correlationGuard: Number(byGroup.correlation_guard || 0),
      dailyTradeLimit: Number(byGroup.daily_trade_limit || 0),
      maxPositions: Number(byGroup.max_positions || 0),
      cashConstrained: Number(byGroup.cash_constrained || 0),
      buyingPowerUnavailable: Number(byGroup.buying_power_unavailable || 0),
      reducingOnly: Number(byGroup.reducing_only || 0),
    },
  };
}

function renderText(payload) {
  return [
    '🛡️ Runtime Binance Capital Guard',
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
      ? payload.rows.slice(0, 8).map((row) => `- [${row.code}] ${row.reason} (${row.count}건)`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'binance_capital_guard_pressure') {
    return '크립토 capital guard가 반복돼, daily trade limit와 correlation guard 중 어느 축이 주범인지 먼저 비교하는 것이 좋습니다.';
  }
  if (payload.decision.status === 'binance_capital_guard_watch') {
    return '크립토 capital guard가 간헐적으로 보여, 다음 리포트에서 가드 축 이동 여부를 비교하면 좋습니다.';
  }
  return '최근 크립토 capital guard 압력은 크지 않아 현 수준 관찰이면 충분합니다.';
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
      AND status IN ('failed', 'rejected', 'expired')
      AND COALESCE(block_code, '') IN ('capital_guard_rejected', 'capital_backpressure')
      AND created_at > now() - INTERVAL '${safeDays} days'
    GROUP BY COALESCE(block_code, ''), LEFT(COALESCE(block_reason, ''), 180)
    ORDER BY count DESC
    LIMIT 20
  `);
}

export async function buildRuntimeBinanceCapitalGuardReport({ days = 14, json = false } = {}) {
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
    bot: 'runtime-binance-capital-guard',
    requestType: 'runtime-binance-capital-guard',
    title: '투자 크립토 capital guard 압박 요약',
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
  const result = await buildRuntimeBinanceCapitalGuardReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-capital-guard-report 오류:',
  });
}

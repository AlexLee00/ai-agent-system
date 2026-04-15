#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const marketArg = argv.find((arg) => arg.startsWith('--market='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    market: String(marketArg?.split('=').slice(1).join('=') || 'kis'),
    json: argv.includes('--json'),
  };
}

function normalizeMarket(market = 'kis') {
  const value = String(market || 'kis').toLowerCase();
  if (value === 'domestic') return 'kis';
  if (value === 'overseas') return 'kis_overseas';
  if (value === 'crypto') return 'binance';
  return value;
}

function extractGap(reason = '') {
  const text = String(reason || '');
  const numeric = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numeric.length < 2) return { attempted: null, required: null, gap: null };
  const attempted = Number(numeric[0]);
  const required = Number(numeric[1]);
  if (!Number.isFinite(attempted) || !Number.isFinite(required)) {
    return { attempted: null, required: null, gap: null };
  }
  return {
    attempted,
    required,
    gap: Math.max(0, required - attempted),
  };
}

function extractRuntimeTopRiskGap(runtime = null) {
  const key = String(runtime?.decision?.metrics?.topRiskReject?.key || '');
  const gap = extractGap(key);
  return {
    source: key || null,
    attempted: gap.attempted,
    required: gap.required,
    gap: gap.gap,
  };
}

function formatAmount(value, market = 'kis') {
  if (!(Number(value) > 0)) return 'n/a';
  const numeric = Number(value);
  if (market === 'kis') return `${Math.round(numeric).toLocaleString()} KRW`;
  return `${numeric.toFixed(2)} USD`;
}

function buildDecision({ market, rows = [], runtime = null, orderDefaults = null }) {
  const total = rows.length;
  const withGap = rows.filter((row) => Number(row.gap) > 0);
  const avgGap = withGap.length > 0
    ? withGap.reduce((sum, row) => sum + Number(row.gap || 0), 0) / withGap.length
    : 0;
  const maxGapRow = [...withGap].sort((a, b) => Number(b.gap || 0) - Number(a.gap || 0))[0] || null;
  const runtimeGap = extractRuntimeTopRiskGap(runtime);
  const runtimeMinOrderHeavy = String(runtime?.decision?.metrics?.topRiskReject?.key || '').includes('최소 주문');

  let status = 'min_order_ok';
  let headline = '최근 최소 주문 병목이 두드러지지 않습니다.';
  const reasons = [];
  const actionItems = [];

  if (total === 0) {
    reasons.push('최근 min_order_notional 블록이 없습니다.');
  } else {
    reasons.push(`최근 ${total}건 min_order_notional 블록`);
    if (withGap.length > 0) {
      reasons.push(`평균 gap ${formatAmount(avgGap, market)}`);
    }
    if (maxGapRow) {
      reasons.push(`최대 gap ${maxGapRow.symbol} ${formatAmount(maxGapRow.gap, market)}`);
    }
  }

  if (total >= 5) {
    status = 'min_order_pressure';
    headline = '최소 주문금액 가드가 반복적으로 의사결정을 막고 있습니다.';
  } else if (total > 0) {
    status = 'min_order_watch';
    headline = '최소 주문금액 가드가 관찰되고 있습니다.';
  }

  if (runtimeMinOrderHeavy) {
    reasons.push(`runtime top risk reject와 일치: ${runtime.decision.metrics.topRiskReject.key}`);
    if (Number(runtimeGap.gap) > 0) {
      reasons.push(`runtime gap ${formatAmount(runtimeGap.gap, market)} (${formatAmount(runtimeGap.attempted, market)} < ${formatAmount(runtimeGap.required, market)})`);
    }
    if (status === 'min_order_ok') {
      status = 'min_order_runtime_pressure';
      headline = 'signal row는 적지만 runtime 메타 기준 최소 주문 병목이 실제로 관찰됩니다.';
    }
  }
  if (orderDefaults) {
    reasons.push(`현재 기본 주문값 buyDefault=${formatAmount(orderDefaults.buyDefault, market)} / min=${formatAmount(orderDefaults.min, market)}`);
  }

  if (status === 'min_order_pressure' || status === 'min_order_runtime_pressure') {
    actionItems.push('주문 기본값과 현재 최소 주문 가드 gap이 실제 운영 데이터 기준으로 얼마나 벌어지는지 계속 누적합니다.');
    actionItems.push('allow 후보 검증 시 min order pressure를 blocked 근거로 함께 확인합니다.');
  } else if (status === 'min_order_watch') {
    actionItems.push('현재는 watch 수준이므로 신규 runtime 세션을 더 누적합니다.');
  } else {
    actionItems.push('현재 수준을 유지하며 신규 min order block 발생 여부만 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      withGap: withGap.length,
      avgGap,
      maxGap: maxGapRow ? Number(maxGapRow.gap || 0) : 0,
    },
  };
}

function renderText(payload) {
  const lines = [
    '💵 Runtime Min Order Pressure',
    `market: ${payload.market}`,
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '상위 블록:',
    ...(payload.rows.length > 0
      ? payload.rows.slice(0, 5).map((row) =>
          `- ${row.symbol} | mode=${row.tradeMode} | attempted=${formatAmount(row.attempted, payload.market)} | required=${formatAmount(row.required, payload.market)} | gap=${formatAmount(row.gap, payload.market)}`
        )
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

async function loadMinOrderRows({ market = 'kis', days = 14 } = {}) {
  const safeMarket = String(market).replace(/'/g, "''");
  const safeDays = Math.max(1, Number(days || 14));
  const rows = await db.query(`
    SELECT
      symbol,
      exchange,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      created_at,
      block_reason
    FROM investment.signals
    WHERE exchange = '${safeMarket}'
      AND COALESCE(block_code, '') = 'min_order_notional'
      AND status IN ('failed', 'blocked', 'rejected')
      AND created_at > now() - INTERVAL '${safeDays} days'
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return rows.map((row) => {
    const gap = extractGap(row.block_reason);
    return {
      symbol: row.symbol,
      exchange: row.exchange,
      tradeMode: row.trade_mode,
      createdAt: row.created_at,
      blockReason: row.block_reason,
      attempted: gap.attempted,
      required: gap.required,
      gap: gap.gap,
    };
  });
}

export async function buildRuntimeMinOrderPressureReport({ market = 'kis', days = 14, json = false } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const rows = await loadMinOrderRows({ market: normalizedMarket, days });
  const runtimeMarket =
    normalizedMarket === 'kis' ? 'domestic' :
    normalizedMarket === 'kis_overseas' ? 'overseas' : 'crypto';
  const runtime = await buildRuntimeDecisionSummary({ market: runtimeMarket, limit: 5, json: true }).catch(() => null);
  const runtimeConfig = getInvestmentRuntimeConfig();
  const orderDefaults =
    normalizedMarket === 'kis' ? runtimeConfig?.luna?.stockOrderDefaults?.kis :
    normalizedMarket === 'kis_overseas' ? runtimeConfig?.luna?.stockOrderDefaults?.kis_overseas :
    null;
  const decision = buildDecision({
    market: normalizedMarket,
    rows,
    runtime,
    orderDefaults,
  });
  const payload = {
    ok: true,
    market: normalizedMarket,
    days,
    count: rows.length,
    orderDefaults,
    runtime,
    rows,
    decision,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeMinOrderPressureReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-min-order-pressure-report 오류:',
  });
}

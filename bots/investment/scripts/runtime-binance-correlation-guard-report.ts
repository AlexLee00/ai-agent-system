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

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(
    `SELECT
       symbol,
       action,
       COALESCE(trade_mode, 'normal') AS trade_mode,
       block_reason,
       block_meta,
       created_at
     FROM signals
     WHERE exchange = 'binance'
       AND status = 'failed'
       AND block_code = 'capital_guard_rejected'
       AND block_reason LIKE '상관관계 가드:%'
       AND created_at > now() - INTERVAL '${safeDays} days'
     ORDER BY created_at DESC`
  );
}

function countBy(rows = [], keyFn = (row) => row) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function summarize(rows = []) {
  const byTradeMode = countBy(rows, (row) => row.trade_mode);
  const bySymbol = countBy(rows, (row) => row.symbol).slice(0, 8);
  const byOpenPositions = countBy(rows, (row) => String(Number(row.block_meta?.openPositions || 0)));

  const bursts = new Map();
  for (const row of rows) {
    const ts = new Date(row.created_at).getTime();
    const bucket = Number.isFinite(ts) ? new Date(Math.floor(ts / 3600000) * 3600000).toISOString() : 'unknown';
    const value = bursts.get(bucket) || { bucket, count: 0, symbols: new Set(), tradeModes: new Set() };
    value.count += 1;
    value.symbols.add(row.symbol);
    value.tradeModes.add(row.trade_mode);
    bursts.set(bucket, value);
  }

  const topBursts = [...bursts.values()]
    .map((item) => ({
      bucket: item.bucket,
      count: item.count,
      symbols: [...item.symbols].sort(),
      tradeModes: [...item.tradeModes].sort(),
    }))
    .sort((a, b) => b.count - a.count || String(b.bucket).localeCompare(String(a.bucket)))
    .slice(0, 5);

  return {
    total: rows.length,
    byTradeMode,
    bySymbol,
    byOpenPositions,
    topBursts,
  };
}

function buildDecision(summary) {
  const topMode = summary.byTradeMode[0] || null;
  const topSymbol = summary.bySymbol[0] || null;
  const topBurst = summary.topBursts[0] || null;
  const total = Number(summary.total || 0);

  let status = 'binance_correlation_guard_ok';
  let headline = '크립토 correlation guard 압력은 비교적 안정적입니다.';
  const reasons = [
    `최근 correlation guard ${total}건`,
    `레인 분포: ${(summary.byTradeMode || []).map((item) => `${item.key} ${item.count}`).join(' | ') || '없음'}`,
    `집중 심볼: ${(summary.bySymbol || []).slice(0, 4).map((item) => `${item.key} ${item.count}`).join(' | ') || '없음'}`,
  ];
  const actionItems = [];

  if (total >= 10) {
    status = 'binance_correlation_guard_pressure';
    headline = '크립토 correlation guard가 한쪽 방향 포지션 집중으로 반복되고 있습니다.';
  } else if (total > 0) {
    status = 'binance_correlation_guard_watch';
    headline = '크립토 correlation guard가 간헐적으로 관찰됩니다.';
  }

  if (topMode) {
    actionItems.push(`${topMode.key} 레인에서 포지션 방향 쏠림이 큰지 먼저 확인합니다.`);
  }
  if (topSymbol) {
    actionItems.push(`${topSymbol.key} 주변 심볼군 진입이 반복되는지 함께 복기합니다.`);
  }
  if (topBurst) {
    actionItems.push(`집중 시간대 ${topBurst.bucket}의 동시 진입 후보(${topBurst.symbols.slice(0, 4).join(', ')})를 확인합니다.`);
  }
  if (actionItems.length === 0) {
    actionItems.push('현재는 correlation guard 추세만 계속 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      topTradeMode: topMode?.key || null,
      topTradeModeCount: Number(topMode?.count || 0),
      topSymbol: topSymbol?.key || null,
      topSymbolCount: Number(topSymbol?.count || 0),
      topBurstCount: Number(topBurst?.count || 0),
    },
  };
}

function renderText(payload) {
  const lines = [
    '🔗 Runtime Binance Correlation Guard',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((item) => `- ${item}`),
    '',
    '집중 버스트:',
    ...(payload.summary.topBursts.length > 0
      ? payload.summary.topBursts.slice(0, 3).map((item) => `- ${item.bucket} | ${item.count}건 | ${item.tradeModes.join('+')} | ${item.symbols.slice(0, 5).join(', ')}`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'binance_correlation_guard_pressure') {
    return '크립토 correlation guard가 반복돼, 레인별 포지션 방향 쏠림과 집중 심볼군을 먼저 보는 것이 좋습니다.';
  }
  if (decision.status === 'binance_correlation_guard_watch') {
    return '크립토 correlation guard가 간헐적으로 보여, 레인별 분포와 집중 시간대를 같이 보는 편이 좋습니다.';
  }
  return '크립토 correlation guard 압력은 비교적 안정적입니다.';
}

export async function buildRuntimeBinanceCorrelationGuardReport({ days = 14, json = false } = {}) {
  const rows = await loadRows(days);
  const summary = summarize(rows);
  const decision = buildDecision(summary);
  const payload = {
    ok: true,
    days,
    count: rows.length,
    rows,
    summary,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-binance-correlation-guard-report',
    requestType: 'runtime-binance-correlation-guard-report',
    title: '투자 correlation guard 리포트 요약',
    data: { days, summary, decision },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceCorrelationGuardReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-correlation-guard-report 오류:',
  });
}

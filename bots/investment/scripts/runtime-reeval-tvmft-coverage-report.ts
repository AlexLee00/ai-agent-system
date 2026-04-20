#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const exchangeArg = argv.find((arg) => arg.startsWith('--exchange='));
  const tradeModeArg = argv.find((arg) => arg.startsWith('--trade-mode='));
  return {
    days: Math.max(3, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(10, Number(limitArg?.split('=')[1] || 200)),
    exchange: exchangeArg?.split('=')[1] || 'binance',
    tradeMode: tradeModeArg?.split('=')[1] || 'normal',
    paper: argv.includes('--paper'),
    json: argv.includes('--json'),
  };
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

async function loadRows({ days, limit, exchange, tradeMode, paper }) {
  const openPositions = await db.getOpenPositions(exchange, paper, tradeMode).catch(() => []);
  const openSymbols = new Set((openPositions || []).map((row) => String(row.symbol || '').trim()).filter(Boolean));
  if (openSymbols.size === 0) return [];

  const rows = await db.query(
    `
      SELECT
        symbol,
        recommendation,
        reason_code,
        analysis_snapshot,
        created_at
      FROM position_reevaluation_runs
      WHERE exchange = $1
        AND trade_mode = $2
        AND paper = $3
        AND created_at >= NOW() - ($4::text || ' days')::interval
      ORDER BY created_at DESC
      LIMIT $5
    `,
    [exchange, tradeMode, paper === true, String(days), limit],
  );

  const latestBySymbol = new Map();
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim();
    if (!openSymbols.has(symbol)) continue;
    if (!latestBySymbol.has(symbol)) latestBySymbol.set(symbol, row);
  }
  return Array.from(latestBySymbol.values());
}

function hasLiveIndicator(row) {
  return Boolean(row?.analysis_snapshot?.liveIndicator);
}

function buildDecision(rows = [], exchange = 'binance') {
  const totalSymbols = rows.length;
  const liveRows = rows.filter((row) => hasLiveIndicator(row));
  const legacyRows = rows.filter((row) => !hasLiveIndicator(row));
  const coverageRate = totalSymbols > 0 ? round((liveRows.length / totalSymbols) * 100, 1) : 0;

  let status = 'reeval_tvmft_coverage_ready';
  let headline = '최근 포지션 재평가 표본이 TV-MTF 기준으로 잘 쌓이고 있습니다.';
  const reasons = [
    `최신 표본 ${totalSymbols}개`,
    `TV-MTF 표본 ${liveRows.length}개`,
    `coverage ${coverageRate}%`,
  ];
  const actionItems = [];

  if (totalSymbols === 0) {
    status = 'reeval_tvmft_coverage_idle';
    headline = '최근 포지션 재평가 표본이 없어 TV-MTF 커버리지를 판단할 수 없습니다.';
    actionItems.push('포지션 재평가 루프가 더 누적될 때까지 커버리지 표본을 관찰합니다.');
  } else if (coverageRate < 50) {
    status = 'reeval_tvmft_coverage_gap';
    headline = 'TV-MTF 표본 비중이 낮아 autotune보다 커버리지 확보가 먼저입니다.';
    actionItems.push('최근 재평가 배치에서 live indicator가 붙지 않은 legacy 표본을 먼저 줄입니다.');
  } else if (coverageRate < 80) {
    status = 'reeval_tvmft_coverage_watch';
    headline = 'TV-MTF 표본은 들어오고 있지만 아직 커버리지가 충분하진 않습니다.';
    actionItems.push('다음 재평가 배치에서 coverage가 80% 이상으로 올라오는지 관찰합니다.');
  } else {
    actionItems.push('현재 커버리지를 유지하며 autotune 후보를 계속 누적합니다.');
  }

  if (legacyRows.length > 0) {
    reasons.push(`legacy 표본 ${legacyRows.length}개`);
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      exchange,
      totalSymbols,
      liveCoverage: liveRows.length,
      legacyCoverage: legacyRows.length,
      coverageRate,
      liveSymbols: liveRows.map((row) => row.symbol),
      legacySymbols: legacyRows.map((row) => row.symbol),
    },
  };
}

function renderText(payload) {
  return [
    '📡 Runtime Reevaluation TV-MTF Coverage',
    `exchange: ${payload.exchange}`,
    `tradeMode: ${payload.tradeMode}`,
    `paper: ${payload.paper}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload) {
  const status = payload?.decision?.status;
  if (status === 'reeval_tvmft_coverage_gap') {
    return 'TV-MTF autotune보다 먼저, 포지션 재평가 표본에 live indicator가 충분히 붙는지부터 보강하는 편이 좋습니다.';
  }
  if (status === 'reeval_tvmft_coverage_watch') {
    return 'TV-MTF 표본은 들어오고 있지만 아직 커버리지가 애매해서 몇 배치 더 관찰하는 편이 안정적입니다.';
  }
  if (status === 'reeval_tvmft_coverage_ready') {
    return 'TV-MTF 표본 커버리지는 대체로 안정적이라 autotune 후보를 계속 읽어갈 수 있습니다.';
  }
  return '최근 포지션 재평가 표본이 적어 TV-MTF 커버리지를 아직 판단하기 어렵습니다.';
}

export async function buildRuntimeReevalTvMtfCoverageReport({
  days = 14,
  limit = 200,
  exchange = 'binance',
  tradeMode = 'normal',
  paper = false,
  json = false,
} = {}) {
  const rows = await loadRows({ days, limit, exchange, tradeMode, paper });
  const decision = buildDecision(rows, exchange);
  const payload = {
    ok: true,
    days,
    limit,
    exchange,
    tradeMode,
    paper,
    rows,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-reeval-tvmft-coverage-report',
    requestType: 'runtime-reeval-tvmft-coverage-report',
    title: '투자 포지션 재평가 TV-MTF coverage 리포트 요약',
    data: {
      days,
      limit,
      exchange,
      tradeMode,
      paper,
      decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeReevalTvMtfCoverageReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-reeval-tvmft-coverage-report 오류:',
  });
}

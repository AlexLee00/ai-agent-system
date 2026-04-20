#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeReevalTvMtfAutotuneReport } from './runtime-reeval-tvmft-autotune-report.ts';
import { buildRuntimeReevalTvMtfCoverageReport } from './runtime-reeval-tvmft-coverage-report.ts';

const AUTOTUNE_HISTORY_FILE = '/tmp/investment-runtime-reeval-tvmft-autotune-history.jsonl';
const COVERAGE_HISTORY_FILE = '/tmp/investment-runtime-reeval-tvmft-coverage-history.jsonl';

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

function readHistory(file, { exchange, tradeMode, paper }) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter((row) =>
      row.exchange === exchange &&
      String(row.tradeMode || 'normal') === String(tradeMode || 'normal') &&
      Boolean(row.paper) === Boolean(paper),
    );
}

function countTailWhere(rows = [], predicate, size = 3) {
  return rows.slice(-size).filter(predicate).length;
}

function buildDecision({ autotune, coverage, autotuneHistory, coverageHistory }) {
  const autoDecision = autotune?.decision || {};
  const coverageDecision = coverage?.decision || {};
  const autoMetrics = autoDecision.metrics || {};
  const coverageMetrics = coverageDecision.metrics || {};

  const recentObserveCount = countTailWhere(autotuneHistory, (row) => row.status === 'reeval_tvmft_autotune_observe', 3);
  const recentCoverageReadyCount = countTailWhere(coverageHistory, (row) => row.status === 'reeval_tvmft_coverage_ready', 3);
  const recentDivergenceCount = countTailWhere(autotuneHistory, (row) => Number(row.dailyDivergenceHold || 0) > 0, 3);

  const reasons = [
    `autotune: ${autoDecision.status || 'unknown'}`,
    `coverage: ${coverageDecision.status || 'unknown'}`,
    `최근 3회 observe ${recentObserveCount}회`,
    `최근 3회 coverage_ready ${recentCoverageReadyCount}회`,
    `최근 3회 divergence ${recentDivergenceCount}회`,
  ];

  let status = 'reeval_tvmft_trend_observe';
  let headline = 'TV-MTF 표본을 더 누적하면서 divergence 반복 여부를 관찰하는 구간입니다.';
  const actionItems = [
    '다음 재평가 배치에서 divergence HOLD가 반복되는지 계속 누적합니다.',
  ];

  if (Number(coverageMetrics.totalSymbols || 0) === 0) {
    status = 'reeval_tvmft_trend_idle';
    headline = '현재 오픈 포지션 표본이 없어 TV-MTF trend를 판단할 수 없습니다.';
    actionItems[0] = '오픈 포지션이 생기거나 재평가가 더 쌓일 때까지 trend 판단을 보류합니다.';
  } else if (coverageDecision.status !== 'reeval_tvmft_coverage_ready') {
    status = 'reeval_tvmft_trend_coverage_first';
    headline = 'autotune보다 TV-MTF 커버리지 안정화가 우선입니다.';
    actionItems[0] = 'live indicator가 붙는 재평가 커버리지를 먼저 안정적으로 유지합니다.';
  } else if (
    recentCoverageReadyCount >= 2 &&
    recentObserveCount >= 2 &&
    recentDivergenceCount >= 2 &&
    Number(autoMetrics.totalSymbols || 0) >= 1 &&
    Number(autoMetrics.dailyDivergenceHoldCount || 0) >= 1
  ) {
    status = 'reeval_tvmft_trend_ready';
    headline = 'TV-MTF divergence가 반복돼 다음엔 threshold/weight 후보 검토를 시작할 수 있습니다.';
    actionItems[0] = '다음 배치에서 divergence가 한 번 더 반복되면 1d weight 또는 buy threshold dry-run 후보를 검토합니다.';
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      totalSymbols: Number(coverageMetrics.totalSymbols || 0),
      liveCoverage: Number(coverageMetrics.liveCoverage || 0),
      recentObserveCount,
      recentCoverageReadyCount,
      recentDivergenceCount,
      currentDivergence: Number(autoMetrics.dailyDivergenceHoldCount || 0),
      currentCandidates: Number(autoDecision.candidates?.length || 0),
    },
  };
}

function renderText(payload) {
  return [
    '📈 Runtime Reevaluation TV-MTF Trend',
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
  if (status === 'reeval_tvmft_trend_ready') {
    return 'TV-MTF divergence가 반복돼 이제는 weight나 threshold 후보를 dry-run으로 검토할 수 있습니다.';
  }
  if (status === 'reeval_tvmft_trend_coverage_first') {
    return '지금은 autotune보다 coverage를 먼저 안정화하는 편이 맞습니다.';
  }
  if (status === 'reeval_tvmft_trend_idle') {
    return '현재 오픈 포지션 표본이 적어 TV-MTF trend를 아직 판단하기 어렵습니다.';
  }
  return '지금은 TV-MTF 표본을 더 누적하면서 divergence가 반복되는지 계속 관찰하는 단계입니다.';
}

export async function buildRuntimeReevalTvMtfTrendReport({
  days = 14,
  limit = 200,
  exchange = 'binance',
  tradeMode = 'normal',
  paper = false,
  json = false,
} = {}) {
  const [autotune, coverage] = await Promise.all([
    buildRuntimeReevalTvMtfAutotuneReport({ days, limit, exchange, tradeMode, paper, json: true }).catch(() => null),
    buildRuntimeReevalTvMtfCoverageReport({ days, limit, exchange, tradeMode, paper, json: true }).catch(() => null),
  ]);
  const historyKey = { exchange, tradeMode, paper };
  const autotuneHistory = readHistory(AUTOTUNE_HISTORY_FILE, historyKey);
  const coverageHistory = readHistory(COVERAGE_HISTORY_FILE, historyKey);
  const decision = buildDecision({ autotune, coverage, autotuneHistory, coverageHistory });

  const payload = {
    ok: true,
    days,
    limit,
    exchange,
    tradeMode,
    paper,
    autotune,
    coverage,
    autotuneHistoryCount: autotuneHistory.length,
    coverageHistoryCount: coverageHistory.length,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-reeval-tvmft-trend-report',
    requestType: 'runtime-reeval-tvmft-trend-report',
    title: '투자 포지션 재평가 TV-MTF trend 리포트 요약',
    data: {
      days,
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
  const result = await buildRuntimeReevalTvMtfTrendReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-reeval-tvmft-trend-report 오류:',
  });
}

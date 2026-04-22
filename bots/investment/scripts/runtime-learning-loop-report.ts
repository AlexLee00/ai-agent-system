#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeDecisionReport } from './runtime-decision-report.ts';
import { buildRuntimeCryptoExecutionGateReport } from './runtime-crypto-execution-gate-report.ts';
import { buildRuntimeCryptoGuardAutotuneReport } from './runtime-crypto-guard-autotune-report.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';
import { validateTradeReview } from './validate-trade-review.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function ageHours(value) {
  const ts = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round(((Date.now() - ts) / 3600000) * 10) / 10);
}

function formatAge(hours) {
  if (hours == null) return 'n/a';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

async function loadLoopFreshness() {
  await db.initSchema();
  const [runtimeRow, reviewRow, backtestRow, suggestionRows] = await Promise.all([
    db.get(`
      SELECT started_at
      FROM pipeline_runs
      WHERE pipeline = 'luna_pipeline'
        AND meta->>'bridge_status' IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1
    `).catch(() => null),
    db.get(`
      SELECT reviewed_at
      FROM investment.trade_review
      ORDER BY reviewed_at DESC
      LIMIT 1
    `).catch(() => null),
    db.get(`
      SELECT created_at
      FROM vectorbt_backtest_runs
      ORDER BY created_at DESC
      LIMIT 1
    `).catch(() => null),
    db.getRecentRuntimeConfigSuggestionLogs(1).catch(() => []),
  ]);

  const latestSuggestion = Array.isArray(suggestionRows) ? suggestionRows[0] || null : null;
  return {
    latestRuntimeSessionAt: runtimeRow?.started_at ? new Date(Number(runtimeRow.started_at)) : null,
    latestTradeReviewAt: reviewRow?.reviewed_at ? new Date(Number(reviewRow.reviewed_at)) : null,
    latestBacktestAt: backtestRow?.created_at || null,
    latestSuggestionAt: latestSuggestion?.captured_at || null,
    latestSuggestionReviewStatus: latestSuggestion?.review_status || null,
    latestSuggestionActionableCount: Number(latestSuggestion?.actionable_count || 0),
  };
}

async function loadRegimeCoverage(days = 90) {
  await db.initSchema();
  const safeDays = Math.max(14, Number(days || 90));
  const sinceEpochMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;
  const [tradeRows, snapshotRows] = await Promise.all([
    db.query(`
      SELECT
        j.exchange,
        COALESCE(NULLIF(j.market_regime, ''), r.strategy_config->'market_regime'->>'regime', 'unknown') AS regime,
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(j.trade_mode, 'normal') = 'validation' THEN 1 ELSE 0 END) AS validation_trades,
        SUM(CASE WHEN COALESCE(j.trade_mode, 'normal') = 'normal' THEN 1 ELSE 0 END) AS normal_trades,
        MAX(j.created_at) AS latest_trade_at
      FROM investment.trade_journal j
      LEFT JOIN investment.trade_rationale r ON r.trade_id = j.trade_id
      WHERE j.created_at >= $1
      GROUP BY 1, 2
      ORDER BY total DESC, exchange ASC, regime ASC
    `, [sinceEpochMs]).catch(() => []),
    db.query(`
      SELECT
        market,
        regime,
        COUNT(*) AS snapshots,
        MAX(captured_at) AS latest_captured_at
      FROM investment.market_regime_snapshots
      WHERE captured_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY 1, 2
      ORDER BY snapshots DESC, market ASC, regime ASC
    `, [safeDays]).catch(() => []),
  ]);

  const latestByMarketRows = await db.query(`
    SELECT DISTINCT ON (market)
      market,
      regime,
      confidence,
      captured_at
    FROM investment.market_regime_snapshots
    ORDER BY market, captured_at DESC
  `).catch(() => []);

  const byRegime = {};
  const byExchange = {};
  for (const row of tradeRows) {
    const regime = String(row.regime || 'unknown');
    const exchange = String(row.exchange || 'unknown');
    byRegime[regime] = {
      regime,
      total: (byRegime[regime]?.total || 0) + Number(row.total || 0),
      validationTrades: (byRegime[regime]?.validationTrades || 0) + Number(row.validation_trades || 0),
      normalTrades: (byRegime[regime]?.normalTrades || 0) + Number(row.normal_trades || 0),
      latestTradeAt: byRegime[regime]?.latestTradeAt || toIso(Number(row.latest_trade_at || 0)),
    };
    byExchange[exchange] = byExchange[exchange] || [];
    byExchange[exchange].push({
      regime,
      total: Number(row.total || 0),
      validationTrades: Number(row.validation_trades || 0),
      normalTrades: Number(row.normal_trades || 0),
      latestTradeAt: toIso(Number(row.latest_trade_at || 0)),
    });
  }

  const distinctTradedRegimes = Object.values(byRegime)
    .filter((item) => Number(item.total || 0) > 0 && item.regime !== 'unknown')
    .length;
  const unknownTrades = Number(byRegime.unknown?.total || 0);
  const knownRegimeTrades = Object.values(byRegime)
    .filter((item) => item.regime !== 'unknown')
    .reduce((sum, item) => sum + Number(item.total || 0), 0);

  return {
    windowDays: safeDays,
    tradeRows,
    snapshotRows,
    snapshotCount: snapshotRows.reduce((sum, row) => sum + Number(row.snapshots || 0), 0),
    latestByMarket: latestByMarketRows.map((row) => ({
      market: row.market,
      regime: row.regime,
      confidence: Number(row.confidence || 0),
      capturedAt: row.captured_at || null,
    })),
    byRegime: Object.values(byRegime).sort((a, b) => Number(b.total || 0) - Number(a.total || 0)),
    byExchange,
    distinctTradedRegimes,
    unknownTrades,
    knownRegimeTrades,
  };
}

function buildSectionStates({
  freshness,
  runtimeDecision,
  executionGate,
  autotune,
  backtest,
  validation,
  regimeCoverage,
}) {
  const runtimeAge = ageHours(freshness.latestRuntimeSessionAt);
  const reviewAge = ageHours(freshness.latestTradeReviewAt);
  const backtestAge = ageHours(freshness.latestBacktestAt);
  const suggestionAge = ageHours(freshness.latestSuggestionAt);

  const collect = {
    status: runtimeDecision.count === 0
      ? 'idle'
      : Number(runtimeDecision.summary?.approvedSignals || 0) === 0 && Number(runtimeDecision.summary?.executedSymbols || 0) === 0
        ? 'thin'
        : runtimeAge != null && runtimeAge <= 12
          ? 'active'
          : 'watch',
    latestAt: toIso(freshness.latestRuntimeSessionAt),
    ageHours: runtimeAge,
    approvedSignals: Number(runtimeDecision.summary?.approvedSignals || 0),
    executedSymbols: Number(runtimeDecision.summary?.executedSymbols || 0),
    warnings: Array.isArray(runtimeDecision.summary?.warnings) ? runtimeDecision.summary.warnings : [],
    headline:
      Number(runtimeDecision.summary?.approvedSignals || 0) === 0 && Number(runtimeDecision.summary?.executedSymbols || 0) === 0
        ? '세션은 돌고 있지만 승인/실행 표본이 비어 있어 학습 루프 밀도가 낮습니다.'
        : runtimeDecision.aiSummary || runtimeDecision.summary?.warnings?.[0] || 'runtime decision 수집 상태를 확인합니다.',
    regimeCoverage: {
      windowDays: regimeCoverage.windowDays,
      distinctTradedRegimes: Number(regimeCoverage.distinctTradedRegimes || 0),
      unknownTrades: Number(regimeCoverage.unknownTrades || 0),
      knownRegimeTrades: Number(regimeCoverage.knownRegimeTrades || 0),
      snapshotCount: Number(regimeCoverage.snapshotCount || 0),
      topRegimes: regimeCoverage.byRegime.slice(0, 4),
      latestByMarket: regimeCoverage.latestByMarket,
    },
  };

  const analyze = {
    status: backtest.decision?.status === 'backtest_attention'
      ? 'attention'
      : backtest.rows?.length > 0 && backtestAge != null && backtestAge <= 72
        ? 'active'
        : backtest.rows?.length > 0
          ? 'watch'
          : 'idle',
    latestAt: toIso(freshness.latestBacktestAt),
    ageHours: backtestAge,
    backtestStatus: backtest.decision?.status || 'unknown',
    topSharpe: backtest.decision?.metrics?.bestSharpe || null,
    executionGateStatus: executionGate.decision?.status || 'unknown',
    headline: backtest.decision?.headline || '백테스트/실행 게이트 분석 상태를 확인합니다.',
  };

  const feedback = {
    status: Number(validation.findings || 0) > 0
      ? 'repair'
      : reviewAge != null && reviewAge <= 36
        ? 'active'
        : freshness.latestTradeReviewAt
          ? 'watch'
          : 'idle',
    latestAt: toIso(freshness.latestTradeReviewAt),
    ageHours: reviewAge,
    validationFindings: Number(validation.findings || 0),
    closedTrades: Number(validation.closedTrades || 0),
    headline: Number(validation.findings || 0) > 0
      ? `trade review 정합성 이슈 ${validation.findings}건이 남아 있습니다.`
      : 'trade review / 피드백 루프는 비교적 안정적입니다.',
  };

  const strategy = {
    status: autotune.decision?.status === 'crypto_guard_autotune_ready'
      ? 'ready'
      : freshness.latestSuggestionAt && suggestionAge != null && suggestionAge <= 72
        ? 'active'
        : freshness.latestSuggestionAt
          ? 'watch'
          : 'idle',
    latestAt: toIso(freshness.latestSuggestionAt),
    ageHours: suggestionAge,
    autotuneStatus: autotune.decision?.status || 'unknown',
    actionableSuggestions: Math.max(
      Number(autotune.decision?.metrics?.actionableCount || 0),
      Number(freshness.latestSuggestionActionableCount || 0),
    ),
    reviewStatus: freshness.latestSuggestionReviewStatus || 'none',
    headline: autotune.decision?.headline || '전략 수정 후보를 확인합니다.',
  };

  return { collect, analyze, feedback, strategy };
}

function buildDecision(sections = {}) {
  const nextActions = [];
  let status = 'learning_loop_active';
  let headline = '수집-분석-피드백-전략 수정 루프가 계속 돌고 있습니다.';

  if (sections.collect.status === 'idle') {
    status = 'collect_bootstrap_needed';
    headline = '수집 루프가 비어 있어 먼저 runtime decision 세션을 쌓아야 합니다.';
    nextActions.push('crypto/domestic/overseas 런타임 세션을 다시 돌려 표본을 먼저 확보합니다.');
  } else if (Number(sections.collect.regimeCoverage?.snapshotCount || 0) === 0) {
    status = 'regime_snapshot_bootstrap_needed';
    headline = '거래 저널에 붙일 장세 스냅샷이 아직 없어 bull/bear/ranging/volatile 표본 분리가 시작되지 못하고 있습니다.';
    nextActions.push('nemesis 장세 감지 스냅샷을 먼저 누적하고, 그 뒤 journal regime backfill로 기존 체결 표본을 다시 연결합니다.');
  } else if (
    Number(sections.collect.regimeCoverage?.knownRegimeTrades || 0) === 0 &&
    Number(sections.collect.regimeCoverage?.unknownTrades || 0) > 0
  ) {
    status = 'regime_persistence_missing';
    headline = '거래는 쌓였지만 레짐 정보가 unknown으로만 남아 장세별 학습이 끊기고 있습니다.';
    nextActions.push('signal/trade/rationale 경로에 market_regime를 안정적으로 남겨 bull/bear/ranging/volatile 표본을 분리합니다.');
  } else if (Number(sections.collect.regimeCoverage?.distinctTradedRegimes || 0) < 2) {
    status = 'regime_sample_thin';
    headline = '거래 표본이 특정 장세에 치우쳐 있어 레짐별 전략 학습 데이터를 더 넓혀야 합니다.';
    nextActions.push('validation lane을 유지하면서 bull/bear/ranging/volatile 레짐별 표본이 끊기지 않게 관리합니다.');
  } else if (sections.collect.status === 'thin') {
    status = 'learning_sample_thin';
    headline = '세션은 돌지만 승인/실행 표본이 얇아 validation 표본을 더 쌓아야 합니다.';
    nextActions.push('validation lane과 runtime-suggest dry-run을 함께 돌려 승인/실행 표본을 늘립니다.');
  } else if (sections.feedback.status === 'repair') {
    status = 'feedback_repair_needed';
    headline = '피드백 루프 정합성 이슈가 남아 있어 review 데이터를 먼저 복구해야 합니다.';
    nextActions.push('validate-review로 trade_review 누락/불일치를 먼저 정리합니다.');
  } else if (sections.strategy.status === 'ready') {
    status = 'strategy_update_ready';
    headline = '운영 압력을 줄일 전략 수정 후보가 준비돼 있어 빠르게 검토할 가치가 있습니다.';
    nextActions.push('runtime-suggest 또는 guard autotune 후보를 dry-run으로 비교합니다.');
  } else if (sections.analyze.status === 'idle' || sections.analyze.status === 'watch') {
    status = 'analysis_refresh_needed';
    headline = '분석 루프 신선도가 떨어져 backtest/execution gate 재평가가 먼저입니다.';
    nextActions.push('backtest:report와 runtime execution gate를 다시 점검합니다.');
  }

  if (nextActions.length === 0) {
    nextActions.push('지금처럼 validation lane과 feedback/review 데이터를 계속 누적합니다.');
  }

  return {
    status,
    headline,
    nextActions,
    reasons: [
      `collect=${sections.collect.status} (${formatAge(sections.collect.ageHours)})`,
      `analyze=${sections.analyze.status} (${formatAge(sections.analyze.ageHours)})`,
      `feedback=${sections.feedback.status} (${formatAge(sections.feedback.ageHours)})`,
      `strategy=${sections.strategy.status} (${formatAge(sections.strategy.ageHours)})`,
    ],
  };
}

function renderText(payload) {
  const { sections, decision } = payload;
  return [
    '♻️ Runtime Learning Loop',
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '수집:',
    `- ${sections.collect.status} | latest=${sections.collect.latestAt || 'n/a'} (${formatAge(sections.collect.ageHours)})`,
    `- approved ${sections.collect.approvedSignals} / executed ${sections.collect.executedSymbols}`,
    `- regime coverage ${sections.collect.regimeCoverage?.distinctTradedRegimes || 0}종 | known ${sections.collect.regimeCoverage?.knownRegimeTrades || 0} / unknown ${sections.collect.regimeCoverage?.unknownTrades || 0}`,
    `- regime snapshots ${sections.collect.regimeCoverage?.snapshotCount || 0}건`,
    `- top regimes ${((sections.collect.regimeCoverage?.topRegimes || []).map((item) => `${item.regime}:${item.total}`).join(', ')) || 'none'}`,
    `- ${sections.collect.headline}`,
    '',
    '분석:',
    `- ${sections.analyze.status} | latest=${sections.analyze.latestAt || 'n/a'} (${formatAge(sections.analyze.ageHours)})`,
    `- backtest=${sections.analyze.backtestStatus} | gate=${sections.analyze.executionGateStatus}`,
    `- ${sections.analyze.headline}`,
    '',
    '피드백:',
    `- ${sections.feedback.status} | latest=${sections.feedback.latestAt || 'n/a'} (${formatAge(sections.feedback.ageHours)})`,
    `- closedTrades ${sections.feedback.closedTrades} / findings ${sections.feedback.validationFindings}`,
    `- ${sections.feedback.headline}`,
    '',
    '전략 수정:',
    `- ${sections.strategy.status} | latest=${sections.strategy.latestAt || 'n/a'} (${formatAge(sections.strategy.ageHours)})`,
    `- autotune=${sections.strategy.autotuneStatus} | actionable=${sections.strategy.actionableSuggestions} | review=${sections.strategy.reviewStatus}`,
    `- ${sections.strategy.headline}`,
    '',
    '다음 액션:',
    ...decision.nextActions.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'feedback_repair_needed') {
    return '피드백 정합성 이슈가 남아 있어 review 데이터 복구가 우선입니다.';
  }
  if (decision.status === 'strategy_update_ready') {
    return '전략 수정 후보가 준비돼 있어 soft guard와 validation lane 조정을 검토할 시점입니다.';
  }
  if (decision.status === 'analysis_refresh_needed') {
    return '수집은 돌고 있지만 분석 신선도가 떨어져 backtest/execution gate 재평가가 먼저입니다.';
  }
  if (decision.status === 'collect_bootstrap_needed') {
    return '수집 표본이 부족해 런타임 세션을 더 쌓는 것이 먼저입니다.';
  }
  if (decision.status === 'regime_snapshot_bootstrap_needed') {
    return '장세 스냅샷이 아직 없어 먼저 nemesis 기반 regime snapshot을 누적해야 합니다.';
  }
  return '수집-분석-피드백-전략 수정 루프를 계속 굴리며 validation 표본을 누적하는 상태입니다.';
}

export async function buildRuntimeLearningLoopReport({ days = 14, json = false } = {}) {
  const [freshness, runtimeDecision, executionGate, autotune, backtest, validation, regimeCoverage] = await Promise.all([
    loadLoopFreshness(),
    buildRuntimeDecisionReport({ market: 'all', limit: 5, json: true }).catch(() => ({ count: 0, summary: {}, rows: [] })),
    buildRuntimeCryptoExecutionGateReport({ days, json: true }).catch(() => ({ decision: {} })),
    buildRuntimeCryptoGuardAutotuneReport({ days, json: true }).catch(() => ({ decision: { metrics: {} } })),
    buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => ({ rows: [], decision: { metrics: {} } })),
    validateTradeReview({ days: 90, fix: false }).catch(() => ({ findings: 0, closedTrades: 0, items: [] })),
    loadRegimeCoverage(90).catch(() => ({ windowDays: 90, byRegime: [], latestByMarket: [], distinctTradedRegimes: 0 })),
  ]);

  const sections = buildSectionStates({
    freshness,
    runtimeDecision,
    executionGate,
    autotune,
    backtest,
    validation,
    regimeCoverage,
  });
  const decision = buildDecision(sections);

  const payload = {
    ok: true,
    days,
    freshness,
    sections,
    decision,
    runtimeDecision,
    regimeCoverage,
    executionGate,
    autotune,
    backtest,
    validation,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-learning-loop-report',
    requestType: 'runtime-learning-loop-report',
    title: '투자 수집·분석·피드백·전략 수정 루프 요약',
    data: {
      days,
      sections,
      decision,
      runtimeDecision: runtimeDecision.summary,
      regimeCoverage,
      executionGate: executionGate.decision,
      autotune: autotune.decision,
      backtest: backtest.decision,
      validation,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeLearningLoopReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-learning-loop-report 오류:',
  });
}

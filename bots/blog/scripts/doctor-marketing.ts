#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const { execFileSync } = require('child_process');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const { readMarketingDigestTelemetry, describeMarketingDigestAge } = require('../lib/marketing-digest-telemetry.ts');
const { loadStrategyBundle } = require('../lib/strategy-loader.ts');
const { readLatestBlogEvalCase } = require('../lib/eval-case-telemetry.ts');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const BLOG_PREFIX = `npm --prefix ${BLOG_ROOT}`;
const AUTO_STRATEGY_REFRESH_RESULT_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'marketing-strategy-refresh.json');
const MARKETING_DIGEST_COMMAND = `${BLOG_PREFIX} run marketing:digest -- --json`;
const MARKETING_SNAPSHOT_COMMAND = `${BLOG_PREFIX} run marketing:snapshot -- --dry-run --json`;
const CHANNEL_INSIGHTS_COMMAND = `${BLOG_PREFIX} run channel:insights -- --dry-run --json`;
const REVENUE_STRATEGY_COMMAND = `${BLOG_PREFIX} run revenue:strategy -- --dry-run --json`;
const AUTO_STRATEGY_REFRESH_COMMAND = `${BLOG_PREFIX} run auto:strategy-refresh -- --json`;

function parseIsoDate(value = null) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readAutoStrategyRefreshResult() {
  try {
    const raw = fs.readFileSync(AUTO_STRATEGY_REFRESH_RESULT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function describeStrategyFreshness(plan = null) {
  const evolvedAt = String(plan?.evolvedAt || '').trim();
  const evolvedAtMs = parseIsoDate(evolvedAt);
  if (!evolvedAtMs) {
    return {
      evolvedAt: evolvedAt || null,
      ageMinutes: null,
      recentlyApplied: false,
    };
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - evolvedAtMs) / 60000));
  return {
    evolvedAt,
    ageMinutes,
    recentlyApplied: ageMinutes <= 180,
  };
}

function summarizeOperationalLearning(plan = null) {
  const patterns = Array.isArray(plan?.operationalLearning?.patterns)
    ? plan.operationalLearning.patterns
    : [];
  const findSummary = (type) => {
    const item = patterns.find((pattern) => String(pattern?.type || '') === type);
    return item?.summary ? String(item.summary) : '';
  };
  return {
    generatedAt: String(plan?.operationalLearning?.generatedAt || '') || null,
    titlePatternSummary: findSummary('ops_high_performance_title_pattern'),
    categorySummary: findSummary('ops_high_performance_category'),
    alignmentSummary: findSummary('ops_alignment_signal'),
    autonomyLaneSummary: findSummary('ops_autonomy_lane'),
  };
}

function summarizeExperimentLearning(plan = null) {
  const learning = plan?.experimentLearning && typeof plan.experimentLearning === 'object'
    ? plan.experimentLearning
    : null;
  return {
    generatedAt: String(learning?.generatedAt || '') || null,
    topWinnerSummary: String(learning?.topWinnerSummary || ''),
    weakestVariantSummary: String(learning?.weakestVariantSummary || ''),
  };
}

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function runMarketingDigest() {
  const command = MARKETING_DIGEST_COMMAND;
  try {
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: path.join(env.PROJECT_ROOT, 'bots/blog'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const jsonStart = output.indexOf('{');
    const candidate = jsonStart >= 0 ? output.slice(jsonStart) : output;
    return {
      command,
      payload: JSON.parse(candidate || '{}'),
    };
  } catch (error) {
    return {
      command,
      payload: null,
      error: String(error?.message || error),
    };
  }
}

function buildPrimary(digest = {}) {
  const status = String(digest?.health?.status || 'unknown');
  const topSignal = String(digest?.senseSummary?.topSignal?.message || '');
  const watchHint = String(digest?.channelPerformance?.primaryWatchHint || '');
  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];
  const snapshotWatchCount = Number(digest?.snapshotTrend?.watchCount || 0);
  const adoptionStatus = String(digest?.strategyAdoption?.status || '');
  const latestAlignmentHint = String(digest?.strategyAdoption?.latestAlignmentHint || '');
  const strategyFreshness = digest?.strategyFreshness || {};
  const strategyAppliedRecently = Boolean(strategyFreshness?.recentlyApplied);
  const strategyAgeMinutes = Number(strategyFreshness?.ageMinutes);

  if (status === 'watch' || status === 'error') {
    return {
      area: 'marketing.watch',
      reason: topSignal
        ? `마케팅 확장 신호가 watch 상태이며 최우선 확인 포인트는 "${topSignal}" 입니다.`
        : '마케팅 확장 신호가 watch 상태라 sense/correlation/diagnosis 재점검이 필요합니다.',
      nextCommand: AUTO_STRATEGY_REFRESH_COMMAND,
      actionFocus: watchHint || '수집·분석 결과를 바탕으로 노출 전략과 전환 전략을 다시 편성',
      recommendation: recommendations[0] || '',
    };
  }

  if (
    snapshotWatchCount >= 5
    || (adoptionStatus && adoptionStatus !== 'aligned' && latestAlignmentHint.startsWith('category_drift:'))
  ) {
    if (strategyAppliedRecently) {
      return {
        area: 'marketing.strategy_monitor',
        reason: `전략 드리프트 신호는 남아 있지만 최신 전략이 최근 ${strategyAgeMinutes}분 전에 다시 적용돼, 지금은 추가 재편성보다 반영 효과를 관찰하는 편이 좋습니다 (${snapshotWatchCount} recent watch snapshots${latestAlignmentHint ? ` / ${latestAlignmentHint}` : ''}).`,
        nextCommand: CHANNEL_INSIGHTS_COMMAND,
        actionFocus: '게시 후 조회·공감·채널 반응을 더 수집해 새 전략 반영 효과를 확인',
        recommendation: recommendations[0] || '',
      };
    }
    return {
      area: 'marketing.strategy_refresh',
      reason: `최근 마케팅 신호 누적과 전략 채택 드리프트가 보여 새로운 노출 전략과 전환 전략을 다시 편성할 시점입니다 (${snapshotWatchCount} recent watch snapshots${latestAlignmentHint ? ` / ${latestAlignmentHint}` : ''}).`,
      nextCommand: AUTO_STRATEGY_REFRESH_COMMAND,
      actionFocus: '수집·스냅샷·전략 갱신을 다시 돌려 채널별 노출 전략을 재편성',
      recommendation: recommendations[0] || '',
    };
  }

  return {
    area: 'clear',
    reason: '현재 마케팅 확장 신호의 즉시 조치가 필요한 병목은 없습니다.',
    nextCommand: '',
    actionFocus: '',
    recommendation: '',
  };
}

function buildDigestFallbackView(digest = {}, latestDigestRun = null) {
  if (digest && Object.keys(digest).length > 0) return digest;
  if (!latestDigestRun) return {};
  return {
    health: {
      status: String(latestDigestRun.status || 'unknown'),
      reason: String(latestDigestRun.reason || ''),
    },
    senseSummary: {
      topSignal: {
        message: String(latestDigestRun.topSignal || ''),
      },
    },
    channelPerformance: {
      primaryWatchHint: String(latestDigestRun.channelWatchHint || ''),
    },
    nextGeneralPreview: {
      title: String(latestDigestRun.nextPreviewTitle || ''),
    },
    recommendations: latestDigestRun.recommendation ? [String(latestDigestRun.recommendation)] : [],
  };
}

function buildActions({ primary, digest = {} }) {
  const actions = [];
  const primaryArea = String(primary?.area || '');
  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';
  const latestDigestRun = digest?.latestDigestRun || null;
  const latestDigestAge = describeMarketingDigestAge(latestDigestRun);
  const latestAutoStrategyRefresh = digest?.latestAutoStrategyRefresh || null;
  const latestEvalCase = digest?.latestEvalCase || null;

  if (hasActivePrimary && primary?.actionFocus) {
    actions.push(`focus blocker: ${primary.actionFocus}`);
  }
  if (hasActivePrimary && primary?.nextCommand) {
    actions.push(`우선 실행: ${primary.nextCommand}`);
  }

  if (primaryArea === 'marketing.watch' || primaryArea === 'marketing.strategy_refresh') {
    actions.push(`signal collect: ${CHANNEL_INSIGHTS_COMMAND}`);
    actions.push(`signal snapshot: ${MARKETING_SNAPSHOT_COMMAND}`);
    actions.push(`strategy evolve: ${REVENUE_STRATEGY_COMMAND}`);
    actions.push(`strategy auto loop: ${AUTO_STRATEGY_REFRESH_COMMAND}`);
  }
  if (primaryArea === 'marketing.strategy_monitor') {
    actions.push(`signal collect: ${CHANNEL_INSIGHTS_COMMAND}`);
    actions.push(`signal snapshot: ${MARKETING_SNAPSHOT_COMMAND}`);
    actions.push('observe loop: 최신 전략 반영 후 채널별 조회·공감·전환 반응을 더 수집');
  }

  const watchHint = String(digest?.channelPerformance?.primaryWatchHint || '');
  if (watchHint) actions.push(`channel watch: ${watchHint}`);
  if (latestDigestRun?.checkedAt) {
    actions.push(`latest digest run: ${String(latestDigestRun.checkedAt).slice(0, 19)} / ${String(latestDigestRun.status || 'unknown')}${latestDigestAge.text ? ` / ${latestDigestAge.text}` : ''}`);
  }
  if (latestAutoStrategyRefresh?.startedAt) {
    actions.push(`latest strategy auto run: ${String(latestAutoStrategyRefresh.startedAt).slice(0, 19)} / ${latestAutoStrategyRefresh.ok ? 'ok' : `failed:${String(latestAutoStrategyRefresh.failedStep || 'unknown')}`}`);
  }
  if (latestEvalCase?.capturedAt) {
    actions.push(`latest eval case: ${String(latestEvalCase.capturedAt).slice(0, 19)} / ${String(latestEvalCase.area || 'unknown')}:${String(latestEvalCase.subtype || 'unknown')} / ${String(latestEvalCase.code || 'unknown')}`);
  }

  const nextPreview = digest?.nextGeneralPreview || null;
  if (nextPreview?.title) {
    actions.push(`next preview: ${nextPreview.title}`);
  }
  if (digest?.strategyOperationalLearning?.titlePatternSummary) {
    actions.push(`ops learning: ${digest.strategyOperationalLearning.titlePatternSummary}`);
  }
  if (digest?.strategyOperationalLearning?.alignmentSummary) {
    actions.push(`ops learning: ${digest.strategyOperationalLearning.alignmentSummary}`);
  }
  if (digest?.strategyOperationalLearning?.autonomyLaneSummary) {
    actions.push(`ops learning: ${digest.strategyOperationalLearning.autonomyLaneSummary}`);
  }
  if (digest?.strategyExperimentLearning?.topWinnerSummary) {
    actions.push(`experiment winner: ${digest.strategyExperimentLearning.topWinnerSummary}`);
  }
  if (digest?.strategyExperimentLearning?.weakestVariantSummary) {
    actions.push(`experiment weak lane: ${digest.strategyExperimentLearning.weakestVariantSummary}`);
  }

  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];
  if (recommendations[0]) actions.push(`reco: ${recommendations[0]}`);
  if (recommendations[1]) actions.push(`reco: ${recommendations[1]}`);
  if (primaryArea === 'marketing.watch' || primaryArea === 'marketing.strategy_refresh') {
    actions.push('execute loop: 채널 수집 -> 마케팅 스냅샷 -> 전략 갱신 -> 다음 daily/배포 사이클 반영');
  }
  if (primaryArea === 'marketing.strategy_monitor') {
    actions.push('execute loop: 채널 수집 -> 마케팅 스냅샷 -> 반영 효과 확인 -> 다음 daily/배포 사이클 반영');
  }

  if (!actions.length) {
    actions.push('마케팅 확장 신호는 현재 안정적이라 다음 daily 사이클에서 다시 관찰하면 됩니다.');
  }

  return Array.from(new Set(actions));
}

function buildMarketingDoctorFallback(payload = {}) {
  const primaryArea = String(payload?.primary?.area || '');
  if (primaryArea === 'marketing.watch') {
    return '마케팅 확장 신호가 watch 상태라 수집과 스냅샷을 다시 굴린 뒤 전략을 갱신하고 다음 실행 사이클에 반영하는 편이 좋습니다.';
  }
  if (primaryArea === 'marketing.strategy_refresh') {
    return '마케팅 watch는 과열로 보지 않더라도 전략 채택 드리프트가 누적돼 있어, 수집과 스냅샷을 다시 돌리고 채널별 노출 전략을 재편성하는 편이 좋습니다.';
  }
  if (primaryArea === 'marketing.strategy_monitor') {
    return '전략은 최근 다시 적용됐고 지금은 채널 반응을 더 모아 반영 효과를 확인하는 편이 좋습니다.';
  }
  return '마케팅 확장 상태는 현재 비교적 안정적이라 다음 daily 사이클 관찰 중심으로 가면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const digestResult = runMarketingDigest();
  const latestDigestRun = readMarketingDigestTelemetry();
  const latestAutoStrategyRefresh = readAutoStrategyRefreshResult();
  const rawLatestEvalCase = readLatestBlogEvalCase();
  const latestEvalCase = ['marketing', 'publish'].includes(String(rawLatestEvalCase?.area || ''))
    ? rawLatestEvalCase
    : null;
  const digest = buildDigestFallbackView(digestResult.payload || {}, latestDigestRun);
  const strategyBundle = loadStrategyBundle();
  const strategyFreshness = describeStrategyFreshness(strategyBundle?.plan || null);
  const strategyOperationalLearning = summarizeOperationalLearning(strategyBundle?.plan || null);
  const strategyExperimentLearning = summarizeExperimentLearning(strategyBundle?.plan || null);
  const strategyRuntime = strategyBundle?.plan
    ? {
        preferredCategory: strategyBundle.plan.preferredCategory || null,
        preferredTitlePattern: strategyBundle.plan.preferredTitlePattern || null,
        evolvedAt: strategyBundle.plan.evolvedAt || null,
      }
    : null;
  digest.strategyFreshness = strategyFreshness;
  digest.strategyOperationalLearning = strategyOperationalLearning;
  digest.strategyExperimentLearning = strategyExperimentLearning;
  digest.strategyRuntime = strategyRuntime;
  const payload = {
    digestCommand: digestResult.command,
    digestError: digestResult.error || '',
    latestDigestRun,
    latestAutoStrategyRefresh,
    latestEvalCase,
    latestDigestAge: describeMarketingDigestAge(latestDigestRun),
    health: digest?.health || null,
    senseSummary: digest?.senseSummary || null,
    revenueCorrelation: digest?.revenueCorrelation || null,
    channelPerformance: digest?.channelPerformance || null,
    nextGeneralPreview: digest?.nextGeneralPreview || null,
    recommendations: Array.isArray(digest?.recommendations) ? digest.recommendations : [],
    strategyFreshness,
    strategyOperationalLearning,
    strategyExperimentLearning,
    strategyRuntime,
  };
  payload.primary = buildPrimary(digest);
  payload.actions = buildActions({ primary: payload.primary, digest: payload });
  payload.aiSummary = await buildBlogCliInsight({
    bot: 'doctor-marketing',
    requestType: 'doctor-marketing',
    title: '블로그 마케팅 doctor 요약',
    data: payload,
    fallback: buildMarketingDoctorFallback(payload),
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[marketing doctor]');
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`primary: ${payload.primary.area} ${payload.primary.reason}`);
  if (payload.primary.nextCommand) {
    console.log(`next: ${payload.primary.nextCommand}`);
  }
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[marketing doctor] 실패:', error?.message || error);
  process.exit(1);
});

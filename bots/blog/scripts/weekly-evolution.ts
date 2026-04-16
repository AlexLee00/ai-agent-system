#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { diagnoseWeeklyPerformance } = require('../lib/performance-diagnostician.ts');
const { evolveStrategy } = require('../lib/strategy-evolver.ts');
const { buildMarketingDigest } = require('../lib/marketing-digest.ts');
const { analyzeMarketingToRevenue } = require('../lib/marketing-revenue-correlation.ts');
const { trackWeeklyAutonomy } = require('../lib/autonomy-tracker.ts');
const { aggregatePatterns } = require('../lib/feedback-learner.ts');
const { getCrosspostStats } = require('../lib/insta-crosspost.ts');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { publishToWebhook, buildReportEvent, renderReportEvent } = require('../../../packages/core/lib/reporting-hub');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');
const weeklyEvolutionMemory = createAgentMemory({ agentId: 'blog.weekly-evolution', team: 'blog' });

function buildWeeklyMemoryQuery(diagnosis = {}, evolution = {}, autonomy = null) {
  return [
    'blog weekly evolution',
    diagnosis.primaryWeakness?.code || 'stable',
    ...(Array.isArray(evolution?.plan?.focus) ? evolution.plan.focus.slice(0, 2) : []),
    autonomy?.currentPhase ? `phase-${autonomy.currentPhase}` : null,
  ].filter(Boolean).join(' ');
}

function buildWeeklyLines(diagnosis = {}, evolution = {}, marketingDigest = null, autonomy = null, revenueCorrelation = null, feedbackPatterns = [], crosspostStats = null) {
  const lines = [
    `최근 포스트: ${diagnosis.postCount || 0}건 / 실행 이력: ${diagnosis.executionCount || 0}건`,
    `주요 약점: ${diagnosis.primaryWeakness?.message || '없음'}`,
    `다음 주 초점: ${(evolution.plan?.focus || []).join(' | ') || '없음'}`,
  ];

  if (autonomy) {
    lines.push(
      `자율 Phase: ${autonomy.currentPhase || 1} (이전 ${autonomy.previousPhase || 1}, 정확도 ${(Number(autonomy.accuracy || 0) * 100).toFixed(1)}%, 변화 ${autonomy.phaseChanged ? '있음' : '없음'})`
    );
  }

  if (marketingDigest) {
    lines.push(
      `마케팅 상태: ${marketingDigest?.health?.status || 'unknown'} / 매출 영향 ${(Number(marketingDigest?.revenueCorrelation?.revenueImpactPct || 0) * 100).toFixed(1)}%`
    );
  }

  if (revenueCorrelation && !marketingDigest) {
    lines.push(
      `매출 영향: ${(Number(revenueCorrelation?.revenueImpactPct || 0) * 100).toFixed(1)}% / 고조회수 다음날 ${Number(revenueCorrelation?.highViewRevenueAfter || 0).toFixed(0)}`
    );
  }

  // 인스타 크로스포스트 통계
  if (crosspostStats && crosspostStats.total > 0) {
    const rate = crosspostStats.successRate !== null ? `${crosspostStats.successRate}%` : 'n/a';
    const tokenWarn = crosspostStats.tokenErrorCount > 0 ? ` ⚠️ 토큰오류 ${crosspostStats.tokenErrorCount}회` : '';
    lines.push(`인스타 크로스포스트: ${crosspostStats.okCount}건 성공 / ${crosspostStats.failCount}건 실패 (성공률 ${rate})${tokenWarn}`);
  } else if (crosspostStats) {
    lines.push('인스타 크로스포스트: 이번 주 기록 없음');
  }

  if (Array.isArray(diagnosis.recommendations) && diagnosis.recommendations.length) {
    lines.push('', '권고 사항:');
    diagnosis.recommendations.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(feedbackPatterns) && feedbackPatterns.length) {
    lines.push('', '마스터 피드백 요약:');
    feedbackPatterns.slice(0, 3).forEach((item) => {
      lines.push(`- ${item.type}: ${item.count}회 / ${item.recentSummaries?.[0] || '요약 없음'}`);
    });
  }

  if (Array.isArray(diagnosis.byCategory) && diagnosis.byCategory.length) {
    lines.push('', '카테고리 분포:');
    diagnosis.byCategory.slice(0, 4).forEach((item) => lines.push(`- ${item.key}: ${item.count}`));
  }

  if (Array.isArray(diagnosis.byTitlePattern) && diagnosis.byTitlePattern.length) {
    lines.push('', '제목 패턴 분포:');
    diagnosis.byTitlePattern.slice(0, 4).forEach((item) => lines.push(`- ${item.key}: ${item.count}`));
  }

  if (Array.isArray(diagnosis.byCategoryPattern) && diagnosis.byCategoryPattern.length) {
    lines.push('', '카테고리별 제목 패턴 hotspot:');
    diagnosis.byCategoryPattern.slice(0, 3).forEach((item) => {
      lines.push(`- ${item.category}: ${item.topPattern || 'none'} (${Math.round((Number(item.topRatio || 0)) * 100)}%)`);
    });
  }

  return lines;
}

async function sendWeeklyReport(diagnosis = {}, evolution = {}, marketingDigest = null, autonomy = null, revenueCorrelation = null, feedbackPatterns = [], options = {}, crosspostStats = null) {
  const lines = buildWeeklyLines(diagnosis, evolution, marketingDigest, autonomy, revenueCorrelation, feedbackPatterns, crosspostStats);
  const memoryQuery = buildWeeklyMemoryQuery(diagnosis, evolution, autonomy);
  const episodicHint = await weeklyEvolutionMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 전략',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      evolution: '전략',
    },
    order: ['evolution'],
  }).catch(() => '');
  const semanticHint = await weeklyEvolutionMemory.recallHint(`${memoryQuery} consolidated strategy pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const reportEvent = buildReportEvent({
    from_bot: 'blog-blo',
    team: 'blog',
    event_type: 'blog_weekly_evolution',
    alert_level: 1,
    title: '블로그팀 주간 전략 진화 완료',
    summary: `${diagnosis.postCount || 0}건 분석 / 약점: ${diagnosis.primaryWeakness?.code || 'stable'}`,
    sections: [
      {
        title: '전략 요약',
        lines,
      },
    ],
    footer: 'weekly-evolution 완료',
    payload: {
      title: '블로그팀 주간 전략 진화 완료',
      summary: `${diagnosis.postCount || 0}건 분석`,
      details: lines,
    },
  });
  const rendered = `${renderReportEvent(reportEvent) || lines.join('\n')}${episodicHint}${semanticHint}`;

  if (options.dryRun) {
    console.log('[블로][dry-run] 주간 텔레그램 리포트 생략');
    console.log(rendered);
    return;
  }

  await runIfOps(
    'blog-weekly-report',
    () => publishToWebhook({
      event: {
        from_bot: 'blog-blo',
        team: 'blog',
        event_type: 'blog_weekly_evolution',
        alert_level: 1,
        message: rendered,
        payload: reportEvent.payload,
      },
    }),
    () => console.log('[DEV] 주간 텔레그램 리포트 생략\n' + rendered)
  );
  await weeklyEvolutionMemory.remember(rendered, 'episodic', {
    importance: 0.72,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'evolution',
      weakness: diagnosis.primaryWeakness?.code || 'stable',
      postCount: diagnosis.postCount || 0,
      currentPhase: autonomy?.currentPhase || null,
      focus: Array.isArray(evolution?.plan?.focus) ? evolution.plan.focus.slice(0, 3) : [],
    },
  }).catch(() => {});
  await weeklyEvolutionMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
}

async function main() {
  console.log('\n📊 [블로] 주간 전략 진화 시작');
  if (dryRun) {
    console.log('[블로][dry-run] 전략 파일 저장 없이 진단만 실행');
  }

  const [diagnosis, marketingDigest, autonomy, revenueCorrelation, feedbackPatterns, crosspostStats] = await Promise.all([
    diagnoseWeeklyPerformance(7),
    buildMarketingDigest({
      revenueWindow: 14,
      diagnosisWindow: 7,
      autonomyWindow: 14,
      snapshotWindow: 7,
    }).catch(() => null),
    trackWeeklyAutonomy().catch(() => null),
    analyzeMarketingToRevenue(14).catch(() => null),
    aggregatePatterns(30).catch(() => []),
    getCrosspostStats(7).catch(() => null),
  ]);
  const evolution = await evolveStrategy(diagnosis, { dryRun, marketingDigest });

  const result = {
    dryRun,
    diagnosis,
    marketingDigest,
    autonomy,
    revenueCorrelation,
    feedbackPatterns,
    crosspostStats,
    evolution,
  };
  result.aiSummary = await buildBlogCliInsight({
    bot: 'weekly-evolution',
    requestType: 'weekly-evolution',
    title: '블로그 주간 전략 진화 결과',
    data: {
      dryRun,
      postCount: diagnosis.postCount || 0,
      executionCount: diagnosis.executionCount || 0,
      weakness: diagnosis.primaryWeakness?.code || 'stable',
      focus: evolution.plan?.focus || [],
      currentPhase: autonomy?.currentPhase || null,
    },
    fallback: (evolution.plan?.focus || []).length > 0
      ? `주간 전략 초점이 ${evolution.plan.focus.slice(0, 2).join(', ')}로 정리돼 다음 주 실행 우선순위가 선명해졌습니다.`
      : '주간 전략은 큰 전환보다 현재 흐름 유지와 관찰에 더 가까운 상태입니다.',
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[블로] 주간 진단: 최근 포스트 ${diagnosis.postCount}건 / 실행 이력 ${diagnosis.executionCount}건`);
    console.log(`[블로] 주요 약점: ${diagnosis.primaryWeakness?.message || '없음'}`);
    console.log(`[블로] 다음 주 초점: ${(evolution.plan?.focus || []).join(' | ')}`);
    console.log(`🔍 AI: ${result.aiSummary}`);
    if (autonomy) {
      console.log(`[블로] 자율 Phase: ${autonomy.currentPhase} / 정확도 ${(Number(autonomy.accuracy || 0) * 100).toFixed(1)}%`);
    }
  }

  await sendWeeklyReport(diagnosis, evolution, marketingDigest, autonomy, revenueCorrelation, feedbackPatterns, { dryRun }, crosspostStats);
}

main().catch((error) => {
  console.error('❌ 주간 전략 진화 실패:', error.message);
  process.exit(1);
});

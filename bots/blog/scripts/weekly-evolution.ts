#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { diagnoseWeeklyPerformance } = require('../lib/performance-diagnostician.ts');
const { evolveStrategy } = require('../lib/strategy-evolver.ts');
const { buildMarketingDigest } = require('../lib/marketing-digest.ts');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { buildReportEvent, renderReportEvent } = require('../../../packages/core/lib/reporting-hub');

const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');

function buildWeeklyLines(diagnosis = {}, evolution = {}, marketingDigest = null) {
  const lines = [
    `최근 포스트: ${diagnosis.postCount || 0}건 / 실행 이력: ${diagnosis.executionCount || 0}건`,
    `주요 약점: ${diagnosis.primaryWeakness?.message || '없음'}`,
    `다음 주 초점: ${(evolution.plan?.focus || []).join(' | ') || '없음'}`,
  ];

  if (marketingDigest) {
    lines.push(
      `마케팅 상태: ${marketingDigest?.health?.status || 'unknown'} / 매출 영향 ${(Number(marketingDigest?.revenueCorrelation?.revenueImpactPct || 0) * 100).toFixed(1)}%`
    );
  }

  if (Array.isArray(diagnosis.recommendations) && diagnosis.recommendations.length) {
    lines.push('', '권고 사항:');
    diagnosis.recommendations.forEach((item) => lines.push(`- ${item}`));
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

async function sendWeeklyReport(diagnosis = {}, evolution = {}, marketingDigest = null, options = {}) {
  const lines = buildWeeklyLines(diagnosis, evolution, marketingDigest);
  const reportEvent = buildReportEvent({
    from_bot: 'blog-blo',
    team: 'blog',
    event_type: 'report',
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
  const rendered = renderReportEvent(reportEvent) || lines.join('\n');

  if (options.dryRun) {
    console.log('[블로][dry-run] 주간 텔레그램 리포트 생략');
    console.log(rendered);
    return;
  }

  await runIfOps(
    'blog-weekly-report',
    () => postAlarm({
      message: rendered,
      team: 'blog',
      alertLevel: 1,
      fromBot: 'blog-blo',
    }),
    () => console.log('[DEV] 주간 텔레그램 리포트 생략\n' + rendered)
  );
}

async function main() {
  console.log('\n📊 [블로] 주간 전략 진화 시작');
  if (dryRun) {
    console.log('[블로][dry-run] 전략 파일 저장 없이 진단만 실행');
  }

  const [diagnosis, marketingDigest] = await Promise.all([
    diagnoseWeeklyPerformance(7),
    buildMarketingDigest({
      revenueWindow: 14,
      diagnosisWindow: 7,
      autonomyWindow: 14,
      snapshotWindow: 7,
    }).catch(() => null),
  ]);
  const evolution = await evolveStrategy(diagnosis, { dryRun, marketingDigest });

  const result = {
    dryRun,
    diagnosis,
    marketingDigest,
    evolution,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[블로] 주간 진단: 최근 포스트 ${diagnosis.postCount}건 / 실행 이력 ${diagnosis.executionCount}건`);
    console.log(`[블로] 주요 약점: ${diagnosis.primaryWeakness?.message || '없음'}`);
    console.log(`[블로] 다음 주 초점: ${(evolution.plan?.focus || []).join(' | ')}`);
  }

  await sendWeeklyReport(diagnosis, evolution, marketingDigest, { dryRun });
}

main().catch((error) => {
  console.error('❌ 주간 전략 진화 실패:', error.message);
  process.exit(1);
});

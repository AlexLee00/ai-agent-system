#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { execFileSync } = require('child_process');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const { readMarketingDigestTelemetry } = require('../lib/marketing-digest-telemetry.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function runMarketingDigest() {
  const command = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run marketing:digest -- --json`;
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
  const blogPrefix = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')}`;
  const status = String(digest?.health?.status || 'unknown');
  const topSignal = String(digest?.senseSummary?.topSignal?.message || '');
  const watchHint = String(digest?.channelPerformance?.primaryWatchHint || '');
  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];

  if (status === 'watch' || status === 'error') {
    return {
      area: 'marketing.watch',
      reason: topSignal
        ? `마케팅 확장 신호가 watch 상태이며 최우선 확인 포인트는 "${topSignal}" 입니다.`
        : '마케팅 확장 신호가 watch 상태라 sense/correlation/diagnosis 재점검이 필요합니다.',
      nextCommand: `${blogPrefix} run marketing:digest -- --json`,
      actionFocus: watchHint || '마케팅 top signal과 revenue correlation, 추천 액션 재확인',
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

function buildActions({ primary, digest = {} }) {
  const actions = [];
  const primaryArea = String(primary?.area || '');
  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';
  const latestDigestRun = digest?.latestDigestRun || null;

  if (hasActivePrimary && primary?.actionFocus) {
    actions.push(`focus blocker: ${primary.actionFocus}`);
  }
  if (hasActivePrimary && primary?.nextCommand) {
    actions.push(`우선 실행: ${primary.nextCommand}`);
  }

  const watchHint = String(digest?.channelPerformance?.primaryWatchHint || '');
  if (watchHint) actions.push(`channel watch: ${watchHint}`);
  if (latestDigestRun?.checkedAt) {
    actions.push(`latest digest run: ${String(latestDigestRun.checkedAt).slice(0, 19)} / ${String(latestDigestRun.status || 'unknown')}`);
  }

  const nextPreview = digest?.nextGeneralPreview || null;
  if (nextPreview?.title) {
    actions.push(`next preview: ${nextPreview.title}`);
  }

  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];
  if (recommendations[0]) actions.push(`reco: ${recommendations[0]}`);
  if (recommendations[1]) actions.push(`reco: ${recommendations[1]}`);

  if (!actions.length) {
    actions.push('마케팅 확장 신호는 현재 안정적이라 다음 daily 사이클에서 다시 관찰하면 됩니다.');
  }

  return Array.from(new Set(actions));
}

function buildMarketingDoctorFallback(payload = {}) {
  const primaryArea = String(payload?.primary?.area || '');
  if (primaryArea === 'marketing.watch') {
    return '마케팅 확장 신호가 watch 상태라 상위 signal, revenue correlation, 추천 액션을 먼저 보는 편이 좋습니다.';
  }
  return '마케팅 확장 상태는 현재 비교적 안정적이라 다음 daily 사이클 관찰 중심으로 가면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const digestResult = runMarketingDigest();
  const digest = digestResult.payload || {};
  const payload = {
    digestCommand: digestResult.command,
    digestError: digestResult.error || '',
    latestDigestRun: readMarketingDigestTelemetry(),
    health: digest?.health || null,
    senseSummary: digest?.senseSummary || null,
    revenueCorrelation: digest?.revenueCorrelation || null,
    channelPerformance: digest?.channelPerformance || null,
    nextGeneralPreview: digest?.nextGeneralPreview || null,
    recommendations: Array.isArray(digest?.recommendations) ? digest.recommendations : [],
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

#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { execFileSync } = require('child_process');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function runDoctor(command) {
  try {
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: path.join(env.PROJECT_ROOT, 'bots/blog'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const jsonStart = output.indexOf('{');
    const candidate = jsonStart >= 0 ? output.slice(jsonStart) : output;
    return JSON.parse(candidate || '{}');
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

function buildActions({ social, engagement, primary }) {
  const actions = [];
  const socialActions = Array.isArray(social?.actions) ? social.actions : [];
  const engagementActions = Array.isArray(engagement?.actions) ? engagement.actions : [];
  const primaryArea = String(primary?.area || '');

  const orderedActionGroups = primaryArea.startsWith('engagement')
    ? [engagementActions, socialActions]
    : [socialActions, engagementActions];

  for (const group of orderedActionGroups) {
    actions.push(...group.slice(0, 3));
  }

  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';
  if (hasActivePrimary && primary?.nextCommand) {
    actions.unshift(`우선 실행: ${primary.nextCommand}`);
  }

  if (hasActivePrimary && primary?.actionFocus) {
    actions.unshift(`focus blocker: ${primary.actionFocus}`);
  }

  if (engagement?.adaptiveNeighborCadence?.shouldBoost) {
    actions.push(
      `외부 댓글 cadence boost 적용 중: reply+neighbor ${engagement.adaptiveNeighborCadence.combinedCommentSuccess}/${engagement.adaptiveNeighborCadence.combinedCommentExpectedNow}, process ${engagement.adaptiveNeighborCadence.effectiveProcessLimit}, collect ${engagement.adaptiveNeighborCadence.effectiveCollectLimit}`,
    );
  }

  if (actions.length === 0) {
    actions.push('블로팀 운영 doctor 기준 현재 즉시 조치 항목은 없습니다.');
  }

  return Array.from(new Set(actions));
}

function pickPrimary({ social, engagement, commands }) {
  const facebookAttention = Boolean(social?.facebook?.needsAttention);
  const instagramAttention = Boolean(social?.instagram?.needsAttention);
  const engagementNeedsAttention = Boolean(engagement?.needsAttention);
  const engagementPrimaryArea = String(engagement?.primary?.area || '');

  if (facebookAttention) {
    return {
      area: 'social.facebook',
      reason: 'Facebook publish 권한 이슈가 현재 최우선 병목입니다.',
      nextCommand: commands.social,
      actionFocus: 'social.facebook',
    };
  }

  if (instagramAttention) {
    return {
      area: 'social.instagram',
      reason: 'Instagram publish/readiness 이슈가 현재 최우선 병목입니다.',
      nextCommand: commands.social,
      actionFocus: 'social.instagram',
    };
  }

  if (engagementNeedsAttention || (engagementPrimaryArea && engagementPrimaryArea !== 'clear' && engagementPrimaryArea !== 'unknown')) {
    return {
      area: engagementPrimaryArea || 'engagement',
      reason: [
        engagement?.primary?.reason || '답글/댓글/공감 자동화 이슈가 현재 최우선 병목입니다.',
        engagement?.adaptiveNeighborCadence?.shouldBoost
          ? `외부 댓글 cadence boost ${engagement.adaptiveNeighborCadence.combinedCommentSuccess}/${engagement.adaptiveNeighborCadence.combinedCommentExpectedNow}`
          : '',
      ].filter(Boolean).join(' / '),
      nextCommand: engagement?.primary?.nextCommand || commands.engagement,
      actionFocus: engagement?.primary?.actionFocus || 'engagement',
    };
  }

  return {
    area: 'clear',
    reason: '지금은 즉시 막히는 운영 병목보다 다음 운영 사이클 관찰이 우선입니다.',
    nextCommand: '',
    actionFocus: '다음 운영 시간대 관찰',
  };
}

function buildOpsDoctorFallback(payload = {}) {
  if (payload.social?.facebook?.needsAttention || payload.social?.instagram?.needsAttention) {
    return '블로팀 운영 이슈는 지금 소셜 publish 축을 먼저 정리하는 편이 좋습니다.';
  }
  if (payload.engagement?.needsAttention || (payload.engagement?.primary?.area && payload.engagement.primary.area !== 'clear')) {
    return '블로팀 운영 이슈는 지금 engagement 자동화 축을 먼저 정리하는 편이 좋습니다.';
  }
  return '블로팀 운영 상태는 현재 비교적 안정적이라 다음 운영 시간대 관찰 중심으로 가도 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const socialCommand = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:social -- --json`;
  const engagementCommand = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:engagement -- --json`;

  const social = runDoctor(socialCommand);
  const engagement = runDoctor(engagementCommand);

  const payload = {
    social,
    engagement,
    commands: {
      social: socialCommand,
      engagement: engagementCommand,
    },
  };
  payload.primary = pickPrimary(payload);
  payload.actions = buildActions({ social, engagement, primary: payload.primary });

  const aiSummary = await buildBlogCliInsight({
    bot: 'doctor-blog-ops',
    requestType: 'doctor-blog-ops',
    title: '블로팀 운영 doctor 요약',
    data: {
      social: {
        facebookAttention: Boolean(social?.facebook?.needsAttention),
        instagramAttention: Boolean(social?.instagram?.needsAttention),
      },
      engagement: {
        totalFailures: Number(engagement?.totalFailures || 0),
        failureByKind: engagement?.failureByKind || {},
        needsAttention: Boolean(engagement?.needsAttention),
        targetGaps: engagement?.targetGaps || [],
        adaptiveNeighborCadence: engagement?.adaptiveNeighborCadence || null,
      },
      primary: payload.primary,
      actions: payload.actions,
    },
    fallback: buildOpsDoctorFallback(payload),
  });
  payload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[blog ops doctor]');
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`primary: ${payload.primary.area} ${payload.primary.reason}`);
  if (payload.primary.nextCommand) {
    console.log(`next: ${payload.primary.nextCommand}`);
  }
  console.log(`social: ${socialCommand}`);
  console.log(`engagement: ${engagementCommand}`);
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[blog ops doctor] 실패:', error?.message || error);
  process.exit(1);
});

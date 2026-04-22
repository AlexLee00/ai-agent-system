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

function buildActions({ social, engagement, marketing, primary }) {
  const actions = [];
  const socialPrimaryArea = String(social?.primary?.area || '');
  const engagementPrimaryArea = String(engagement?.primary?.area || '');
  const marketingPrimaryArea = String(marketing?.primary?.area || '');
  const socialActions = (socialPrimaryArea && socialPrimaryArea !== 'clear' && socialPrimaryArea !== 'unknown' && Array.isArray(social?.actions))
    ? social.actions
    : [];
  const engagementActions = (engagementPrimaryArea && engagementPrimaryArea !== 'clear' && engagementPrimaryArea !== 'unknown' && Array.isArray(engagement?.actions))
    ? engagement.actions
    : [];
  const marketingActions = (marketingPrimaryArea && marketingPrimaryArea !== 'clear' && marketingPrimaryArea !== 'unknown' && Array.isArray(marketing?.actions))
    ? marketing.actions
    : [];
  const primaryArea = String(primary?.area || '');
  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';

  let orderedActionGroups = [];
  const primaryActionLimit = primaryArea.startsWith('marketing') ? 5 : 3;
  if (primaryArea.startsWith('engagement')) {
    orderedActionGroups = [engagementActions];
  } else if (primaryArea.startsWith('social')) {
    orderedActionGroups = [socialActions];
  } else if (primaryArea.startsWith('marketing')) {
    orderedActionGroups = [marketingActions];
  } else {
    orderedActionGroups = [socialActions, engagementActions, marketingActions];
  }

  for (const group of orderedActionGroups) {
    actions.push(...group.slice(0, primaryActionLimit));
  }
  if (hasActivePrimary && primary?.nextCommand) {
    actions.unshift(`우선 실행: ${primary.nextCommand}`);
  }

  if (hasActivePrimary && primary?.actionFocus) {
    actions.unshift(`focus blocker: ${primary.actionFocus}`);
  }

  if (!primaryArea.startsWith('social') && engagement?.adaptiveNeighborCadence?.shouldBoost) {
    actions.push(
      `외부 댓글 cadence boost 적용 중: reply+neighbor ${engagement.adaptiveNeighborCadence.combinedCommentSuccess}/${engagement.adaptiveNeighborCadence.combinedCommentExpectedNow}, process ${engagement.adaptiveNeighborCadence.effectiveProcessLimit}, collect ${engagement.adaptiveNeighborCadence.effectiveCollectLimit}`,
    );
  }

  if (actions.length === 0) {
    actions.push('블로팀 운영 doctor 기준 현재 즉시 조치 항목은 없습니다.');
  }

  return Array.from(new Set(actions));
}

function pickPrimary({ social, engagement, marketing, commands }) {
  const facebookAttention = Boolean(social?.facebook?.needsAttention);
  const instagramAttention = Boolean(social?.instagram?.needsAttention);
  const engagementNeedsAttention = Boolean(engagement?.needsAttention);
  const engagementPrimaryArea = String(engagement?.primary?.area || '');
  const socialPrimaryArea = String(social?.primary?.area || '');
  const socialPrimaryActive = socialPrimaryArea && socialPrimaryArea !== 'clear' && socialPrimaryArea !== 'unknown';
  const marketingPrimaryArea = String(marketing?.primary?.area || '');
  const marketingPrimaryActive = marketingPrimaryArea && marketingPrimaryArea !== 'clear' && marketingPrimaryArea !== 'unknown';

  if (facebookAttention && socialPrimaryActive) {
    return {
      area: socialPrimaryArea,
      reason: social?.primary?.reason || 'Facebook publish 권한 이슈가 현재 최우선 병목입니다.',
      nextCommand: social?.primary?.nextCommand || commands.social,
      actionFocus: social?.primary?.actionFocus || 'social.facebook',
    };
  }

  if (facebookAttention) {
    return {
      area: 'social.facebook',
      reason: 'Facebook publish 권한 이슈가 현재 최우선 병목입니다.',
      nextCommand: commands.social,
      actionFocus: 'social.facebook',
    };
  }

  if (instagramAttention && socialPrimaryActive) {
    return {
      area: socialPrimaryArea,
      reason: social?.primary?.reason || 'Instagram publish/readiness 이슈가 현재 최우선 병목입니다.',
      nextCommand: social?.primary?.nextCommand || commands.social,
      actionFocus: social?.primary?.actionFocus || 'social.instagram',
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

  if (marketingPrimaryActive) {
    return {
      area: marketingPrimaryArea,
      reason: marketing?.primary?.reason || '마케팅 확장 신호 watch가 현재 최우선 병목입니다.',
      nextCommand: marketing?.primary?.nextCommand || commands.marketing,
      actionFocus: marketing?.primary?.actionFocus || 'marketing',
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
  const primaryArea = String(payload?.primary?.area || '');
  const socialFacebookError = String(payload?.social?.facebook?.error || '');
  if (primaryArea === 'social.facebook.readiness') {
    if (socialFacebookError.includes('Facebook 사용자 access token 세션이 만료되었습니다.')) {
      return '블로팀 운영의 현재 최우선 병목은 Facebook 허브 사용자 토큰 만료라 access_token 교체와 readiness 재확인이 먼저입니다.';
    }
    return '블로팀 운영의 현재 최우선 병목은 Facebook readiness 에러라 토큰과 권한 상태를 먼저 정리하는 편이 좋습니다.';
  }
  if (primaryArea === 'social.facebook') {
    return '블로팀 운영의 현재 최우선 병목은 Facebook 게시 권한/페이지 연결이라 Meta 권한과 페이지 토큰을 먼저 정리하는 편이 좋습니다.';
  }
  if (primaryArea === 'social.instagram') {
    return '블로팀 운영의 현재 최우선 병목은 Instagram publish/readiness라 공개 자산과 실패 이유를 먼저 정리하는 편이 좋습니다.';
  }
  if (primaryArea.startsWith('engagement')) {
    return '블로팀 운영의 현재 최우선 병목은 engagement 축이라 댓글/답글/공감 자동화 흐름을 먼저 정리하는 편이 좋습니다.';
  }
  if (primaryArea === 'marketing.strategy_refresh') {
    return '블로팀 운영의 현재 최우선 병목은 전략 채택 드리프트 누적이라 수집, 스냅샷, 전략 갱신을 다시 돌려 채널별 노출 전략을 재편성하는 편이 좋습니다.';
  }
  if (primaryArea.startsWith('marketing')) {
    return '블로팀 운영의 현재 최우선 병목은 marketing watch 축이라 상위 신호와 revenue correlation, 추천 액션을 먼저 확인하는 편이 좋습니다.';
  }
  if (payload.social?.facebook?.needsAttention || payload.social?.instagram?.needsAttention) {
    return '블로팀 운영 이슈는 지금 소셜 publish 축을 먼저 정리하는 편이 좋습니다.';
  }
  if (payload.engagement?.needsAttention || (payload.engagement?.primary?.area && payload.engagement.primary.area !== 'clear')) {
    return '블로팀 운영 이슈는 지금 engagement 자동화 축을 먼저 정리하는 편이 좋습니다.';
  }
  if (payload.marketing?.primary?.area && payload.marketing.primary.area !== 'clear') {
    return '블로팀 운영 이슈는 지금 marketing watch 축을 먼저 정리하는 편이 좋습니다.';
  }
  return '블로팀 운영 상태는 현재 비교적 안정적이라 다음 운영 시간대 관찰 중심으로 가도 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const socialCommand = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:social -- --json`;
  const engagementCommand = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:engagement -- --json`;
  const marketingCommand = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:marketing -- --json`;

  const social = runDoctor(socialCommand);
  const engagement = runDoctor(engagementCommand);
  const marketing = runDoctor(marketingCommand);

  const payload = {
    social,
    engagement,
    marketing,
    commands: {
      social: socialCommand,
      engagement: engagementCommand,
      marketing: marketingCommand,
    },
  };
  payload.primary = pickPrimary(payload);
  payload.actions = buildActions({ social, engagement, marketing, primary: payload.primary });

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
      marketing: {
        primary: marketing?.primary || {},
        health: marketing?.health || null,
        topSignal: marketing?.senseSummary?.topSignal || null,
        recommendations: marketing?.recommendations || [],
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
  console.log(`marketing: ${marketingCommand}`);
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[blog ops doctor] 실패:', error?.message || error);
  process.exit(1);
});

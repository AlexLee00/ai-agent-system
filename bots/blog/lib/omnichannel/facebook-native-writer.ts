'use strict';

/**
 * bots/blog/lib/omnichannel/facebook-native-writer.ts
 *
 * strategy_native Facebook Page 콘텐츠 생성기.
 * 링크 공유형 템플릿이 아니라 campaign objective/brand_axis 기반 native 메시지를 만든다.
 */

function clampRatio(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function resolveBrandAxis({ campaign = {}, directives = {} } = {}) {
  const explicit = String(campaign?.brand_axis || campaign?.brandAxis || '').trim();
  if (explicit && explicit !== 'mixed') return explicit;
  const cafeRatio = clampRatio(directives?.campaignMix?.cafeLibraryRatio, 0.5);
  const dadRatio = clampRatio(directives?.campaignMix?.seunghoDadRatio, 0.5);
  if (cafeRatio > dadRatio + 0.05) return 'cafe_library';
  if (dadRatio > cafeRatio + 0.05) return 'seungho_dad';
  return 'mixed';
}

function resolveObjective(campaign = {}) {
  const objective = String(campaign?.objective || 'awareness').trim();
  return objective || 'awareness';
}

function buildCafeMessage(objective, mode = 'community') {
  const isConversion = objective === 'conversion' || mode === 'conversion';
  if (isConversion) {
    return [
      '오늘도 집중이 필요한 분들을 위해 좌석 운영 상태를 정리했습니다.',
      '지금 예약이 가능한 시간대를 확인하고, 내 루틴에 맞는 자리로 시작해 보세요.',
      '가장 자주 묻는 질문도 함께 정리해두었습니다.',
      '지금 필요한 조건이 있으면 댓글로 남겨주세요. 바로 확인해드릴게요.',
    ].join('\n\n');
  }
  return [
    '공부가 잘 되는 날에는 공간의 리듬이 맞아 있습니다.',
    '최근 이용자들이 자주 이야기한 집중 포인트를 간단히 정리했습니다.',
    '여러분은 어떤 시간대와 좌석이 가장 잘 맞으셨나요?',
    '댓글로 경험을 나눠주시면 다음 운영 개선에 반영하겠습니다.',
  ].join('\n\n');
}

function buildDadMessage(objective, mode = 'community') {
  const isConversion = objective === 'conversion' || mode === 'conversion';
  if (isConversion) {
    return [
      '자동화는 “만드는 것”보다 “운영되는 것”이 더 어렵습니다.',
      '오늘은 실제 운영에서 전환률을 올리는 체크포인트를 짧게 공유합니다.',
      '실패 로그를 줄이는 관찰 포인트와 수정 순서도 함께 정리했습니다.',
      '여러분의 현재 병목도 댓글로 남겨주시면 다음 포스트에서 케이스로 다뤄보겠습니다.',
    ].join('\n\n');
  }
  return [
    'AI 자동화가 잘 안 굴러갈 때 공통적으로 빠지는 지점이 있습니다.',
    '최근 운영 회고에서 반복된 패턴을 커뮤니티형으로 공유합니다.',
    '여러분은 자동화에서 어떤 순간이 가장 어렵나요?',
    '의견을 남겨주시면 다음 실험에 바로 반영하겠습니다.',
  ].join('\n\n');
}

function buildHashtags(brandAxis, objective) {
  if (brandAxis === 'cafe_library' || brandAxis === 'mixed') {
    const tags = ['#커피랑도서관', '#분당서현', '#스터디카페', '#집중루틴'];
    if (objective === 'conversion') tags.push('#예약문의', '#스터디룸예약');
    return tags;
  }
  const tags = ['#승호아빠', '#AI자동화', '#운영회고', '#개발기획'];
  if (objective === 'conversion') tags.push('#실행전략', '#전환체크');
  return tags;
}

function writeFacebookNativeVariant({
  campaign = {},
  directives = {},
  variantId = '',
  campaignId = '',
} = {}) {
  const brandAxis = resolveBrandAxis({ campaign, directives });
  const objective = resolveObjective(campaign);
  const conversationMode = String(directives?.creativePolicy?.facebookConversationMode || 'community');
  const hashtags = buildHashtags(brandAxis, objective);
  const body = (brandAxis === 'cafe_library' || brandAxis === 'mixed')
    ? buildCafeMessage(objective, conversationMode)
    : buildDadMessage(objective, conversationMode);
  const title = (brandAxis === 'cafe_library' || brandAxis === 'mixed')
    ? (objective === 'conversion' ? '커피랑도서관 예약 전 확인 포인트' : '커피랑도서관 이용 경험 토론 포인트')
    : (objective === 'conversion' ? '승호아빠 자동화 실행 체크포인트' : '승호아빠 자동화 운영 토론 포인트');

  return {
    variant_id: variantId,
    campaign_id: campaignId,
    platform: 'facebook_page',
    source_mode: 'strategy_native',
    title,
    body: `${body}\n\n${hashtags.join(' ')}`,
    caption: `${body}\n\n${hashtags.join(' ')}`,
    hashtags,
    cta: objective === 'conversion' ? '댓글/메시지로 현재 상황을 남겨주세요.' : null,
    asset_refs: {
      generation_hint: {
        brandAxis,
        objective,
        conversationMode,
      },
    },
  };
}

module.exports = {
  writeFacebookNativeVariant,
};


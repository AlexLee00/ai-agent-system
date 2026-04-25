'use strict';

/**
 * bots/blog/lib/omnichannel/instagram-native-writer.ts
 *
 * strategy_native Instagram 콘텐츠 생성기.
 * 블로그 본문 파생이 아니라 campaign brief(brand/objective/directives) 기준으로 캡션을 생성한다.
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

function pickCafeHook(objective, hookIntensity = 'balanced') {
  const aggressive = hookIntensity === 'high';
  const map = {
    conversion: aggressive
      ? '지금 자리 없으면 오늘 루틴이 깨집니다.'
      : '시험기간, 자리 선택 하나가 집중력을 바꿉니다.',
    engagement: aggressive
      ? '공부가 안 되는 날은 환경부터 바꿔야 합니다.'
      : '조용한 공간 하나가 루틴을 지켜줍니다.',
    awareness: aggressive
      ? '서현역 근처, 집중 가능한 공간 찾고 계셨다면.'
      : '커피랑도서관 분당서현점을 처음 오신다면 이 포인트부터 보세요.',
    retention: aggressive
      ? '매일 오는 분들은 이미 알고 있는 좌석 전략.'
      : '재방문이 많은 이유는 작은 운영 디테일에 있습니다.',
    brand_trust: aggressive
      ? '오래 버틴 매장은 이유 없이 유지되지 않습니다.'
      : '꾸준히 선택받는 공간에는 공통점이 있습니다.',
  };
  return map[objective] || map.awareness;
}

function pickDadHook(objective, hookIntensity = 'balanced') {
  const aggressive = hookIntensity === 'high';
  const map = {
    conversion: aggressive
      ? '자동화는 시작보다 운영에서 갈립니다.'
      : 'AI 자동화를 붙일 때 전환을 만드는 최소 구조를 정리했습니다.',
    engagement: aggressive
      ? '잘 만든 자동화도 관측이 없으면 무너집니다.'
      : '자동화 운영에서 자주 놓치는 포인트를 짧게 정리했습니다.',
    awareness: aggressive
      ? '요즘 자동화, 왜 다들 먼저 실패할까요?'
      : '승호아빠의 자동화 운영 방식, 핵심만 공유합니다.',
    retention: aggressive
      ? '루틴은 의지가 아니라 시스템으로 유지됩니다.'
      : '꾸준함을 만드는 자동화 루틴, 이렇게 운영합니다.',
    brand_trust: aggressive
      ? '실패 로그를 공개하지 않으면 개선이 멈춥니다.'
      : '실패와 회복 과정을 기록하는 이유를 공유합니다.',
  };
  return map[objective] || map.awareness;
}

function pickCta(brandAxis, objective) {
  if (brandAxis === 'cafe_library' || brandAxis === 'mixed') {
    if (objective === 'conversion') return '좌석/스터디룸 상황은 프로필 링크에서 바로 확인하세요.';
    return '저장해두고 집중 루틴 만들 때 다시 꺼내 보세요.';
  }
  if (objective === 'conversion') return '적용 체크리스트는 블로그에서 바로 확인하세요.';
  return '저장해두고 운영 회고 때 다시 확인해 보세요.';
}

function buildHashtags(brandAxis, objective, preferredCategory = '') {
  if (brandAxis === 'cafe_library' || brandAxis === 'mixed') {
    const tags = ['#커피랑도서관', '#스터디카페', '#분당서현', '#서현역스터디카페', '#집중루틴'];
    if (objective === 'conversion') tags.push('#스터디룸예약', '#좌석전략');
    if (preferredCategory) tags.push(`#${String(preferredCategory).replace(/\s+/g, '')}`);
    return tags;
  }
  const tags = ['#승호아빠', '#AI자동화', '#운영자동화', '#개발기획', '#실전회고'];
  if (objective === 'conversion') tags.push('#체크리스트', '#실행전략');
  if (preferredCategory) tags.push(`#${String(preferredCategory).replace(/\s+/g, '')}`);
  return tags;
}

function writeInstagramNativeVariant({
  campaign = {},
  directives = {},
  variantId = '',
  campaignId = '',
} = {}) {
  const brandAxis = resolveBrandAxis({ campaign, directives });
  const objective = resolveObjective(campaign);
  const hookIntensity = String(directives?.creativePolicy?.reelHookIntensity || 'balanced');
  const thumbnailAggro = String(directives?.creativePolicy?.thumbnailAggro || 'medium');
  const preferredCategory = String(campaign?.preferredCategory || directives?.titlePolicy?.keywordBias?.[0] || '').trim();

  const hook = (brandAxis === 'cafe_library' || brandAxis === 'mixed')
    ? pickCafeHook(objective, hookIntensity)
    : pickDadHook(objective, hookIntensity);
  const cta = pickCta(brandAxis, objective);
  const hashtags = buildHashtags(brandAxis, objective, preferredCategory);
  const title = (brandAxis === 'cafe_library' || brandAxis === 'mixed')
    ? `커피랑도서관 ${objective === 'conversion' ? '예약 전 확인 포인트' : '집중 루틴 포인트'}`
    : `승호아빠 자동화 ${objective === 'conversion' ? '적용 체크포인트' : '운영 인사이트'}`;

  const caption = [
    hook,
    '',
    (brandAxis === 'cafe_library' || brandAxis === 'mixed')
      ? '커피랑도서관 분당서현점 운영팀이 오늘 바로 써먹을 포인트만 정리했습니다.'
      : '승호아빠가 실운영 기준으로 바로 적용 가능한 포인트만 정리했습니다.',
    '',
    cta,
    '',
    hashtags.join(' '),
  ].join('\n');

  return {
    variant_id: variantId,
    campaign_id: campaignId,
    platform: 'instagram_reel',
    source_mode: 'strategy_native',
    title,
    body: null,
    caption,
    hashtags,
    cta,
    asset_refs: {
      generation_hint: {
        brandAxis,
        objective,
        hookIntensity,
        thumbnailAggro,
        preferredCategory: preferredCategory || '',
      },
    },
  };
}

module.exports = {
  writeInstagramNativeVariant,
};

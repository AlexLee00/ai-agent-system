'use strict';

/**
 * bots/blog/lib/omnichannel/naver-native-writer.ts
 *
 * strategy_native Naver long-form brief 생성기.
 * 현재 queue 실행은 social 중심이지만, campaign 기준 long-form 초안을 준비할 수 있도록 모듈화한다.
 */

function resolveBrandAxis(campaign = {}) {
  const axis = String(campaign?.brand_axis || campaign?.brandAxis || 'mixed').trim();
  return axis || 'mixed';
}

function resolveObjective(campaign = {}) {
  const objective = String(campaign?.objective || 'awareness').trim();
  return objective || 'awareness';
}

function buildOutline(brandAxis, objective) {
  if (brandAxis === 'cafe_library' || brandAxis === 'mixed') {
    const intro = objective === 'conversion'
      ? '오늘은 실제 예약 전환으로 이어지는 운영 포인트를 정리합니다.'
      : '오늘은 집중 루틴을 만드는 운영 포인트를 정리합니다.';
    return [
      intro,
      '1) 이용자가 실제로 막히는 지점 정리',
      '2) 시간대/좌석/예약 동선에서의 개선 포인트',
      '3) 오늘 바로 적용 가능한 체크리스트',
      '4) 다음 방문 전 확인하면 좋은 기준',
    ];
  }
  const intro = objective === 'conversion'
    ? '오늘은 자동화 운영에서 실제 전환으로 이어진 체크포인트를 정리합니다.'
    : '오늘은 자동화 운영에서 반복적으로 발생한 병목 패턴을 정리합니다.';
  return [
    intro,
    '1) 최근 실패 로그에서 반복된 원인',
    '2) 운영에서 바로 쓰는 관측 지표',
    '3) 전략/실행/검증 순서의 최소 루프',
    '4) 다음 사이클에서 실험할 항목',
  ];
}

function writeNaverNativeVariant({
  campaign = {},
  variantId = '',
  campaignId = '',
} = {}) {
  const brandAxis = resolveBrandAxis(campaign);
  const objective = resolveObjective(campaign);
  const title = (brandAxis === 'cafe_library' || brandAxis === 'mixed')
    ? '커피랑도서관 운영 기준으로 정리한 집중 루틴 체크리스트'
    : '승호아빠 자동화 운영에서 바로 쓰는 실전 체크리스트';
  const outline = buildOutline(brandAxis, objective);
  const body = outline.join('\n');

  return {
    variant_id: variantId,
    campaign_id: campaignId,
    platform: 'naver_blog',
    source_mode: 'strategy_native',
    title,
    body,
    caption: null,
    hashtags: [],
    cta: objective === 'conversion' ? '본문 하단 체크리스트를 오늘 운영에 바로 적용해보세요.' : null,
    asset_refs: {
      generation_hint: {
        brandAxis,
        objective,
        longform: true,
      },
    },
  };
}

module.exports = {
  writeNaverNativeVariant,
};


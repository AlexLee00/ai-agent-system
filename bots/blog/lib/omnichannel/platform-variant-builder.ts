'use strict';

/**
 * bots/blog/lib/omnichannel/platform-variant-builder.ts
 *
 * Campaign + Strategy에서 채널별 platform_variant를 독립 생성.
 * 네이버 포스트 여부와 무관하게 strategy_native 콘텐츠를 만든다.
 */

const path = require('path');
const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const kst = require('../../../../packages/core/lib/kst');

function generateId(prefix = 'var') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

/** 커피랑도서관 Instagram 기본 해시태그 */
const HASHTAGS_CAFE_INSTAGRAM = [
  '#스터디카페', '#커피랑도서관', '#분당서현', '#서현역스터디카페',
  '#분당서현스터디카페', '#스터디카페분당', '#공부카페', '#독서실카페',
  '#스터디룸', '#집중공부', '#시험공부', '#카공족',
];

/** 승호아빠 Instagram 기본 해시태그 */
const HASHTAGS_SEUNGHO_INSTAGRAM = [
  '#승호아빠', '#개발자일상', '#IT블로그', '#자동화개발',
  '#기획자일상', '#AI자동화', '#사이드프로젝트', '#개발블로그',
  '#개발기록', '#성장일기',
];

/** Facebook 기본 해시태그 */
const HASHTAGS_CAFE_FACEBOOK = ['#스터디카페', '#커피랑도서관', '#분당서현', '#분당스터디'];
const HASHTAGS_SEUNGHO_FACEBOOK = ['#승호아빠', '#개발자', '#AI자동화'];

/**
 * brand_axis + objective에 따라 채널별 콘텐츠 brief를 생성.
 */
function buildContentBrief({ brandAxis, objective, directives = {} }) {
  const isCafe = brandAxis === 'cafe_library' || brandAxis === 'mixed';
  const isSeungho = brandAxis === 'seungho_dad' || brandAxis === 'mixed';

  const cafeTitle = (() => {
    const objMap = {
      conversion: '지금 바로 스터디룸 예약하세요 — 커피랑도서관 분당서현점',
      engagement: '집중력이 올라가는 공간, 커피랑도서관 분당서현의 비밀',
      awareness: '분당서현역 근처 조용한 스터디카페, 커피랑도서관',
      retention: '매일 오는 이유가 있어요 — 커피랑도서관 분당서현 이용 꿀팁',
      brand_trust: '오픈 2년, 수천 명이 선택한 분당 스터디카페',
    };
    return objMap[objective] || objMap.awareness;
  })();

  const seunghoTitle = (() => {
    const objMap = {
      conversion: 'AI 자동화로 매달 수십 시간을 절약하는 방법',
      engagement: '개발자가 블로그를 자동화하면 벌어지는 일',
      awareness: '승호아빠의 AI 자동화 시스템 소개',
      retention: '3개월째 매일 글 올리는 AI 자동화 루틴',
      brand_trust: '코드 한 줄 없이도 작동하는 자동화 시스템',
    };
    return objMap[objective] || objMap.awareness;
  })();

  return {
    isCafe,
    isSeungho,
    cafeTitle: isCafe ? cafeTitle : null,
    seunghoTitle: isSeungho ? seunghoTitle : null,
    primaryTitle: isCafe ? cafeTitle : seunghoTitle,
  };
}

/**
 * Instagram Reel variant 빌드
 */
function buildInstagramReelVariant({ campaignId, brandAxis, objective, directives = {} }) {
  const variantId = generateId('var');
  const brief = buildContentBrief({ brandAxis, objective, directives });
  const isCafe = brandAxis === 'cafe_library' || brandAxis === 'mixed';

  const hookLines = isCafe
    ? ['📚 시험 앞두고 자리 없어서 발길 돌린 적 있나요?', '☕ 조용하고 집중되는 공간이 필요할 때']
    : ['🤖 AI 자동화 시작 3개월, 이렇게 달라졌습니다', '⚡ 개발자가 블로그 자동화를 한 진짜 이유'];

  const ctaLine = isCafe
    ? '▶ 예약 링크 바이오에서 확인 — 지금 자리 있어요!'
    : '▶ 자동화 노하우는 블로그에서 전부 공개 중입니다';

  const hashtags = isCafe ? HASHTAGS_CAFE_INSTAGRAM : HASHTAGS_SEUNGHO_INSTAGRAM;

  const caption = [
    hookLines[0],
    '',
    brief.primaryTitle,
    '',
    hookLines[1],
    '',
    ctaLine,
    '',
    hashtags.join(' '),
  ].join('\n');

  return {
    variant_id: variantId,
    campaign_id: campaignId,
    platform: 'instagram_reel',
    source_mode: 'strategy_native',
    title: brief.primaryTitle,
    body: null,
    caption,
    hashtags,
    cta: ctaLine,
    asset_refs: null,
    tracking_url: null,
    quality_score: null,
    quality_status: 'pending',
  };
}

/**
 * Facebook Page variant 빌드
 */
function buildFacebookPageVariant({ campaignId, brandAxis, objective, directives = {} }) {
  const variantId = generateId('var');
  const brief = buildContentBrief({ brandAxis, objective, directives });
  const isCafe = brandAxis === 'cafe_library' || brandAxis === 'mixed';
  const hashtags = isCafe ? HASHTAGS_CAFE_FACEBOOK : HASHTAGS_SEUNGHO_FACEBOOK;

  const message = (() => {
    if (isCafe) {
      const msgMap = {
        conversion: `📅 오늘도 자리 있어요!\n\n커피랑도서관 분당서현점입니다.\n스터디룸 예약은 링크에서 바로 가능해요.\n\n${hashtags.join(' ')}`,
        engagement: `☕ 집중되는 공간, 어떻게 만들어질까요?\n\n조명, 온도, 소음까지 설계한 스터디카페.\n오늘도 많은 분들이 열심히 공부 중입니다 😊\n\n${hashtags.join(' ')}`,
        awareness: `안녕하세요, 커피랑도서관 분당서현점입니다.\n\n분당서현역 도보 3분 거리, 24시간 이용 가능한 스터디카페입니다.\n\n${hashtags.join(' ')}`,
        retention: `오늘도 감사합니다 ☺️\n\n매일 이용해 주시는 분들 덕분에 운영하고 있어요.\n앞으로도 더 좋은 공간으로 보답하겠습니다.\n\n${hashtags.join(' ')}`,
        brand_trust: `커피랑도서관 분당서현점, 오픈 이후 지금까지.\n\n수많은 분들이 시험 준비, 업무, 독서를 위해 방문해 주셨습니다.\n믿어주셔서 감사합니다 🙏\n\n${hashtags.join(' ')}`,
      };
      return msgMap[objective] || msgMap.awareness;
    }
    const msgMap = {
      conversion: `AI 자동화 도구가 궁금하신 분들 👋\n\n블로그에 전체 공개 중입니다. 링크 방문해 보세요.\n\n${hashtags.join(' ')}`,
      engagement: `코드 없이 자동화가 가능할까요?\n\n저도 처음엔 반신반의했습니다. 지금은 매일 자동으로 돌아가고 있어요.\n\n${hashtags.join(' ')}`,
      awareness: `안녕하세요, 승호아빠입니다.\n\nAI 자동화, 개발, 기획을 다루는 블로그를 운영하고 있습니다.\n\n${hashtags.join(' ')}`,
      retention: `오늘도 읽어주셔서 감사합니다 🙏\n\n꾸준히 기록하는 힘을 믿습니다.\n\n${hashtags.join(' ')}`,
      brand_trust: `3개월 동안 매일 자동화 기록을 공개하고 있습니다.\n\n과정도, 실패도 모두 투명하게 올리고 있어요.\n\n${hashtags.join(' ')}`,
    };
    return msgMap[objective] || msgMap.awareness;
  })();

  return {
    variant_id: variantId,
    campaign_id: campaignId,
    platform: 'facebook_page',
    source_mode: 'strategy_native',
    title: brief.primaryTitle,
    body: message,
    caption: message,
    hashtags,
    cta: null,
    asset_refs: null,
    tracking_url: null,
    quality_score: null,
    quality_status: 'pending',
  };
}

/**
 * Campaign에서 플랫폼별 variant를 생성하고 DB에 저장.
 */
async function buildPlatformVariants({ campaign, directives = {}, dryRun = false }) {
  const { campaign_id: campaignId, brand_axis: brandAxis, objective } = campaign;
  const variants = [];

  // 인스타그램 릴스 variant
  const instagramVariant = buildInstagramReelVariant({ campaignId, brandAxis, objective, directives });
  variants.push(instagramVariant);

  // 페이스북 페이지 variant
  const facebookVariant = buildFacebookPageVariant({ campaignId, brandAxis, objective, directives });
  variants.push(facebookVariant);

  if (!dryRun) {
    for (const v of variants) {
      await pgPool.query('blog', `
        INSERT INTO blog.marketing_platform_variants
          (variant_id, campaign_id, platform, source_mode, title, body, caption,
           hashtags, cta, asset_refs, tracking_url, quality_score, quality_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
        ON CONFLICT (variant_id) DO NOTHING
      `, [
        v.variant_id,
        v.campaign_id,
        v.platform,
        v.source_mode,
        v.title,
        v.body,
        v.caption,
        v.hashtags,
        v.cta,
        v.asset_refs ? JSON.stringify(v.asset_refs) : null,
        v.tracking_url,
        v.quality_score,
        v.quality_status,
      ]);
    }
  }

  console.log(`[variant-builder] ${variants.length}개 variant 생성 (campaign=${campaignId} dryRun=${dryRun})`);
  return variants;
}

module.exports = {
  buildPlatformVariants,
  buildInstagramReelVariant,
  buildFacebookPageVariant,
};

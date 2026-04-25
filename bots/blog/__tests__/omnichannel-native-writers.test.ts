'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

describe('omnichannel native writers', () => {
  const { writeInstagramNativeVariant } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/instagram-native-writer.ts'));
  const { writeFacebookNativeVariant } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/facebook-native-writer.ts'));
  const { writeNaverNativeVariant } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/naver-native-writer.ts'));

  test('instagram writer — cafe conversion content', () => {
    const variant = writeInstagramNativeVariant({
      campaign: {
        campaign_id: 'camp_1',
        brand_axis: 'cafe_library',
        objective: 'conversion',
      },
      directives: {
        creativePolicy: {
          reelHookIntensity: 'high',
        },
      },
      variantId: 'var_ig_1',
      campaignId: 'camp_1',
    });
    expect(variant.platform).toBe('instagram_reel');
    expect(variant.caption).toContain('커피랑도서관');
    expect(Array.isArray(variant.hashtags)).toBe(true);
    expect(variant.hashtags.join(' ')).toContain('스터디');
  });

  test('facebook writer — dad community content', () => {
    const variant = writeFacebookNativeVariant({
      campaign: {
        campaign_id: 'camp_2',
        brand_axis: 'seungho_dad',
        objective: 'engagement',
      },
      directives: {
        creativePolicy: {
          facebookConversationMode: 'community',
        },
      },
      variantId: 'var_fb_1',
      campaignId: 'camp_2',
    });
    expect(variant.platform).toBe('facebook_page');
    expect(variant.body).toContain('자동화');
    expect(variant.body).toContain('#승호아빠');
  });

  test('naver writer — longform outline', () => {
    const variant = writeNaverNativeVariant({
      campaign: {
        campaign_id: 'camp_3',
        brand_axis: 'cafe_library',
        objective: 'awareness',
      },
      variantId: 'var_nv_1',
      campaignId: 'camp_3',
    });
    expect(variant.platform).toBe('naver_blog');
    expect(variant.body).toContain('1)');
    expect(variant.body).toContain('2)');
  });
});


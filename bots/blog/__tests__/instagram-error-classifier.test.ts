'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

const {
  classifyInstagramError,
  resolveInstagramFailureKind,
} = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/instagram-error-classifier.ts')
);

describe('instagram-error-classifier', () => {
  test('ffmpeg 숏폼 렌더 실패는 asset_prepare로 분류', () => {
    expect(classifyInstagramError('ffmpeg 숏폼 렌더 실패: invalid filter')).toBe('asset_prepare');
  });

  test('썸네일 미존재 렌더 실패는 asset_prepare로 분류', () => {
    expect(classifyInstagramError('렌더할 썸네일을 찾지 못했습니다.')).toBe('asset_prepare');
  });

  test('native reel 자산 키워드는 asset_prepare로 분류', () => {
    expect(classifyInstagramError('native_reel_render_missing_output')).toBe('asset_prepare');
  });

  test('unknown 분류는 preferAssetOnUnknown일 때 asset_prepare로 강제', () => {
    expect(
      resolveInstagramFailureKind('unexpected non classified failure', {
        fallback: 'asset_prepare',
        preferAssetOnUnknown: true,
      })
    ).toBe('asset_prepare');
  });
});

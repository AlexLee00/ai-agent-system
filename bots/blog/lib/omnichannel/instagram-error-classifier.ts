'use strict';

/**
 * Instagram 발행 오류를 라우팅용 failure kind로 정규화한다.
 */
function classifyInstagramError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (msg.includes('access token') || msg.includes('token') || msg.includes('oauth')) return 'auth';
  if (
    msg.includes('prepare')
    || msg.includes('staged')
    || msg.includes('공개 비디오 파일')
    || msg.includes('native_reel')
    || msg.includes('reel_asset')
    || msg.includes('render_shortform')
    || msg.includes('숏폼 렌더')
    || msg.includes('ffmpeg')
    || msg.includes('렌더할 썸네일')
  ) {
    return 'asset_prepare';
  }
  if (msg.includes('공개 비디오 url') || msg.includes('url이 아직 응답')) return 'media_url';
  if (msg.includes('container') || msg.includes('status_code') || msg.includes('processing')) return 'container_processing';
  if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('publish') || msg.includes('media_publish')) return 'publish';
  return 'unknown';
}

function resolveInstagramFailureKind(error, { fallback = 'unknown', preferAssetOnUnknown = false } = {}) {
  const classified = classifyInstagramError(error);
  if (classified === 'unknown' && preferAssetOnUnknown) return 'asset_prepare';
  return classified || fallback;
}

module.exports = {
  classifyInstagramError,
  resolveInstagramFailureKind,
};

'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');
const { fetchHubSecrets } = require('./hub-client');
const {
  getInstagramTokenConfig,
  getTokenHealth,
} = require('./instagram-token-manager.ts');
const {
  resolveInstagramHostedMediaUrl,
  getInstagramHostedAssetLocalPath,
} = require('./instagram-image-host.ts');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const MIN_REQUEST_INTERVAL_MS = 20 * 1000;
let _lastGraphRequestAt = 0;

function readStoreInstagramConfig() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.instagram || {};
  } catch {
    return {};
  }
}

async function getInstagramConfig() {
  // NOTE:
  // Instagram 토큰/IG User ID는 아직 허브 시크릿에 정식 등록되지 않았습니다.
  // 토큰이 비어 있는 동안 허브를 계속 조회하면 "설정 가능한 경로"처럼 보이는데
  // 실제로는 미등록 상태라 운영자 판단만 흐리게 만듭니다.
  //
  // 그래서 현재는 허브 조회를 잠시 끄고, 로컬 secrets-store.json 또는 env만 봅니다.
  // 인스타 자격증명이 준비되면 아래 라인을 복구하면 됩니다.
  // const hubData = await fetchHubSecrets('instagram');
  const hubData = {};
  const storeData = readStoreInstagramConfig();
  const tokenConfig = getInstagramTokenConfig();
  return {
    accessToken: hubData?.access_token || tokenConfig.accessToken || '',
    igUserId: hubData?.ig_user_id || tokenConfig.igUserId || '',
    appId: hubData?.app_id || tokenConfig.appId || '',
    appSecret: hubData?.app_secret || tokenConfig.appSecret || '',
    businessAccountId: hubData?.business_account_id || tokenConfig.businessAccountId || '',
    apiVersion: hubData?.api_version || tokenConfig.apiVersion || 'v21.0',
    baseUrl: hubData?.base_url || tokenConfig.baseUrl || 'https://graph.facebook.com',
    tokenExpiresAt: tokenConfig.tokenExpiresAt || null,
    tokenHealth: getTokenHealth(tokenConfig),
    defaultStatus: process.env.INSTAGRAM_PUBLISH_DEFAULT_STATUS || 'draft',
  };
}

function validatePublishInputs({ videoUrl, caption }) {
  if (!videoUrl) throw new Error('videoUrl이 필요합니다.');
  if (!caption) throw new Error('caption이 필요합니다.');
}

function ensureReady(config) {
  if (!config.accessToken) throw new Error('INSTAGRAM_GRAPH_ACCESS_TOKEN이 없습니다.');
  if (!config.igUserId) throw new Error('INSTAGRAM_GRAPH_IG_USER_ID가 없습니다.');
}

function buildCreateContainerRequest(config, { videoUrl, caption }) {
  const igUserId = config.igUserId || '{IG_USER_ID}';
  return {
    method: 'POST',
    url: `${config.baseUrl}/${config.apiVersion}/${igUserId}/media`,
    body: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: true,
    },
  };
}

function buildPublishRequest(config, creationId) {
  const igUserId = config.igUserId || '{IG_USER_ID}';
  return {
    method: 'POST',
    url: `${config.baseUrl}/${config.apiVersion}/${igUserId}/media_publish`,
    body: {
      creation_id: creationId,
    },
  };
}

async function postJson(url, body, accessToken) {
  const sinceLast = Date.now() - _lastGraphRequestAt;
  if (_lastGraphRequestAt > 0 && sinceLast < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - sinceLast));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  _lastGraphRequestAt = Date.now();
  const data = await response.json().catch(() => ({}));
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
    const retry = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    _lastGraphRequestAt = Date.now();
    const retryData = await retry.json().catch(() => ({}));
    if (!retry.ok) {
      throw new Error(`Instagram Graph API 실패: HTTP ${retry.status} ${JSON.stringify(retryData)}`);
    }
    return retryData;
  }
  if (!response.ok) {
    throw new Error(`Instagram Graph API 실패: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function verifyPublicMediaUrl(url) {
  const response = await fetch(url, {
    method: 'HEAD',
  }).catch(() => null);

  if (response?.ok) {
    return {
      ok: true,
      status: response.status,
      method: 'HEAD',
    };
  }

  const retry = await fetch(url, {
    method: 'GET',
  }).catch(() => null);

  if (retry?.ok) {
    return {
      ok: true,
      status: retry.status,
      method: 'GET',
    };
  }

  return {
    ok: false,
    status: retry?.status || response?.status || 0,
    method: retry ? 'GET' : (response ? 'HEAD' : 'fetch'),
  };
}

async function publishInstagramReel({
  videoUrl,
  caption,
  dryRun = false,
}) {
  validatePublishInputs({ videoUrl, caption });
  const config = await getInstagramConfig();
  const createRequest = buildCreateContainerRequest(config, { videoUrl, caption });

  if (dryRun) {
    return {
      dryRun: true,
      configReady: Boolean(config.accessToken && config.igUserId),
      createRequest,
      publishRequest: buildPublishRequest(config, 'CREATION_ID_PLACEHOLDER'),
    };
  }

  ensureReady(config);
  const mediaCheck = await verifyPublicMediaUrl(videoUrl);
  if (!mediaCheck.ok) {
    throw new Error(`Instagram 공개 비디오 URL이 아직 응답하지 않습니다: HTTP ${mediaCheck.status || 'unknown'} (${mediaCheck.method})`);
  }
  const creation = await postJson(createRequest.url, createRequest.body, config.accessToken);
  const creationId = creation.id || creation.creation_id;
  if (!creationId) {
    throw new Error(`Instagram media 생성 응답에 id가 없습니다: ${JSON.stringify(creation)}`);
  }

  const publishRequest = buildPublishRequest(config, creationId);
  const published = await postJson(publishRequest.url, publishRequest.body, config.accessToken);

  return {
    dryRun: false,
    creationId,
    publishId: published.id || null,
    createRequest,
    publishRequest,
  };
}

function buildFileVideoUrl(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`릴스 파일을 찾을 수 없습니다: ${filePath}`);
  }
  return `file://${filePath}`;
}

function buildHostedVideoUrl(filePath = '') {
  const hosted = resolveInstagramHostedMediaUrl(filePath, { kind: 'reels' });
  if (!hosted.ready || !hosted.publicUrl) {
    throw new Error(`Instagram 공개 비디오 URL이 준비되지 않았습니다: ${hosted.note}`);
  }
  if (hosted.mode === 'github_pages') {
    const localTarget = getInstagramHostedAssetLocalPath(filePath, { kind: 'reels' });
    if (!fs.existsSync(localTarget.targetPath)) {
      throw new Error(`Instagram 공개 비디오 파일이 아직 준비되지 않았습니다: ${localTarget.targetPath} (prepare:instagram-media 실행 필요)`);
    }
  }
  return hosted.publicUrl;
}

module.exports = {
  getInstagramConfig,
  buildCreateContainerRequest,
  buildPublishRequest,
  publishInstagramReel,
  buildFileVideoUrl,
  buildHostedVideoUrl,
  verifyPublicMediaUrl,
};

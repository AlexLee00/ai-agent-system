'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');
const { fetchHubSecrets } = require('./hub-client');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

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
  return {
    accessToken: hubData?.access_token || storeData?.access_token || process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN || '',
    igUserId: hubData?.ig_user_id || storeData?.ig_user_id || process.env.INSTAGRAM_GRAPH_IG_USER_ID || '',
    apiVersion: hubData?.api_version || storeData?.api_version || process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0',
    baseUrl: hubData?.base_url || storeData?.base_url || process.env.INSTAGRAM_GRAPH_BASE_URL || 'https://graph.facebook.com',
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
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Instagram Graph API 실패: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
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

module.exports = {
  getInstagramConfig,
  buildCreateContainerRequest,
  buildPublishRequest,
  publishInstagramReel,
  buildFileVideoUrl,
};

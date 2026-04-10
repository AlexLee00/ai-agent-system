'use strict';

const fs = require('fs');

function getInstagramConfig() {
  return {
    accessToken: process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN || '',
    igUserId: process.env.INSTAGRAM_GRAPH_IG_USER_ID || '',
    apiVersion: process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0',
    baseUrl: process.env.INSTAGRAM_GRAPH_BASE_URL || 'https://graph.facebook.com',
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
  const config = getInstagramConfig();
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

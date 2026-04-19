'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));

/**
 * @typedef {{
 *   accessToken?: string,
 *   pageId?: string,
 *   baseUrl?: string,
 *   apiVersion?: string,
 *   credentialSource?: string
 * }} FacebookPublishConfig
 */

/** @returns {Promise<FacebookPublishConfig>} */
function getFacebookPublishConfig() {
  return /** @type {Promise<FacebookPublishConfig>} */ (getInstagramConfig());
}

/** @param {FacebookPublishConfig} config */
function ensureFacebookReady(config) {
  if (!config?.accessToken) throw new Error('facebook access token(meta access token)이 없습니다.');
  if (!config?.pageId) throw new Error('facebook page_id가 없습니다.');
}

/**
 * @param {FacebookPublishConfig} config
 * @param {{ redactAccessToken?: boolean }} [options]
 */
function buildFacebookPageTokenRequest(config, options = {}) {
  ensureFacebookReady(config);
  // @ts-ignore JS checkJs default-param inference is too narrow here
  const redactAccessToken = Boolean(options.redactAccessToken);
  const accessToken = redactAccessToken ? '{USER_ACCESS_TOKEN}' : config.accessToken;
  return {
    method: 'GET',
    url: `${config.baseUrl}/${config.apiVersion}/${config.pageId}?fields=access_token&access_token=${encodeURIComponent(accessToken)}`,
  };
}

/**
 * @param {FacebookPublishConfig} config
 * @param {string} pageAccessToken
 * @param {{ message: string, link?: string }} param2
 */
function buildFacebookFeedRequest(config, pageAccessToken, { message, link }) {
  ensureFacebookReady(config);
  if (!message) throw new Error('facebook 게시 message가 필요합니다.');

  /** @type {any} */
  const body = { message };
  // @ts-ignore checkJs still narrows body too aggressively here
  if (link) {
    // @ts-ignore checkJs still narrows body too aggressively here
    body.link = link;
  }

  return {
    method: 'POST',
    url: `${config.baseUrl}/${config.apiVersion}/${config.pageId}/feed`,
    body,
    accessToken: pageAccessToken,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Facebook Graph API 실패: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function publishFacebookPost({ message, link = '', dryRun = false }) {
  const config = await getFacebookPublishConfig();
  ensureFacebookReady(config);

  const pageTokenRequest = buildFacebookPageTokenRequest(config);
  if (dryRun) {
    return {
      dryRun: true,
      credentialSource: config.credentialSource || 'unknown',
      pageId: config.pageId,
      pageTokenRequest: buildFacebookPageTokenRequest(config, { redactAccessToken: true }),
      publishRequest: buildFacebookFeedRequest(config, '{PAGE_ACCESS_TOKEN}', { message, link }),
    };
  }

  const pageTokenResponse = await fetchJson(pageTokenRequest.url, { method: pageTokenRequest.method });
  const pageAccessToken = String(pageTokenResponse?.access_token || '').trim();
  if (!pageAccessToken) {
    throw new Error('Facebook 페이지 access_token을 가져오지 못했습니다.');
  }

  const publishRequest = buildFacebookFeedRequest(config, pageAccessToken, { message, link });
  const publishResponse = await fetchJson(publishRequest.url, {
    method: publishRequest.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify(publishRequest.body),
  });

  return {
    dryRun: false,
    credentialSource: config.credentialSource || 'unknown',
    pageId: config.pageId,
    pageTokenRequest,
    publishRequest,
    publishResponse,
    postId: publishResponse?.id || null,
  };
}

module.exports = {
  getFacebookPublishConfig,
  buildFacebookPageTokenRequest,
  buildFacebookFeedRequest,
  publishFacebookPost,
};

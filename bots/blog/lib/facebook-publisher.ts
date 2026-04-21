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
 * @param {string} text
 * @returns {string[]}
 */
function extractFacebookPermissionScopes(text) {
  const raw = String(text || '');
  /** @type {string[]} */
  const scopes = [];
  for (const scope of ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_metadata']) {
    if (raw.includes(scope) && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/**
 * @param {number} status
 * @param {any} data
 */
function buildFacebookGraphError(status, data) {
  const raw = `Facebook Graph API 실패: HTTP ${status} ${JSON.stringify(data || {})}`;
  const message = String(data?.error?.message || '').trim();
  const scopes = extractFacebookPermissionScopes(raw);
  let normalized = raw;
  let category = 'graph_api_error';

  if (status === 403 && scopes.length > 0) {
    category = 'permission_missing';
    normalized = `Facebook 페이지 게시 권한 부족: ${scopes.join(', ')}`;
  } else if (status === 403) {
    category = 'permission_denied';
    normalized = `Facebook 접근 권한이 부족합니다 (HTTP ${status})`;
  } else if (status === 400 && message.includes('Session has expired')) {
    category = 'token_expired';
    normalized = 'Facebook 사용자 access token 세션이 만료되었습니다.';
  } else if (status === 400 && message.includes('Unsupported post request')) {
    category = 'page_or_token_mismatch';
    normalized = 'Facebook 페이지 ID 또는 토큰 연결이 맞지 않습니다.';
  }

  const error = new Error(normalized);
  // @ts-ignore JS runtime metadata attachment
  error.rawMessage = raw;
  // @ts-ignore JS runtime metadata attachment
  error.category = category;
  // @ts-ignore JS runtime metadata attachment
  error.httpStatus = status;
  // @ts-ignore JS runtime metadata attachment
  error.permissionScopes = scopes;
  return error;
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
    throw buildFacebookGraphError(response.status, data);
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

async function checkFacebookPublishReadiness() {
  const config = await getFacebookPublishConfig();
  ensureFacebookReady(config);

  try {
    const pageTokenRequest = buildFacebookPageTokenRequest(config);
    const pageTokenResponse = await fetchJson(pageTokenRequest.url, { method: pageTokenRequest.method });
    const pageAccessToken = String(pageTokenResponse?.access_token || '').trim();
    return {
      ready: Boolean(pageAccessToken),
      credentialSource: config.credentialSource || 'unknown',
      pageId: config.pageId || '',
      permissionScopes: [],
      error: pageAccessToken ? '' : 'Facebook 페이지 access_token을 가져오지 못했습니다.',
    };
  } catch (error) {
    return {
      ready: false,
      credentialSource: config.credentialSource || 'unknown',
      pageId: config.pageId || '',
      // @ts-ignore runtime metadata
      permissionScopes: Array.isArray(error?.permissionScopes) ? error.permissionScopes : [],
      // @ts-ignore runtime metadata
      error: String(error?.message || error),
      // @ts-ignore runtime metadata
      rawError: String(error?.rawMessage || error?.message || error),
    };
  }
}

module.exports = {
  getFacebookPublishConfig,
  buildFacebookPageTokenRequest,
  buildFacebookFeedRequest,
  extractFacebookPermissionScopes,
  buildFacebookGraphError,
  checkFacebookPublishReadiness,
  publishFacebookPost,
};

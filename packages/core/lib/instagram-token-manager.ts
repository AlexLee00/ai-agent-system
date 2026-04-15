'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const DAY_MS = 24 * 60 * 60 * 1000;

function parseInstagramAuthError(error) {
  const message = String(error?.message || error || '');
  const lower = message.toLowerCase();
  if (lower.includes('session has expired') || lower.includes('"error_subcode":463')) {
    return {
      code: 'token_expired',
      note: '현재 access token이 이미 만료되었습니다. 새 토큰 재발급 또는 단기→장기 재교환이 필요합니다.',
    };
  }
  if (lower.includes('error validating client secret')) {
    return {
      code: 'invalid_client_secret',
      note: '현재 app_secret이 Meta 앱과 일치하지 않거나 잘못 복사됐을 가능성이 큽니다.',
    };
  }
  if (lower.includes('missing client_id')) {
    return {
      code: 'missing_client_id',
      note: 'client_id(app_id) 값이 빠져 있습니다.',
    };
  }
  if (lower.includes('invalid oauth access token') || lower.includes('error validating access token')) {
    return {
      code: 'invalid_access_token',
      note: 'access token이 잘못됐거나 이미 무효화된 상태일 수 있습니다.',
    };
  }
  return {
    code: 'unknown_auth_error',
    note: 'Meta 인증 실패입니다. access_token / app_id / app_secret 조합을 다시 확인해야 합니다.',
  };
}

function readStoreInstagramConfig() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.instagram || {};
  } catch {
    return {};
  }
}

function parseExpiry(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function getInstagramTokenConfig() {
  const storeData = readStoreInstagramConfig();
  return {
    accessToken: String(storeData?.access_token || process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN || '').trim(),
    igUserId: String(storeData?.ig_user_id || process.env.INSTAGRAM_GRAPH_IG_USER_ID || '').trim(),
    pageId: String(storeData?.page_id || process.env.FACEBOOK_PAGE_ID || '').trim(),
    appId: String(storeData?.app_id || process.env.INSTAGRAM_APP_ID || '').trim(),
    appSecret: String(storeData?.app_secret || process.env.INSTAGRAM_APP_SECRET || '').trim(),
    businessAccountId: String(storeData?.business_account_id || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim(),
    apiVersion: String(storeData?.api_version || process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0').trim(),
    baseUrl: String(storeData?.base_url || process.env.INSTAGRAM_GRAPH_BASE_URL || 'https://graph.facebook.com').trim(),
    tokenExpiresAt: parseExpiry(
      storeData?.token_expires_at
      || process.env.INSTAGRAM_TOKEN_EXPIRES_AT
      || '',
    ),
  };
}

function getTokenHealth(config = getInstagramTokenConfig()) {
  const now = Date.now();
  const expiresAt = config.tokenExpiresAt;
  const daysLeft = expiresAt ? Math.floor((expiresAt - now) / DAY_MS) : null;
  const needsRefresh = daysLeft !== null ? daysLeft <= 14 : false;
  const critical = daysLeft !== null ? daysLeft <= 3 : false;

  return {
    hasAccessToken: Boolean(config.accessToken),
    hasIgUserId: Boolean(config.igUserId),
    hasPageId: Boolean(config.pageId),
    hasAppId: Boolean(config.appId),
    hasAppSecret: Boolean(config.appSecret),
    tokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    daysLeft,
    needsRefresh,
    critical,
    readyForExchange: Boolean(config.accessToken && config.appSecret),
    readyForRefresh: Boolean(config.accessToken),
  };
}

function buildExchangeTokenRequest(config = getInstagramTokenConfig()) {
  if (!config.accessToken) throw new Error('instagram.access_token 이 없습니다.');
  if (!config.appId) throw new Error('instagram.app_id 이 없습니다.');
  if (!config.appSecret) throw new Error('instagram.app_secret 이 없습니다.');

  const url = new URL(`${config.baseUrl}/${config.apiVersion}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('access_token', config.accessToken);

  return {
    method: 'GET',
    url: url.toString(),
  };
}

function buildRefreshLongLivedTokenRequest(config = getInstagramTokenConfig()) {
  if (!config.accessToken) throw new Error('instagram.access_token 이 없습니다.');

  const url = new URL(`${config.baseUrl}/${config.apiVersion}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', config.accessToken);

  return {
    method: 'GET',
    url: url.toString(),
  };
}

async function exchangeToLongLivedToken(fetchImpl = fetch, config = getInstagramTokenConfig()) {
  const request = buildExchangeTokenRequest(config);
  const response = await fetchImpl(request.url, { method: request.method });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Instagram 토큰 교환 실패: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return {
    request,
    response: data,
  };
}

async function refreshLongLivedToken(fetchImpl = fetch, config = getInstagramTokenConfig()) {
  const request = buildRefreshLongLivedTokenRequest(config);
  const response = await fetchImpl(request.url, { method: request.method });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Instagram 토큰 갱신 실패: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return {
    request,
    response: data,
  };
}

module.exports = {
  getInstagramTokenConfig,
  getTokenHealth,
  buildExchangeTokenRequest,
  buildRefreshLongLivedTokenRequest,
  exchangeToLongLivedToken,
  refreshLongLivedToken,
  parseInstagramAuthError,
};

'use strict';

/**
 * packages/core/lib/meta-graph-config.ts
 *
 * Meta Graph API 통합 credential resolver.
 * Instagram / Facebook / Page / Business 설정을 hub 우선으로 resolve.
 * facebook-publisher, instagram-graph 등에서 각각 사용.
 */

const fs = require('fs');
const path = require('path');
const env = require('./env');
const { fetchHubSecrets } = require('./hub-client');
const {
  getInstagramTokenConfig,
  getTokenHealth,
} = require('./instagram-token-manager.ts');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function readStoreSection(section) {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.[section] || {};
  } catch {
    return {};
  }
}

/**
 * Instagram + Facebook 공통 필드를 hub → secrets-store → token-config 순으로 resolve.
 * @returns {Promise<MetaGraphConfig>}
 */
async function getMetaGraphConfig() {
  const [hubData, storeData] = await Promise.all([
    fetchHubSecrets('instagram').catch(() => ({})),
    Promise.resolve(readStoreSection('instagram')),
  ]);
  const tokenConfig = getInstagramTokenConfig();

  const accessToken = hubData?.access_token || storeData?.access_token || tokenConfig.accessToken || '';
  const igUserId = hubData?.ig_user_id || storeData?.ig_user_id || tokenConfig.igUserId || '';
  const pageId = hubData?.page_id || storeData?.page_id || tokenConfig.pageId || '';
  const appId = hubData?.app_id || storeData?.app_id || tokenConfig.appId || '';
  const appSecret = hubData?.app_secret || storeData?.app_secret || tokenConfig.appSecret || '';
  const businessAccountId =
    hubData?.business_account_id ||
    storeData?.business_account_id ||
    tokenConfig.businessAccountId ||
    '';
  const apiVersion =
    hubData?.api_version || storeData?.api_version || tokenConfig.apiVersion || 'v21.0';
  const baseUrl =
    hubData?.base_url || storeData?.base_url || tokenConfig.baseUrl || 'https://graph.facebook.com';
  const tokenExpiresAt =
    tokenConfig.tokenExpiresAt ||
    (hubData?.token_expires_at ? new Date(hubData.token_expires_at).getTime() : null) ||
    null;

  const credentialSource =
    hubData?.access_token || hubData?.ig_user_id
      ? 'hub'
      : storeData?.access_token || storeData?.ig_user_id
        ? 'hub_store'
        : 'env';

  const shared = {
    accessToken,
    pageId,
    appId,
    appSecret,
    businessAccountId,
    apiVersion,
    baseUrl,
    credentialSource,
    tokenExpiresAt,
    tokenHealth: getTokenHealth({
      accessToken,
      igUserId,
      appId,
      appSecret,
      businessAccountId,
      apiVersion,
      baseUrl,
      tokenExpiresAt,
    }),
  };

  return {
    ...shared,
    instagram: {
      ...shared,
      igUserId,
      defaultStatus: process.env.INSTAGRAM_PUBLISH_DEFAULT_STATUS || 'draft',
    },
    facebook: {
      ...shared,
      // Facebook은 pageId로 페이지 token 교환 후 feed 발행
    },
  };
}

/**
 * Instagram 전용 config (instagram-graph.ts 호환 shim).
 * 기존 getInstagramConfig() 호출부를 깨지 않는다.
 */
async function getInstagramConfigFromMeta() {
  const meta = await getMetaGraphConfig();
  return meta.instagram;
}

/**
 * Facebook 전용 config.
 */
async function getFacebookConfigFromMeta() {
  const meta = await getMetaGraphConfig();
  return meta.facebook;
}

module.exports = {
  getMetaGraphConfig,
  getInstagramConfigFromMeta,
  getFacebookConfigFromMeta,
};

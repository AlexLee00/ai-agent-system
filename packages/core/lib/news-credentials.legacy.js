'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const env = require('./env');

const { fetchHubSecrets } = require('./hub-client');

const SHARED_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');
const SECRETS_STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

let sharedNewsConfigCache = null;
let localSecretsNewsConfigCache = null;

function loadSharedNewsConfig() {
  if (sharedNewsConfigCache) return sharedNewsConfigCache;
  try {
    const config = yaml.load(fs.readFileSync(SHARED_CONFIG_PATH, 'utf8')) || {};
    sharedNewsConfigCache = config.news || {};
  } catch {
    sharedNewsConfigCache = {};
  }
  return sharedNewsConfigCache;
}

function loadLocalSecretsNewsConfig() {
  if (localSecretsNewsConfigCache) return localSecretsNewsConfigCache;
  try {
    const store = JSON.parse(fs.readFileSync(SECRETS_STORE_PATH, 'utf8')) || {};
    localSecretsNewsConfigCache = store.news || {};
  } catch {
    localSecretsNewsConfigCache = {};
  }
  return localSecretsNewsConfigCache;
}

async function fetchHubNewsConfig(timeoutMs = 3000) {
  const config = await fetchHubSecrets('config', timeoutMs);
  return config?.news || null;
}

async function resolveNaverCredentials(options = {}) {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();
  const localNews = loadLocalSecretsNewsConfig();

  return {
    clientId:
      process.env.NAVER_CLIENT_ID ||
      process.env.NAVER_SEARCH_CLIENT_ID ||
      process.env.NAVER_OPENAPI_CLIENT_ID ||
      hubNews?.naver_client_id ||
      localNews.naver_client_id ||
      sharedNews.naver_client_id ||
      '',
    clientSecret:
      process.env.NAVER_CLIENT_SECRET ||
      process.env.NAVER_SEARCH_CLIENT_SECRET ||
      process.env.NAVER_OPENAPI_CLIENT_SECRET ||
      hubNews?.naver_client_secret ||
      localNews.naver_client_secret ||
      sharedNews.naver_client_secret ||
      '',
  };
}

async function resolveGoogleBooksApiKey(options = {}) {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();
  const localNews = loadLocalSecretsNewsConfig();

  return (
    process.env.GOOGLE_BOOKS_API_KEY ||
    hubNews?.google_books_api_key ||
    localNews.google_books_api_key ||
    sharedNews.google_books_api_key ||
    ''
  );
}

async function resolveData4LibraryKey(options = {}) {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();
  const localNews = loadLocalSecretsNewsConfig();

  // 도서관 정보나루 키는 발급 직후 바로 동작하지 않을 수 있다.
  // 운영 메모:
  // - 콘솔/메일에서 별도 승인 완료 전까지 API 응답이 비정상일 수 있음
  // - 키가 저장되어 있어도 승인 대기 상태면 book-review-book 쪽에서 빈 결과로 내려갈 수 있음
  return (
    process.env.DATA4LIBRARY_AUTH_KEY ||
    process.env.DATA4LIBRARY_API_KEY ||
    hubNews?.data4library_auth_key ||
    localNews.data4library_auth_key ||
    sharedNews.data4library_auth_key ||
    ''
  );
}

async function resolveKakaoApiKey(options = {}) {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();
  const localNews = loadLocalSecretsNewsConfig();

  return (
    process.env.KAKAO_REST_API_KEY ||
    process.env.KAKAO_API_KEY ||
    hubNews?.kakao_rest_api_key ||
    localNews.kakao_rest_api_key ||
    sharedNews.kakao_rest_api_key ||
    ''
  );
}

module.exports = {
  loadSharedNewsConfig,
  loadLocalSecretsNewsConfig,
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
  resolveData4LibraryKey,
  resolveKakaoApiKey,
};

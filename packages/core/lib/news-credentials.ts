import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
const env = require('./env');

const { fetchHubSecrets } = require('./hub-client');

type NewsConfig = {
  naver_client_id?: string;
  naver_client_secret?: string;
  google_books_api_key?: string;
  data4library_auth_key?: string;
  kakao_rest_api_key?: string;
};

type ConfigRoot = {
  news?: NewsConfig;
};

const SHARED_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');
const SECRETS_STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

let sharedNewsConfigCache: NewsConfig | null = null;
let localSecretsNewsConfigCache: NewsConfig | null = null;

function loadSharedNewsConfig(): NewsConfig {
  if (sharedNewsConfigCache) return sharedNewsConfigCache;
  try {
    const config = (yaml.load(fs.readFileSync(SHARED_CONFIG_PATH, 'utf8')) || {}) as ConfigRoot;
    sharedNewsConfigCache = config.news || {};
  } catch {
    sharedNewsConfigCache = {};
  }
  return sharedNewsConfigCache;
}

function loadLocalSecretsNewsConfig(): NewsConfig {
  if (localSecretsNewsConfigCache) return localSecretsNewsConfigCache;
  try {
    const store = JSON.parse(fs.readFileSync(SECRETS_STORE_PATH, 'utf8')) || {};
    localSecretsNewsConfigCache = store.news || {};
  } catch {
    localSecretsNewsConfigCache = {};
  }
  return localSecretsNewsConfigCache;
}

async function fetchHubNewsConfig(timeoutMs = 3000): Promise<NewsConfig | null> {
  const config = await fetchHubSecrets('config', timeoutMs);
  return config?.news || null;
}

async function resolveNaverCredentials(options: { timeoutMs?: number } = {}): Promise<{ clientId: string; clientSecret: string }> {
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

async function resolveGoogleBooksApiKey(options: { timeoutMs?: number } = {}): Promise<string> {
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

async function resolveData4LibraryKey(options: { timeoutMs?: number } = {}): Promise<string> {
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

async function resolveKakaoApiKey(options: { timeoutMs?: number } = {}): Promise<string> {
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

export = {
  loadSharedNewsConfig,
  loadLocalSecretsNewsConfig,
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
  resolveData4LibraryKey,
  resolveKakaoApiKey,
};

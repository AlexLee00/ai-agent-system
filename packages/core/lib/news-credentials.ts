import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const { fetchHubSecrets } = require('./hub-client');

type NewsConfig = {
  naver_client_id?: string;
  naver_client_secret?: string;
  google_books_api_key?: string;
};

type ConfigRoot = {
  news?: NewsConfig;
};

const SHARED_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');

let sharedNewsConfigCache: NewsConfig | null = null;

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

async function fetchHubNewsConfig(timeoutMs = 3000): Promise<NewsConfig | null> {
  const config = await fetchHubSecrets('config', timeoutMs);
  return config?.news || null;
}

async function resolveNaverCredentials(options: { timeoutMs?: number } = {}): Promise<{ clientId: string; clientSecret: string }> {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();

  return {
    clientId:
      process.env.NAVER_CLIENT_ID ||
      process.env.NAVER_SEARCH_CLIENT_ID ||
      process.env.NAVER_OPENAPI_CLIENT_ID ||
      hubNews?.naver_client_id ||
      sharedNews.naver_client_id ||
      '',
    clientSecret:
      process.env.NAVER_CLIENT_SECRET ||
      process.env.NAVER_SEARCH_CLIENT_SECRET ||
      process.env.NAVER_OPENAPI_CLIENT_SECRET ||
      hubNews?.naver_client_secret ||
      sharedNews.naver_client_secret ||
      '',
  };
}

async function resolveGoogleBooksApiKey(options: { timeoutMs?: number } = {}): Promise<string> {
  const { timeoutMs = 3000 } = options;
  const hubNews = await fetchHubNewsConfig(timeoutMs);
  const sharedNews = loadSharedNewsConfig();

  return (
    process.env.GOOGLE_BOOKS_API_KEY ||
    hubNews?.google_books_api_key ||
    sharedNews.google_books_api_key ||
    ''
  );
}

export = {
  loadSharedNewsConfig,
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
};

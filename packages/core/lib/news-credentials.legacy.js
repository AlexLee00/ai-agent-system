'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { fetchHubSecrets } = require('./hub-client');

const SHARED_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');

let sharedNewsConfigCache = null;

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

async function fetchHubNewsConfig(timeoutMs = 3000) {
  const config = await fetchHubSecrets('config', timeoutMs);
  return config?.news || null;
}

async function resolveNaverCredentials(options = {}) {
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

async function resolveGoogleBooksApiKey(options = {}) {
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

module.exports = {
  loadSharedNewsConfig,
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
};

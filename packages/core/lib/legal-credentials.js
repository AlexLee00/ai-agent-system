'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');
const { fetchHubSecrets } = require('./hub-client');

const SECRETS_STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

let localJustinSecretsCache = null;

function loadLocalJustinSecrets() {
  if (localJustinSecretsCache) return localJustinSecretsCache;
  try {
    const store = JSON.parse(fs.readFileSync(SECRETS_STORE_PATH, 'utf8')) || {};
    localJustinSecretsCache = store.justin || {};
  } catch {
    localJustinSecretsCache = {};
  }
  return localJustinSecretsCache;
}

async function fetchHubJustinSecrets(timeoutMs = 3000) {
  const data = await fetchHubSecrets('justin', timeoutMs);
  return data || null;
}

async function resolveKoreaLawCredentials(options = {}) {
  const { timeoutMs = 3000 } = options;
  const hubJustin = await fetchHubJustinSecrets(timeoutMs);
  const localJustin = loadLocalJustinSecrets();
  const hubLaw = hubJustin?.korea_law || {};
  const localLaw = localJustin?.korea_law || localJustin?.korea_law_api || {};

  return {
    userId:
      process.env.JUSTIN_LAW_API_USER_ID ||
      hubLaw.user_id ||
      localLaw.user_id ||
      '',
    userName:
      process.env.JUSTIN_LAW_API_USER_NAME ||
      hubLaw.user_name ||
      localLaw.user_name ||
      '',
    oc:
      process.env.JUSTIN_LAW_API_OC ||
      hubLaw.oc ||
      localLaw.oc ||
      '',
    baseUrl:
      process.env.JUSTIN_LAW_API_BASE_URL ||
      hubLaw.base_url ||
      localLaw.base_url ||
      'https://www.law.go.kr',
  };
}

module.exports = {
  loadLocalJustinSecrets,
  fetchHubJustinSecrets,
  resolveKoreaLawCredentials,
};

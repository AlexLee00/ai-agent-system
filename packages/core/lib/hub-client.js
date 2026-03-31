'use strict';
/**
 * packages/core/lib/hub-client.js — Hub 시크릿 프록시 클라이언트
 *
 * 사용법:
 *   const { fetchHubSecrets } = require('./hub-client');
 *   const data = await fetchHubSecrets('llm');
 */

const env = require('./env');

async function fetchHubSecrets(category, timeoutMs = 3000) {
  if (!env.USE_HUB_SECRETS || !env.HUB_BASE_URL) return null;

  const url = `${env.HUB_BASE_URL}/hub/secrets/${category}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[hub-client] ${category}: HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    return json.data || null;
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] ${category}: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryOpsDb(sql, schema = 'investment', params = [], timeoutMs = 5000) {
  if (!env.HUB_BASE_URL) return null;

  const url = `${env.HUB_BASE_URL}/hub/pg/query`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, schema, params: Array.isArray(params) ? params : [] }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[hub-client] queryOpsDb: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] queryOpsDb: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpsErrors(minutes = 60, service = null, timeoutMs = 3000) {
  if (!env.HUB_BASE_URL) return null;

  let url = `${env.HUB_BASE_URL}/hub/errors/recent?minutes=${minutes}`;
  if (service) url += `&service=${encodeURIComponent(service)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[hub-client] fetchOpsErrors: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] fetchOpsErrors: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchHubSecrets,
  queryOpsDb,
  fetchOpsErrors,
};

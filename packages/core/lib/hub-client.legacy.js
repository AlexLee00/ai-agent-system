'use strict';
/**
 * packages/core/lib/hub-client.js — Hub 시크릿 프록시 클라이언트
 */

const env = require('./env');
const { execFileSync } = require('child_process');
const cache = new Map();
const warnCache = new Map();

function getCacheKey(kind, value) {
  return `${kind}:${value}`;
}

function getCached(cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return undefined;
  }
  return entry.value;
}

function setCached(cacheKey, value, ttlMs) {
  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function warnOnce(key, message, ttlMs = 30000) {
  const last = warnCache.get(key) || 0;
  if ((Date.now() - last) < ttlMs) return;
  warnCache.set(key, Date.now());
  console.warn(message);
}

function shouldUseCurlFallback(err, url) {
  const message = `${err?.message || ''} ${err?.cause?.message || ''}`.toLowerCase();
  return (
    (url.includes('localhost') || url.includes('127.0.0.1')) &&
    (message.includes('eperm') || message.includes('fetch failed') || message.includes('connect eperm'))
  );
}

function fetchJsonViaCurl(url, authToken, timeoutMs) {
  try {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const raw = execFileSync('/usr/bin/curl', [
      '-sS',
      '--max-time',
      String(seconds),
      '-H',
      `Authorization: Bearer ${authToken}`,
      '-H',
      'Content-Type: application/json',
      url,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readResponseReason(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      return String(json.reason || json.error || '').trim();
    } catch {
      return text.slice(0, 160).trim();
    }
  } catch {
    return '';
  }
}

async function fetchHubSecrets(category, timeoutMs = 3000) {
  if (!env.USE_HUB_SECRETS || !env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:secrets', '[hub-client] HUB_AUTH_TOKEN 없음 — hub secrets 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('secret', category);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

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
      warnOnce(`hub-secrets:${category}:${res.status}`, `[hub-client] ${category}: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 5000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    const data = json.data || null;
    setCached(cacheKey, data, 10000);
    return data;
  } catch (err) {
    if (shouldUseCurlFallback(err, url)) {
      const json = fetchJsonViaCurl(url, env.HUB_AUTH_TOKEN, timeoutMs);
      if (json) {
        const data = json.data || null;
        setCached(cacheKey, data, 10000);
        return data;
      }
    }
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] ${category}: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryOpsDb(sql, schema = 'investment', params = [], timeoutMs = 5000) {
  if (!env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:query', '[hub-client] HUB_AUTH_TOKEN 없음 — queryOpsDb 생략');
    return null;
  }

  const cacheKey = getCacheKey('query', `${schema}:${sql}:${JSON.stringify(Array.isArray(params) ? params : [])}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

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
      const reason = await readResponseReason(res);
      const suffix = reason ? ` (${reason})` : '';
      warnOnce(`hub-query:${res.status}:${reason || 'unknown'}`, `[hub-client] queryOpsDb: HTTP ${res.status}${suffix}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    setCached(cacheKey, json, 3000);
    return json;
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
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:errors', '[hub-client] HUB_AUTH_TOKEN 없음 — fetchOpsErrors 생략');
    return null;
  }

  const cacheKey = getCacheKey('errors', `${minutes}:${service || '*'}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

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
      warnOnce(`hub-errors:${res.status}`, `[hub-client] fetchOpsErrors: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    setCached(cacheKey, json, 3000);
    return json;
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] fetchOpsErrors: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHubRuntimeProfile(team, purpose = 'default', timeoutMs = 3000) {
  if (!env.HUB_BASE_URL || !team) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:runtime', '[hub-client] HUB_AUTH_TOKEN 없음 — runtime profile 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('runtime', `${team}:${purpose}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${env.HUB_BASE_URL}/hub/runtime/select?team=${encodeURIComponent(team)}&purpose=${encodeURIComponent(purpose)}`;
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
      warnOnce(`hub-runtime:${team}:${purpose}:${res.status}`, `[hub-client] runtime ${team}/${purpose}: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    const data = json?.profile || null;
    setCached(cacheKey, data, 5000);
    return data;
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] runtime ${team}/${purpose}: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchHubSecrets,
  queryOpsDb,
  fetchOpsErrors,
  fetchHubRuntimeProfile,
};

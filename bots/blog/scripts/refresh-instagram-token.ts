// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  getInstagramTokenConfig,
  refreshLongLivedToken,
  exchangeToLongLivedToken,
  parseInstagramAuthError,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-token-manager.ts'));

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    mode: readOption(argv, '--mode') || 'auto',
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function normalizeExpiry(expiresInSeconds) {
  const seconds = Number(expiresInSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + (seconds * 1000)).toISOString();
}

async function runRefresh(mode = 'auto') {
  const attempts = mode === 'exchange'
    ? ['exchange']
    : mode === 'refresh'
      ? ['refresh']
      : ['refresh', 'exchange'];

  const failures = [];
  for (const attempt of attempts) {
    try {
      if (attempt === 'refresh') {
        const result = await refreshLongLivedToken(fetch, getInstagramTokenConfig());
        return { mode: 'refresh', ...result };
      }
      const result = await exchangeToLongLivedToken(fetch, getInstagramTokenConfig());
      return { mode: 'exchange', ...result };
    } catch (error) {
      const diagnosis = parseInstagramAuthError(error);
      failures.push({
        mode: attempt,
        error: error?.message || String(error),
        diagnosis,
      });
    }
  }
  const detail = failures.map((item) => ({
    mode: item.mode,
    error: item.error,
    diagnosis: item.diagnosis,
  }));
  /** @type {any} */
  const error = new Error(`Instagram 토큰 갱신 실패`);
  error.details = detail;
  throw error;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRefresh(args.mode);
  const nextToken = String(result.response?.access_token || '').trim();
  const nextExpiry = normalizeExpiry(result.response?.expires_in);

  const current = loadStore();
  const nextStore = {
    ...current,
    instagram: {
      ...(current.instagram || {}),
      ...(nextToken ? { access_token: nextToken } : {}),
      ...(nextExpiry ? { token_expires_at: nextExpiry } : {}),
    },
  };

  if (!args.dryRun) {
    saveStore(nextStore);
  }

  const payload = {
    dryRun: args.dryRun,
    mode: result.mode,
    saved: !args.dryRun,
    tokenUpdated: Boolean(nextToken),
    tokenExpiresAt: nextExpiry,
    expiresInSeconds: Number(result.response?.expires_in || 0) || null,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 토큰] mode=${payload.mode} ${payload.saved ? 'saved' : 'dry-run'}`);
  console.log(`[인스타 토큰] token=${payload.tokenUpdated ? 'updated' : 'unchanged'} expiresAt=${payload.tokenExpiresAt || 'unknown'}`);
}

main().catch((error) => {
  const details = Array.isArray(error?.details) ? error.details : [];
  if (details.length > 0) {
    console.error('[인스타 토큰] 갱신 실패:');
    for (const item of details) {
      console.error(`- ${item.mode}: ${item.diagnosis?.code || 'unknown'} | ${item.diagnosis?.note || item.error}`);
    }
  } else {
    console.error('[인스타 토큰] 갱신 실패:', error?.message || error);
  }
  process.exit(1);
});

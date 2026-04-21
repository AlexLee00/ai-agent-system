// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const {
  getInstagramTokenConfig,
  refreshLongLivedToken,
  exchangeToLongLivedToken,
  debugToken,
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

function normalizeTimestamp(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

async function resolveTokenExpiry(result, nextToken) {
  const directExpiry = normalizeExpiry(result?.response?.expires_in);
  if (directExpiry) return directExpiry;
  if (!nextToken) return null;
  try {
    const debug = await debugToken(fetch, {
      ...getInstagramTokenConfig(),
      accessToken: nextToken,
    }, nextToken);
    const data = debug?.response?.data || {};
    return (
      normalizeTimestamp(data.expires_at)
      || normalizeTimestamp(data.data_access_expires_at)
      || null
    );
  } catch {
    return null;
  }
}

function buildInstagramTokenFallback(payload = {}) {
  if (!payload.saved && payload.dryRun) {
    return '인스타 토큰 갱신을 dry-run으로 점검했으며, 실제 저장 전 만료 시각만 확인하면 됩니다.';
  }
  if (payload.tokenUpdated) {
    return `인스타 토큰이 ${payload.mode} 경로로 갱신되어, 다음 만료 시각까지 운영을 이어갈 수 있습니다.`;
  }
  return '인스타 토큰 변경은 없지만, 현재 만료 시각과 저장 상태를 계속 확인하는 편이 좋습니다.';
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
  const nextExpiry = await resolveTokenExpiry(result, nextToken);

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
    ok: Boolean(nextToken),
    dryRun: args.dryRun,
    mode: result.mode,
    saved: !args.dryRun,
    tokenUpdated: Boolean(nextToken),
    tokenExpiresAt: nextExpiry,
    newExpiresAt: nextExpiry,
    expiresInSeconds: Number(result.response?.expires_in || 0) || null,
  };
  payload.aiSummary = await buildBlogCliInsight({
    bot: 'instagram-token-refresh',
    requestType: 'instagram-token-refresh',
    title: '인스타그램 토큰 갱신',
    data: payload,
    fallback: buildInstagramTokenFallback(payload),
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 토큰] mode=${payload.mode} ${payload.saved ? 'saved' : 'dry-run'}`);
  console.log(`[인스타 토큰] token=${payload.tokenUpdated ? 'updated' : 'unchanged'} expiresAt=${payload.tokenExpiresAt || 'unknown'}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
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

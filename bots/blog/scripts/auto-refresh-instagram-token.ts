// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const {
  writeInstagramTokenAutoRefreshResult,
  AUTO_REFRESH_SCHEDULE_TEXT,
} = require('../lib/instagram-token-automation.ts');
const {
  getInstagramTokenConfig,
  getTokenHealth,
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
    force: argv.includes('--force'),
  };
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
  return new Date(Date.now() + seconds * 1000).toISOString();
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

function chooseMode(health, force = false) {
  if (force) {
    if (!health.tokenExpiresAt) return 'exchange';
    return health.needsRefresh ? 'refresh' : 'refresh';
  }
  if (!health.hasAccessToken) return 'noop';
  if (!health.tokenExpiresAt) return 'exchange';
  if (health.needsRefresh || health.critical) return 'refresh';
  return 'noop';
}

function buildFallback(payload = {}) {
  if (payload.mode === 'noop') {
    return '인스타 장기 토큰은 아직 갱신 구간이 아니라 현재 만료 시각만 유지하면 됩니다.';
  }
  if (payload.ok) {
    return `인스타 장기 토큰 자동 ${payload.mode}가 성공해 다음 만료 시각까지 운영을 이어갈 수 있습니다.`;
  }
  return '인스타 장기 토큰 자동 갱신이 실패해 허브 access_token 상태를 먼저 다시 확인해야 합니다.';
}

function persistResult(payload = {}) {
  writeInstagramTokenAutoRefreshResult({
    ...payload,
    checkedAt: new Date().toISOString(),
    schedule: AUTO_REFRESH_SCHEDULE_TEXT,
  });
}

async function maybeAlertFailure(payload, error) {
  const diagnosis = parseInstagramAuthError(error);
  await publishToWebhook({
    event: {
      from_bot: 'blog-instagram-token-auto-refresh',
      team: 'blog',
      event_type: 'instagram_token_auto_refresh_failed',
      alert_level: 3,
      message: `인스타 장기 토큰 자동 갱신 실패\nmode: ${payload.mode}\nreason: ${diagnosis.note}`,
      payload: {
        ...payload,
        diagnosis,
        error: error?.message || String(error),
      },
    },
  }).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getInstagramTokenConfig();
  const health = getTokenHealth(config);
  const mode = chooseMode(health, args.force);

  if (mode === 'noop') {
    const payload = {
      ok: true,
      dryRun: args.dryRun,
      mode,
      saved: false,
      tokenUpdated: false,
      tokenExpiresAt: health.tokenExpiresAt || null,
      daysLeft: health.daysLeft ?? null,
      reason: health.hasAccessToken
        ? '장기 토큰 만료가 아직 충분히 남아 있어 자동 갱신을 건너뜁니다.'
        : 'access_token이 없어 자동 갱신을 진행할 수 없습니다.',
    };
    payload.aiSummary = await buildBlogCliInsight({
      bot: 'instagram-token-auto-refresh',
      requestType: 'instagram-token-auto-refresh',
      title: '인스타그램 토큰 자동 갱신',
      data: payload,
      fallback: buildFallback(payload),
    });
    if (!args.dryRun) persistResult(payload);
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`[인스타 토큰 자동] mode=noop expiresAt=${payload.tokenExpiresAt || 'unknown'}`);
    console.log(`🔍 AI: ${payload.aiSummary}`);
    return;
  }

  const attempts = mode === 'exchange' ? ['exchange'] : ['refresh', 'exchange'];
  let result = null;
  let usedMode = mode;
  let lastError = null;

  for (const attempt of attempts) {
    try {
      usedMode = attempt;
      result = attempt === 'refresh'
        ? await refreshLongLivedToken(fetch, getInstagramTokenConfig())
        : await exchangeToLongLivedToken(fetch, getInstagramTokenConfig());
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!result) {
    const failedPayload = {
      ok: false,
      dryRun: args.dryRun,
      mode: usedMode,
      saved: false,
      tokenUpdated: false,
      tokenExpiresAt: health.tokenExpiresAt || null,
      daysLeft: health.daysLeft ?? null,
      reason: '인스타 장기 토큰 자동 갱신에 실패했습니다.',
    };
    failedPayload.aiSummary = await buildBlogCliInsight({
      bot: 'instagram-token-auto-refresh',
      requestType: 'instagram-token-auto-refresh',
      title: '인스타그램 토큰 자동 갱신 실패',
      data: failedPayload,
      fallback: buildFallback(failedPayload),
    });
    if (!args.dryRun) persistResult(failedPayload);
    if (!args.dryRun) {
      await maybeAlertFailure(failedPayload, lastError);
    }
    throw lastError;
  }

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
    mode: usedMode,
    saved: !args.dryRun,
    tokenUpdated: Boolean(nextToken),
    tokenExpiresAt: nextExpiry,
    daysLeft: nextExpiry ? Math.floor((new Date(nextExpiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null,
    reason: usedMode === 'exchange'
      ? '만료 정보가 없거나 refresh 대체 경로가 필요해 exchange를 사용했습니다.'
      : '만료 임박 구간이라 refresh를 우선 시도했습니다.',
  };
  payload.aiSummary = await buildBlogCliInsight({
    bot: 'instagram-token-auto-refresh',
    requestType: 'instagram-token-auto-refresh',
    title: '인스타그램 토큰 자동 갱신',
    data: payload,
    fallback: buildFallback(payload),
  });
  if (!args.dryRun) persistResult(payload);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 토큰 자동] mode=${payload.mode} ${payload.saved ? 'saved' : 'dry-run'}`);
  console.log(`[인스타 토큰 자동] token=${payload.tokenUpdated ? 'updated' : 'unchanged'} expiresAt=${payload.tokenExpiresAt || 'unknown'}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
}

main().catch((error) => {
  console.error('[인스타 토큰 자동] 실패:', error?.message || error);
  process.exit(1);
});

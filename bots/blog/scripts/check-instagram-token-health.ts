'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  getInstagramTokenConfig,
  getTokenHealth,
  buildExchangeTokenRequest,
  buildRefreshLongLivedTokenRequest,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-token-manager.ts'));

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function maskValue(value = '') {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redactUrl(url = '') {
  if (!url) return '';
  const parsed = new URL(url);
  for (const key of ['access_token', 'client_secret']) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, maskValue(parsed.searchParams.get(key) || ''));
    }
  }
  return parsed.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getInstagramTokenConfig();
  const health = getTokenHealth(config);
  const exchangeRequest = health.readyForExchange ? buildExchangeTokenRequest(config) : null;
  const refreshRequest = health.readyForRefresh ? buildRefreshLongLivedTokenRequest(config) : null;

  const payload = {
    ready: Boolean(health.hasAccessToken && health.hasIgUserId),
    health,
    requests: {
      exchange: exchangeRequest ? { ...exchangeRequest, url: redactUrl(exchangeRequest.url) } : null,
      refresh: refreshRequest ? { ...refreshRequest, url: redactUrl(refreshRequest.url) } : null,
    },
    note: '장기 토큰은 만료 14일 전 갱신, 3일 전 CRITICAL 알림 기준으로 운영하는 것을 권장합니다.',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 토큰] ready=${payload.ready ? 'yes' : 'no'}`);
  console.log(`[인스타 토큰] expiresAt=${payload.health.tokenExpiresAt || 'unknown'} daysLeft=${payload.health.daysLeft ?? 'n/a'}`);
  console.log(`[인스타 토큰] refresh=${payload.health.needsRefresh ? 'needed' : 'not-yet'} critical=${payload.health.critical ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error('[인스타 토큰] 실패:', error?.message || error);
  process.exit(1);
});

#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveAlphaVantageApiKey,
  resolveDartApiKey,
  resolveData4LibraryKey,
  resolveKakaoApiKey,
  resolveNaverCredentials,
} = require('../../../packages/core/lib/news-credentials.legacy.js');

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function redactedPresence(value: unknown) {
  const normalized = String(value || '');
  return {
    present: normalized.length > 0,
    length: normalized.length,
  };
}

async function main() {
  const timeoutMs = Number(process.env.LUNA_NEWS_CREDENTIAL_SMOKE_TIMEOUT_MS || 3000);
  const [
    naver,
    data4Library,
    kakao,
    dart,
    alphaVantage,
  ] = await Promise.all([
    resolveNaverCredentials({ timeoutMs }),
    resolveData4LibraryKey({ timeoutMs }),
    resolveKakaoApiKey({ timeoutMs }),
    resolveDartApiKey({ timeoutMs }),
    resolveAlphaVantageApiKey({ timeoutMs }),
  ]);

  assert.equal(typeof naver.clientId, 'string');
  assert.equal(typeof naver.clientSecret, 'string');
  assert.equal(typeof data4Library, 'string');
  assert.equal(typeof kakao, 'string');
  assert.equal(typeof dart, 'string');
  assert.equal(typeof alphaVantage, 'string');

  const payload = {
    ok: true,
    timeoutMs,
    credentials: {
      naverClientId: redactedPresence(naver.clientId),
      naverClientSecret: redactedPresence(naver.clientSecret),
      data4Library: redactedPresence(data4Library),
      kakao: redactedPresence(kakao),
      cryptoPanic: {
        present: false,
        length: 0,
        retired: true,
        reason: 'retired_paid_source',
      },
      dart: redactedPresence(dart),
      alphaVantage: redactedPresence(alphaVantage),
    },
  };

  if (hasFlag('json')) console.log(JSON.stringify(payload, null, 2));
  else console.log(`[luna-news-credential-resolver-smoke] ok naver=${payload.credentials.naverClientId.present}/${payload.credentials.naverClientSecret.present}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});

#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getTossCredentials, hasTossCredentials, initHubSecrets, maskSecret } from '../shared/secrets.ts';
import { __test, getPrice, tossCapability } from '../shared/brokers/toss-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(INVESTMENT_ROOT, '..', '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readRepoFile(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function assertNoExecutionSurface(clientText) {
  for (const forbidden of ['placeOrder', 'amendOrder', 'cancelOrder', 'createOrder', 'modifyOrder', '/api/v1/orders']) {
    assert.equal(clientText.includes(forbidden), false, `toss-client must not contain execution surface: ${forbidden}`);
  }
}

function assertNoHardcodedSecrets(text, label) {
  assert.equal(/c_[A-Za-z0-9]{12,}/.test(text), false, `${label} must not contain Toss client id literal`);
  assert.equal(/s_[A-Za-z0-9]{12,}/.test(text), false, `${label} must not contain Toss client secret literal`);
  assert.equal(/eyJ[a-zA-Z0-9_-]{20,}/.test(text), false, `${label} must not contain JWT/access token literal`);
}

async function testTokenCaching() {
  let tokenRequests = 0;
  const client = __test.createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
    }),
    sleepFn: async () => {},
    fetchFn: async (url, options) => {
      if (String(url).endsWith('/oauth2/token')) {
        tokenRequests += 1;
        const body = options?.body;
        assert.equal(body.get('grant_type'), 'client_credentials');
        assert.equal(body.get('client_id'), 'test_api_key');
        assert.equal(body.get('client_secret'), 'test_secret_key');
        return new Response(JSON.stringify({
          access_token: 'test_token_value',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const first = await client.getTossToken();
  const second = await client.getTossToken();
  assert.equal(first.accessToken, 'test_token_value');
  assert.equal(second.cached, true);
  assert.equal(tokenRequests, 1, 'token cache should avoid duplicate token issuance');
}

async function testMissingCredentials() {
  const client = __test.createTossClient({
    credentialsProvider: async () => ({
      apiKey: '',
      secretKey: '',
      mode: 'shadow',
      liveTrading: false,
    }),
  });
  await assert.rejects(() => client.getTossToken(), /토스 키 미설정/);
}

async function testRetryAfter() {
  let calls = 0;
  const client = __test.createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
    }),
    sleepFn: async () => {},
    fetchFn: async (url) => {
      if (String(url).endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: 'test_token_value',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate-limit-exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({
        result: [{ symbol: '005930', lastPrice: '72000', currency: 'KRW', timestamp: '2026-03-25T09:30:00+09:00' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const quote = await client.getPrice('005930');
  assert.equal(quote.symbol, '005930');
  assert.equal(quote.price, 72000);
  assert.equal(calls, 2, '429 should be retried once');
}

async function maybeLiveReadCheck() {
  await initHubSecrets();
  if (!hasTossCredentials()) {
    return { attempted: false, skipped: 'toss_credentials_missing' };
  }
  const quote = await getPrice(process.env.TOSS_SMOKE_SYMBOL || '005930');
  return {
    attempted: true,
    ok: Number(quote?.price || 0) > 0,
    symbol: quote?.symbol || null,
    pricePresent: Number(quote?.price || 0) > 0,
  };
}

export async function runTossClientSmoke() {
  const clientText = readRepoFile('bots/investment/shared/brokers/toss-client.ts');
  const secretsText = readRepoFile('bots/investment/shared/secrets.ts');
  const doctorText = readRepoFile('bots/investment/scripts/toss-secret-doctor.ts');
  const exampleText = readRepoFile('bots/investment/secrets.example.json');

  assert.equal(tossCapability.canTrade, false, 'Toss capability must be read-only');
  assert.deepEqual(tossCapability.markets, ['domestic', 'overseas']);
  assertNoExecutionSurface(clientText);
  assertNoHardcodedSecrets(clientText, 'toss-client');
  assertNoHardcodedSecrets(doctorText, 'toss-secret-doctor');
  assert.ok(secretsText.includes("toss_mode:            normalizeTossMode(c.toss?.mode)"));
  assert.ok(secretsText.includes("toss_live_trading:    c.toss?.live_trading === true"));
  assert.ok(exampleText.includes('"toss_mode":                 "shadow"'));
  assert.ok(exampleText.includes('"toss_live_trading":         false'));
  assert.ok(exampleText.includes('accountSeq로 자동 환원'));
  assert.ok(doctorText.includes('X-Tossinvest-Account 헤더에는 accountSeq'));
  assert.ok(clientText.includes('toss_buying_power_invalid_request'));
  assert.equal(maskSecret('abcdef'), 'ab***ef');
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret(''), '');

  await testTokenCaching();
  await testMissingCredentials();
  await testRetryAfter();

  const credentials = getTossCredentials();
  const liveCheck = await maybeLiveReadCheck();
  if (liveCheck.attempted) assert.equal(liveCheck.ok, true, 'Toss live read check should return a price');

  return {
    ok: true,
    smoke: 'toss-client',
    scenarios: {
      hardcodedSecretsAbsent: true,
      canTradeFalse: true,
      executionSurfaceAbsent: true,
      maskSecretRedacts: true,
      defaultShadowInSource: true,
      tokenCaching: true,
      missingCredentialsError: true,
      retryAfter429: true,
      conditionalLiveRead: liveCheck,
      resolvedMode: credentials.mode,
      resolvedLiveTrading: credentials.liveTrading,
    },
  };
}

async function main() {
  const result = await runTossClientSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[toss-client-smoke] ok live_read=${result.scenarios.conditionalLiveRead.attempted ? 'attempted' : 'skipped'}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'toss-client-smoke error:' });
}

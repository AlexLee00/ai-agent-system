#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callMarketdataTool, MARKETDATA_MCP_TOOLS } from '../mcp/luna-marketdata-mcp/src/server.ts';
import { createBrokerRouter, selectBroker } from '../shared/brokers/broker-router.ts';
import { createKisBrokerAdapter } from '../shared/brokers/kis-adapter.ts';
import { createTossBrokerAdapter } from '../shared/brokers/toss-adapter.ts';
import { assertExecutable } from '../shared/brokers/broker-adapter.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
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

function assertNoHardcodedSecrets(text, label) {
  assert.equal(/c_[A-Za-z0-9]{12,}/.test(text), false, `${label} must not contain Toss client id literal`);
  assert.equal(/s_[A-Za-z0-9]{12,}/.test(text), false, `${label} must not contain Toss client secret literal`);
  assert.equal(/eyJ[a-zA-Z0-9_-]{20,}/.test(text), false, `${label} must not contain token literal`);
}

function makeFakeTossClient({ failQuote = false, failCandles = false } = {}) {
  return {
    async getPrice(symbol) {
      if (failQuote) throw new Error('fixture_toss_quote_failed');
      return { provider: 'toss', symbol, market: 'domestic', price: 72000, currency: 'KRW', timestamp: '2026-06-17T09:00:00+09:00' };
    },
    async getCandles(symbol) {
      if (failCandles) throw new Error('fixture_toss_candles_failed');
      return { provider: 'toss', symbol, candles: [{ symbol, timestamp: '2026-06-16', open: 70000, high: 73000, low: 69000, close: 72000, volume: 1000 }] };
    },
    async getSecuritiesWarning(symbol) {
      return [{ symbol, warningType: 'none' }];
    },
    async getMarketCalendar(market) {
      return { provider: 'toss', market, today: '2026-06-17' };
    },
    async getExchangeRate() {
      return { provider: 'toss', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: 1380 };
    },
  };
}

function makeFakeKisClient() {
  return {
    async getDomesticQuoteSnapshot(symbol) {
      return { symbol, price: 71000, volume: 900 };
    },
    async getOverseasQuoteSnapshot(symbol) {
      return { symbol, price: 190, volume: 800 };
    },
    async getDomesticDailyPriceBars() {
      return [{ date: '20260616', open: 70000, high: 72000, low: 69000, close: 71000, volume: 900 }];
    },
    async getOverseasDailyPriceBars() {
      return [{ date: '20260616', open: 188, high: 191, low: 187, close: 190, volume: 800 }];
    },
    async getDomesticBalance() {
      return { ok: true, holdings: [] };
    },
    async getOverseasBalance() {
      return { ok: true, holdings: [] };
    },
  };
}

async function runBrokerScenarios() {
  const tossAdapter = createTossBrokerAdapter({ client: makeFakeTossClient() });
  const kisAdapter = createKisBrokerAdapter({ kisClient: makeFakeKisClient() });
  const router = createBrokerRouter({ tossAdapter, kisAdapter });

  assert.equal(tossAdapter.capabilities.name, 'toss');
  assert.equal(tossAdapter.capabilities.canTrade, false);
  assert.equal(kisAdapter.capabilities.name, 'kis');
  assert.equal(kisAdapter.capabilities.canTrade, false);

  assert.equal(selectBroker({ horizon: 'short', market: 'domestic' }).broker, 'kis');
  assert.equal(selectBroker({ horizon: 'mid_long', market: 'overseas' }).broker, 'toss');
  assert.equal(selectBroker({ horizon: 'unknown', market: 'domestic' }).broker, 'toss');

  await assert.rejects(() => tossAdapter.placeOrder({}), /broker_execution_disabled_shadow:toss/);
  assert.throws(() => assertExecutable(tossAdapter, { liveTrading: true, promotionApproved: true }), /broker_execution_disabled_shadow:toss/);

  const primaryQuote = await router.getDataAdapter('domestic').getQuote('005930', 'domestic');
  assert.equal(primaryQuote.provider, 'toss');
  assert.equal(primaryQuote.fallbackUsed, false);

  const fallbackRouter = createBrokerRouter({
    tossAdapter: createTossBrokerAdapter({ client: makeFakeTossClient({ failQuote: true }) }),
    kisAdapter,
  });
  const fallbackQuote = await fallbackRouter.getDataAdapter('domestic').getQuote('005930', 'domestic');
  assert.equal(fallbackQuote.provider, 'kis');
  assert.equal(fallbackQuote.fallbackUsed, true);

  const candles = await router.getDataAdapter('domestic').getCandles('005930', '1d', 5);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].provider, 'toss');

  return { primaryQuote, fallbackQuote, candles: candles.length };
}

async function runMcpScenarios() {
  assert.ok(MARKETDATA_MCP_TOOLS.some((tool) => tool.name === 'get_toss_price'));
  assert.ok(MARKETDATA_MCP_TOOLS.some((tool) => tool.name === 'get_toss_candles'));
  assert.ok(MARKETDATA_MCP_TOOLS.some((tool) => tool.name === 'get_toss_securities_warning'));
  assert.ok(MARKETDATA_MCP_TOOLS.some((tool) => tool.name === 'get_toss_calendar'));

  const missingCredentialResult = await callMarketdataTool('get_toss_price', { symbol: '005930', market: 'domestic' });
  assert.equal(missingCredentialResult.source, 'toss_openapi');
  assert.equal(missingCredentialResult.advisoryOnly, true);
  assert.ok('ok' in missingCredentialResult);
  return missingCredentialResult;
}

function runStaticSafetyScenarios() {
  const brokerAdapterText = readRepoFile('bots/investment/shared/brokers/broker-adapter.ts');
  const tossAdapterText = readRepoFile('bots/investment/shared/brokers/toss-adapter.ts');
  const kisAdapterText = readRepoFile('bots/investment/shared/brokers/kis-adapter.ts');
  const routerText = readRepoFile('bots/investment/shared/brokers/broker-router.ts');

  assertNoHardcodedSecrets(tossAdapterText, 'toss-adapter');
  assertNoHardcodedSecrets(kisAdapterText, 'kis-adapter');
  assertNoHardcodedSecrets(routerText, 'broker-router');
  assert.equal(tossAdapterText.includes('/api/v1/orders'), false, 'toss-adapter must not reference order endpoint');
  assert.equal(kisAdapterText.includes('marketBuy'), false, 'kis-adapter must not import KIS buy functions');
  assert.equal(kisAdapterText.includes('marketSell'), false, 'kis-adapter must not import KIS sell functions');
  assert.ok(brokerAdapterText.includes('broker_execution_disabled_shadow'));
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 33, 'registry seed count should be 33 after TOSS-B');
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'broker-abstraction'));
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'toss-data-source'));
}

export async function runTossBrokerSmoke() {
  runStaticSafetyScenarios();
  const broker = await runBrokerScenarios();
  const mcp = await runMcpScenarios();
  return {
    ok: true,
    smoke: 'toss-broker',
    scenarios: {
      capabilitiesReadOnly: true,
      horizonRouting: true,
      executionGuard: true,
      credentialMissingFailOpen: mcp.ok === false ? 'structured_failure' : 'live_or_fixture_success',
      kisFallback: broker.fallbackQuote.provider === 'kis',
      mcpToolsRegistered: true,
      registryCount: LUNA_COMPONENT_REGISTRY_SEED.length,
      staticSafety: true,
    },
  };
}

async function main() {
  const result = await runTossBrokerSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[toss-broker-smoke] ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'toss-broker-smoke error:' });
}

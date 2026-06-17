#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTossClient, resolveTossAccount } from '../shared/brokers/toss-client.ts';
import { createTossBrokerAdapter } from '../shared/brokers/toss-adapter.ts';
import { createBrokerRouter } from '../shared/brokers/broker-router.ts';
import { evaluateTossOrderPreflightHook } from '../shared/brokers/toss-order-preflight-hook.ts';
import { getTossPromotionStage } from '../shared/brokers/promotion-stage.ts';
import {
  buildTossBalanceShadowComparison,
  compareTossHoldingsWithPositions,
} from '../shared/luna-toss-balance-shadow.ts';
import { runTossPaperMirror } from '../shared/luna-toss-paper-mirror.ts';
import { createTossAccountSnapshotHandler } from '../a2a/skills/toss-account-snapshot.ts';
import { createTossPreflightVerifyHandler } from '../a2a/skills/toss-preflight-verify.ts';
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

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function accountHeaderScenario() {
  async function runHeaderCase(accountDomestic, expectAccountsLookup) {
    const calls = [];
    const client = createTossClient({
      credentialsProvider: async () => ({
        apiKey: 'test_api_key',
        secretKey: 'test_secret_key',
        mode: 'shadow',
        liveTrading: false,
        accountDomestic,
        accountOverseas: '',
      }),
      sleepFn: async () => {},
      fetchFn: async (url, init = {}) => {
        calls.push({ url: String(url), headers: init.headers || {}, method: init.method || 'GET' });
        if (String(url).endsWith('/oauth2/token')) {
          return response({ access_token: 'test_token', token_type: 'Bearer', expires_in: 3600 });
        }
        if (String(url).includes('/api/v1/accounts')) {
          return response({ result: [{ accountNo: '15801000654', accountSeq: 1, accountType: 'BROKERAGE' }] });
        }
        if (String(url).includes('/api/v1/holdings')) {
          return response({ result: { items: [] } });
        }
        if (String(url).includes('/api/v1/buying-power')) {
          return response({ result: { currency: 'KRW', cashBuyingPower: '5000000' } });
        }
        return response({ result: {} });
      },
    });
    const holdings = await client.getHoldings('domestic', { symbol: '005930' });
    const buyingPower = await client.getBuyingPower({ market: 'domestic' });
    const accountCalls = calls.filter((call) => call.url.includes('/api/v1/accounts'));
    const accountHeaderCalls = calls.filter((call) => (
      call.url.includes('/api/v1/holdings') || call.url.includes('/api/v1/buying-power')
    ));
    assert.equal(holdings.skipped, false);
    assert.equal(buyingPower.skipped, false);
    assert.equal(accountCalls.length, expectAccountsLookup ? 1 : 0);
    assert.ok(accountHeaderCalls.length >= 2);
    for (const call of accountHeaderCalls) {
      assert.equal(call.headers['X-Tossinvest-Account'], '1');
    }
    return { holdings, buyingPower, accountLookupCount: accountCalls.length };
  }

  const seqCase = await runHeaderCase('1', false);
  const colonCase = await runHeaderCase('15801000654:1', false);
  const accountNoCase = await runHeaderCase('15801000654', true);

  let networkCalls = 0;
  const missingAccountClient = createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
      accountDomestic: '',
      accountOverseas: '',
    }),
    fetchFn: async () => {
      networkCalls += 1;
      return response({});
    },
  });
  const skipped = await missingAccountClient.getBuyingPower({ market: 'domestic' });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.skippedReason, 'toss_account_required_domestic');
  assert.equal(networkCalls, 0);

  const noMatchCalls = [];
  const noMatchClient = createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
      accountDomestic: '99999999999',
      accountOverseas: '',
    }),
    fetchFn: async (url, init = {}) => {
      noMatchCalls.push({ url: String(url), headers: init.headers || {} });
      if (String(url).endsWith('/oauth2/token')) {
        return response({ access_token: 'test_token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (String(url).includes('/api/v1/accounts')) {
        return response({ result: [{ accountNo: '15801000654', accountSeq: 1, accountType: 'BROKERAGE' }] });
      }
      return response({ result: { items: [] } });
    },
  });
  const noMatch = await noMatchClient.getHoldings('domestic');
  assert.equal(noMatch.skipped, true);
  assert.equal(noMatch.skippedReason, 'toss_account_seq_resolution_failed_domestic');
  assert.equal(noMatchCalls.some((call) => call.url.includes('/api/v1/holdings')), false);

  const invalidBuyingPowerClient = createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
      accountDomestic: '1',
      accountOverseas: '',
    }),
    fetchFn: async (url, init = {}) => {
      if (String(url).endsWith('/oauth2/token')) {
        return response({ access_token: 'test_token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (String(url).includes('/api/v1/holdings')) {
        assert.equal(init.headers['X-Tossinvest-Account'], '1');
        return response({ result: { items: [] } });
      }
      if (String(url).includes('/api/v1/buying-power')) {
        assert.equal(init.headers['X-Tossinvest-Account'], '1');
        return response({ error: { code: 'invalid-request', message: '요청이 올바르지 않습니다.' } }, 400);
      }
      return response({ result: {} });
    },
  });
  const holdingsAfterInvalidBuyingPower = await invalidBuyingPowerClient.getHoldings('domestic');
  const invalidBuyingPower = await invalidBuyingPowerClient.getBuyingPower({ market: 'domestic' });
  assert.equal(holdingsAfterInvalidBuyingPower.skipped, false);
  assert.equal(invalidBuyingPower.skipped, true);
  assert.equal(invalidBuyingPower.skippedReason, 'toss_buying_power_invalid_request');

  const invalidHook = await evaluateTossOrderPreflightHook({ symbol: '005930', market: 'domestic', side: 'buy' }, {
    stageOptions: { stage: 's1_paper_mirror' },
  }, {
    adapter: {
      capabilities: { name: 'toss', canTrade: false },
      getBuyingPower: async () => invalidBuyingPower,
      getSellableQuantity: async () => ({ skipped: false }),
      getCommissions: async () => ({ skipped: false }),
    },
    getTossPromotionStage: () => ({ stage: 's1_paper_mirror', advisoryOnly: true, liveTrading: false, approved: false }),
  });
  const buyingPowerCheck = invalidHook.checks.find((item) => item.name === 'buying_power');
  assert.equal(buyingPowerCheck.skipped, true);
  assert.equal(buyingPowerCheck.reason, 'toss_buying_power_invalid_request');

  const resolved = resolveTossAccount({ market: 'domestic' }, { accountDomestic: '15801000654' }, [{ accountNo: '15801000654', accountSeq: 1 }]);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.account, '1');
  return { buyingPower: seqCase.buyingPower, skipped, seqCase, colonCase, accountNoCase, noMatch, invalidBuyingPower, invalidHook };
}

async function holdingsScenario() {
  let holdingsUrl = '';
  const client = createTossClient({
    credentialsProvider: async () => ({
      apiKey: 'test_api_key',
      secretKey: 'test_secret_key',
      mode: 'shadow',
      liveTrading: false,
      accountDomestic: '1',
      accountOverseas: '',
    }),
    sleepFn: async () => {},
    fetchFn: async (url) => {
      if (String(url).endsWith('/oauth2/token')) {
        return response({ access_token: 'test_token', token_type: 'Bearer', expires_in: 3600 });
      }
      holdingsUrl = String(url);
      return response({
        result: {
          items: [{
            symbol: '005930',
            name: '삼성전자',
            marketCountry: 'KR',
            currency: 'KRW',
            quantity: '3',
            lastPrice: '72000',
            averagePurchasePrice: '70000',
            marketValue: { amount: '216000' },
            profitLoss: { amount: '6000' },
          }],
        },
      });
    },
  });
  const holdings = await client.getHoldings('domestic', { symbol: '005930' });
  assert.ok(holdingsUrl.includes('/api/v1/holdings'));
  assert.equal(holdings.holdings.length, 1);
  assert.equal(holdings.holdings[0].symbol, '005930');
  assert.equal(holdings.holdings[0].quantity, 3);

  const comparison = compareTossHoldingsWithPositions({
    market: 'domestic',
    holdings,
    positions: [{ symbol: '005930', amount: 2, avg_price: 70000 }],
  });
  assert.equal(comparison.mismatchCount, 1);
  assert.equal(comparison.deltas[0].status, 'quantity_delta');

  const skippedComparison = await buildTossBalanceShadowComparison({}, {
    adapter: {
      getHoldings: async () => ({
        provider: 'toss',
        market: 'domestic',
        skipped: true,
        skippedReason: 'toss_account_required_domestic',
        holdings: [],
      }),
    },
    loadPositions: async () => [{ symbol: '005930', amount: 2, avg_price: 70000 }],
  });
  assert.equal(skippedComparison.holdingsSkipped, true);
  assert.equal(skippedComparison.mismatchCount, 0);
  assert.equal(skippedComparison.deltas.length, 0);

  const router = createBrokerRouter({
    tossAdapter: {
      capabilities: { name: 'toss', canTrade: false },
      getHoldings: async () => {
        throw new Error('fixture_toss_holdings_down');
      },
    },
    kisAdapter: {
      capabilities: { name: 'kis', canTrade: false },
      getHoldings: async () => ({ holdings: [{ symbol: '005930', quantity: 3 }] }),
    },
  });
  const fallbackHoldings = await router.getDataAdapter('domestic').getHoldings('domestic');
  assert.equal(fallbackHoldings.fallbackUsed, true);
  assert.equal(fallbackHoldings.fallbackReason, 'fixture_toss_holdings_down');

  return { holdings, comparison, fallbackHoldings, skippedComparison };
}

async function a2aScenario() {
  const adapter = {
    async getHoldings() {
      return { provider: 'toss', holdings: [{ symbol: '005930', quantity: 1, marketValue: 72000 }] };
    },
    async getBuyingPower() {
      return { provider: 'toss', type: 'buying_power', raw: { cashBuyingPower: '1000000' } };
    },
  };
  const snapshot = await createTossAccountSnapshotHandler({
    adapter,
    buildBalanceShadow: async () => ({ ok: true, mismatchCount: 0, deltas: [] }),
  })({ market: 'domestic' });
  assert.equal(snapshot.output.liveMutation, false);
  assert.equal(snapshot.output.placed, false);
  assert.equal(snapshot.output.summary.count, 1);

  const preflight = await createTossPreflightVerifyHandler({
    evaluateHook: async () => ({ ok: true, advisoryOnly: true, placed: false, liveMutation: false, checks: [] }),
  })({ symbol: '005930', market: 'domestic' });
  assert.equal(preflight.output.liveMutation, false);
  assert.equal(preflight.output.placed, false);
  return { snapshot: snapshot.output.summary, preflight: preflight.output.result };
}

async function stageHookAndMirrorScenario() {
  const s0 = getTossPromotionStage({}, { getTossCredentials: () => ({ mode: 'shadow', liveTrading: false }) });
  assert.equal(s0.stage, 's0_shadow');
  const downgraded = getTossPromotionStage({ stage: 's2_micro_live' }, { getTossCredentials: () => ({ liveTrading: false }) });
  assert.equal(downgraded.stage, 's0_shadow');
  assert.equal(downgraded.downgraded, true);

  const hook = await evaluateTossOrderPreflightHook({ symbol: '005930', market: 'domestic', side: 'buy' }, {
    stageOptions: { stage: 's1_paper_mirror' },
  }, {
    adapter: {
      capabilities: { name: 'toss', canTrade: false },
      getBuyingPower: async () => ({ skipped: false }),
      getSellableQuantity: async () => ({ skipped: false }),
      getCommissions: async () => ({ skipped: false }),
    },
    getTossPromotionStage: () => ({ stage: 's1_paper_mirror', advisoryOnly: true, liveTrading: false, approved: false }),
  });
  assert.equal(hook.placed, false);
  assert.equal(hook.liveMutation, false);
  assert.equal(hook.checks.length, 3);

  let insertCount = 0;
  const mirror = await runTossPaperMirror({
    apply: true,
    dryRun: false,
    confirm: 'luna-toss-paper-mirror-shadow',
    candidates: [{ id: 7, market: 'domestic', symbol: '005930', decision: 'pass', family: 'test' }],
  }, {
    getTossPromotionStage: () => ({ stage: 's1_paper_mirror', advisoryOnly: true, liveTrading: false, approved: false }),
    evaluateHook: async () => ({ ok: true, placed: false, liveMutation: false, checks: [] }),
    buildBalanceShadow: async () => ({ ok: true, mismatchCount: 0, deltas: [] }),
    insertLog: async () => {
      insertCount += 1;
      return [{ id: 99 }];
    },
  });
  assert.equal(mirror.placed, 0);
  assert.equal(mirror.written, 1);
  assert.equal(insertCount, 1);
  assert.equal(mirror.rows[0].placed, false);
  return { s0, downgraded, mirror };
}

function registryAndSafetyScenario() {
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.length >= 37);
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'promotion-stage'));
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'toss-paper-mirror'));

  const files = [
    'bots/investment/shared/brokers/toss-client.ts',
    'bots/investment/shared/brokers/toss-adapter.ts',
    'bots/investment/shared/brokers/toss-order-preflight-hook.ts',
    'bots/investment/shared/luna-toss-paper-mirror.ts',
    'bots/investment/shared/luna-toss-balance-shadow.ts',
    'bots/investment/a2a/skills/toss-account-snapshot.ts',
    'bots/investment/a2a/skills/toss-preflight-verify.ts',
  ];
  for (const file of files) {
    const text = readRepoFile(file);
    assert.equal(text.includes('/api/v1/orders'), false, `${file} must not reference Toss order endpoint`);
    assert.equal(text.includes('marketBuy'), false, `${file} must not import KIS buy functions`);
    assert.equal(text.includes('marketSell'), false, `${file} must not import KIS sell functions`);
  }
}

export async function runTossDSmoke() {
  const account = await accountHeaderScenario();
  const holdings = await holdingsScenario();
  const a2a = await a2aScenario();
  const stage = await stageHookAndMirrorScenario();
  registryAndSafetyScenario();
  return {
    ok: true,
    smoke: 'luna-toss-d',
    scenarios: {
      accountHeader: account.buyingPower.skipped === false,
      accountMissingSkip: account.skipped.skippedReason,
      holdings: holdings.holdings.holdings.length,
      balanceMismatch: holdings.comparison.mismatchCount,
      a2aSnapshotCount: a2a.snapshot.count,
      a2aPreflightPlaced: a2a.preflight.placed,
      defaultStage: stage.s0.stage,
      s2DowngradedTo: stage.downgraded.stage,
      paperMirrorPlaced: stage.mirror.placed,
      registryCount: LUNA_COMPONENT_REGISTRY_SEED.length,
      staticSafety: true,
    },
  };
}

async function main() {
  const result = await runTossDSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[luna-toss-d-smoke] ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-toss-d-smoke error:' });
}

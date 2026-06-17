#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTossSecuritiesWarning } from '../mcp/luna-marketdata-mcp/src/tools/toss-securities-warning.ts';
import { __test as tossClientTest } from '../shared/brokers/toss-client.ts';
import {
  evaluateEntryPreflight,
  evaluateEntryPreflightsForSignals,
} from '../shared/luna-entry-preflight-gate.ts';
import { evaluateSecuritiesWarningGate } from '../shared/luna-securities-warning-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(INVESTMENT_ROOT, '..', '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function bars(count = 25) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 20_000_000,
  }));
}

function entrySignal(overrides = {}) {
  return {
    id: 101,
    market: 'domestic',
    symbol: '005930',
    family: 'turtle_breakout',
    signalType: 'entry',
    candleTs: '2026-06-16T00:00:00.000Z',
    price: 100,
    stop: 90,
    target: 125,
    rr: 2.5,
    regime: { dominant: 'bull', probabilities: { sideways: 0.2 } },
    ...overrides,
  };
}

function readRepoFile(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

async function clientUniverseScenario() {
  let warningCalls = 0;
  const client = tossClientTest.createTossClient({
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
          access_token: 'test_token',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      warningCalls += 1;
      if (String(url).includes('/BAD/warnings')) {
        return new Response(JSON.stringify({ error: { code: 'fixture_error' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        result: String(url).includes('/005930/warnings')
          ? [{ warningType: 'INVESTMENT_WARNING', exchange: 'KRX' }]
          : [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await assert.rejects(() => client.getSecuritiesWarning(), /symbol_required/);
  const rows = await client.getSecuritiesWarningsForUniverse(['005930', 'BAD'], { concurrency: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.symbol === '005930')?.warned, true);
  assert.equal(rows.find((row) => row.symbol === 'BAD')?.warned, false);
  assert.ok(rows.find((row) => row.symbol === 'BAD')?.error);
  assert.equal(warningCalls, 2);
  return rows;
}

async function mcpSymbolRequiredScenario() {
  const result = await getTossSecuritiesWarning({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'symbol_required');
  assert.equal(result.advisoryOnly, true);
  return result;
}

async function preflightWarningScenario() {
  const signal = entrySignal();
  const warningGate = await evaluateSecuritiesWarningGate(signal, {}, {
    getSecuritiesWarning: async () => [{ warningType: 'INVESTMENT_WARNING' }],
  });
  assert.equal(warningGate.status, 'block');
  assert.equal(warningGate.reason, 'securities_warning_present');

  const evaluations = await evaluateEntryPreflightsForSignals([signal], {
    bars: bars(),
    historicalSignals: [],
    now: '2026-06-17T00:00:00.000Z',
  }, {
    getSecuritiesWarning: async () => [{ warningType: 'INVESTMENT_WARNING' }],
    getTossCredentials: () => ({ accountDomestic: '', accountOverseas: '' }),
  });
  assert.equal(evaluations.length, 1, 'warning gate must not remove the original entry signal from shadow evaluation');
  assert.equal(evaluations[0].decision, 'block');
  assert.ok(evaluations[0].gates.some((gate) => gate.name === 'G-securities-warning' && gate.status === 'block'));
  return evaluations[0];
}

async function crossCheckScenarios() {
  const noAccount = await evaluateEntryPreflight(entrySignal(), {
    bars: bars(),
    historicalSignals: [],
    now: '2026-06-17T00:00:00.000Z',
  }, {
    getSecuritiesWarning: async () => [],
    getTossCredentials: () => ({ accountDomestic: '', accountOverseas: '' }),
  });
  const skipped = noAccount.gates.find((gate) => gate.name === 'G-toss-cross-check');
  assert.equal(skipped.reason, 'toss_cross_check_skipped_no_account');

  const withAccount = await evaluateEntryPreflight(entrySignal(), {
    bars: bars(),
    historicalSignals: [],
    now: '2026-06-17T00:00:00.000Z',
  }, {
    getSecuritiesWarning: async () => [],
    getTossCredentials: () => ({ accountDomestic: 1, accountOverseas: '' }),
    tossCrossCheckFn: async () => ({
      matched: true,
      buyingPower: { raw: { amount: 1_000_000 } },
      sellableQuantity: { raw: { quantity: 0 } },
      commissions: { raw: { commissionRate: 0 } },
    }),
  });
  const recorded = withAccount.gates.find((gate) => gate.name === 'G-toss-cross-check');
  assert.equal(recorded.status, 'pass');
  assert.equal(recorded.details.matched, true);
  return { skipped, recorded };
}

function feeModelScenario() {
  const code = `
import importlib.util, os, json
spec = importlib.util.spec_from_file_location("bt", "${resolve(INVESTMENT_ROOT, 'scripts/backtest-vectorbt.py')}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
off = mod.resolve_toss_fee_model("domestic", False)
on = mod.resolve_toss_fee_model("domestic", True)
overseas = mod.resolve_toss_fee_model("overseas", True)
stock_domestic = mod.stock_market_calendar("005930")
stock_domestic_suffix = mod.stock_market_calendar("005930.KS")
stock_overseas = mod.stock_market_calendar("AAPL")
os.environ["LUNA_BT_TOSS_DOMESTIC_FEE_PCT"] = "0.00015"
override = mod.resolve_toss_fee_model("domestic", True)
print(json.dumps({"off": off, "on": on, "overseas": overseas, "override": override, "stockDomestic": stock_domestic, "stockDomesticSuffix": stock_domestic_suffix, "stockOverseas": stock_overseas}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }));
  assert.deepEqual(result.off, { fee_model: 'legacy', fee_pct: 0.001 });
  assert.deepEqual(result.on, { fee_model: 'toss_free', fee_pct: 0 });
  assert.deepEqual(result.overseas, { fee_model: 'legacy', fee_pct: 0.001 });
  assert.deepEqual(result.override, { fee_model: 'toss_free', fee_pct: 0.00015 });
  assert.equal(result.stockDomestic, 'domestic');
  assert.equal(result.stockDomesticSuffix, 'domestic');
  assert.equal(result.stockOverseas, 'overseas');
  return result;
}

function registryAndSafetyScenario() {
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 35);
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'securities-warning-gate'));
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'preflight-cross-check'));

  const files = [
    'bots/investment/shared/luna-securities-warning-gate.ts',
    'bots/investment/shared/brokers/toss-client.ts',
    'bots/investment/shared/brokers/toss-adapter.ts',
    'bots/investment/shared/luna-entry-preflight-gate.ts',
  ];
  for (const file of files) {
    const text = readRepoFile(file);
    assert.equal(text.includes('/api/v1/orders'), false, `${file} must not reference order endpoint`);
    assert.equal(text.includes('marketBuy'), false, `${file} must not import KIS buy functions`);
    assert.equal(text.includes('marketSell'), false, `${file} must not import KIS sell functions`);
  }
}

export async function runTossCSmoke() {
  const universe = await clientUniverseScenario();
  const mcp = await mcpSymbolRequiredScenario();
  const warning = await preflightWarningScenario();
  const crossCheck = await crossCheckScenarios();
  const feeModel = feeModelScenario();
  registryAndSafetyScenario();
  return {
    ok: true,
    smoke: 'luna-toss-c',
    scenarios: {
      symbolRequired: mcp.error,
      universeRows: universe.length,
      warningDecision: warning.decision,
      signalPreserved: true,
      crossCheckNoAccount: crossCheck.skipped.reason,
      crossCheckWithAccount: crossCheck.recorded.reason,
      feeModel,
      registryCount: LUNA_COMPONENT_REGISTRY_SEED.length,
      staticSafety: true,
    },
  };
}

async function main() {
  const result = await runTossCSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[luna-toss-c-smoke] ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-toss-c-smoke error:' });
}

#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { applyKisLocalSecrets } from './setup-kis-local-secrets.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8')) || {};
}

export async function runKisLocalConfigSmoke() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-local-config-'));
  const investmentDir = path.join(repoRoot, 'bots', 'investment');
  const hubDir = path.join(repoRoot, 'bots', 'hub');
  fs.mkdirSync(investmentDir, { recursive: true });
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(investmentDir, 'config.yaml'), 'trading_mode: live\nkis_mode: live\nkis:\n  symbols: []\n');
  fs.writeFileSync(path.join(hubDir, 'secrets-store.json'), JSON.stringify({ existing: true }, null, 2));

  const env = {
    KIS_APP_KEY: 'live-key-for-smoke',
    KIS_APP_SECRET: 'live-secret-for-smoke',
    KIS_ACCOUNT_NUMBER: '12345678-01',
    KIS_SYMBOLS: '005930,000660',
    KIS_OVERSEAS_SYMBOLS: 'AAPL,NVDA',
    KIS_PAPER_TRADING: 'false',
  };

  const result = applyKisLocalSecrets({ repoRoot, env, write: 'both', mode: 'live' });
  assert.equal(result.ok, true);
  assert.equal(result.outputs.investmentConfig.kis.app_key, true);
  assert.equal(result.outputs.investmentConfig.kis.app_secret, true);
  assert.equal(result.outputs.investmentConfig.kis.account_number, true);
  assert.equal(result.outputs.investmentConfig.kis.symbolsCount, 2);
  assert.equal(result.outputs.investmentConfig.kis.overseasSymbolsCount, 2);
  assert.equal(JSON.stringify(result).includes('live-secret-for-smoke'), false);

  const config = readYaml(path.join(investmentDir, 'config.yaml'));
  assert.equal(config.kis.app_key, env.KIS_APP_KEY);
  assert.equal(config.kis.app_secret, env.KIS_APP_SECRET);
  assert.equal(config.kis.account_number, env.KIS_ACCOUNT_NUMBER);
  assert.deepEqual(config.kis.symbols, ['005930', '000660']);
  assert.deepEqual(config.kis.overseas_symbols, ['AAPL', 'NVDA']);

  const store = readJson(path.join(hubDir, 'secrets-store.json'));
  assert.equal(store.existing, true);
  assert.equal(store.kis.app_key, env.KIS_APP_KEY);
  assert.equal(store.kis.app_secret, env.KIS_APP_SECRET);
  assert.equal(store.kis.account_number, env.KIS_ACCOUNT_NUMBER);

  fs.writeFileSync(path.join(investmentDir, 'config.yaml'), 'trading_mode: live\nkis_mode: live\nkis:\n  symbols: []\n');
  const hubSync = applyKisLocalSecrets({ repoRoot, write: 'investment', mode: 'live', source: 'hub-store' });
  assert.equal(hubSync.ok, true);
  assert.equal(hubSync.source, 'hub-store');
  const syncedConfig = readYaml(path.join(investmentDir, 'config.yaml'));
  assert.equal(syncedConfig.kis.app_key, env.KIS_APP_KEY);
  assert.equal(syncedConfig.kis.app_secret, env.KIS_APP_SECRET);
  assert.equal(syncedConfig.kis.account_number, env.KIS_ACCOUNT_NUMBER);

  const missing = applyKisLocalSecrets({ repoRoot, env: {}, write: 'both', mode: 'live' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'kis_env_missing');
  assert.deepEqual(missing.missing, ['KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ACCOUNT_NUMBER']);

  return {
    ok: true,
    repoRoot,
    configuredSummary: result.outputs.investmentConfig.kis,
    missingSummary: {
      ok: missing.ok,
      code: missing.code,
      missing: missing.missing,
    },
  };
}

async function main() {
  const result = await runKisLocalConfigSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('KIS local config smoke passed');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'KIS local config smoke failed:',
  });
}

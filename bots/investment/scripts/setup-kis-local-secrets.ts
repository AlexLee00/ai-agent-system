#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRED_LIVE = ['KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ACCOUNT_NUMBER'];
const REQUIRED_PAPER = ['KIS_PAPER_APP_KEY', 'KIS_PAPER_APP_SECRET', 'KIS_PAPER_ACCOUNT_NUMBER'];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readYaml(file, fallback = {}) {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) || fallback;
  } catch {
    return fallback;
  }
}

function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort local secret hardening
  }
}

function csv(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolFromEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on', 'live'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'paper'].includes(raw)) return false;
  return undefined;
}

export function buildKisPatchFromEnv(env = process.env) {
  const patch = {};
  const map = [
    ['KIS_APP_KEY', 'app_key'],
    ['KIS_APP_SECRET', 'app_secret'],
    ['KIS_ACCOUNT_NUMBER', 'account_number'],
    ['KIS_PAPER_APP_KEY', 'paper_app_key'],
    ['KIS_PAPER_APP_SECRET', 'paper_app_secret'],
    ['KIS_PAPER_ACCOUNT_NUMBER', 'paper_account_number'],
  ];
  for (const [envKey, field] of map) {
    const value = String(env[envKey] || '').trim();
    if (value) patch[field] = value;
  }
  const paperTrading = boolFromEnv(env.KIS_PAPER_TRADING);
  if (paperTrading !== undefined) patch.paper_trading = paperTrading;
  const symbols = csv(env.KIS_SYMBOLS);
  const overseasSymbols = csv(env.KIS_OVERSEAS_SYMBOLS);
  if (symbols.length > 0) patch.symbols = symbols;
  if (overseasSymbols.length > 0) patch.overseas_symbols = overseasSymbols;
  return patch;
}

export function buildKisPatchFromHubStore(repoRoot = DEFAULT_REPO_ROOT) {
  const storePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');
  const store = readJson(storePath, {});
  const source = store.kis || store.investment_accounts?.kis || store.config?.kis || {};
  return {
    ...(source || {}),
  };
}

function validatePatch(patch = {}, mode = 'live') {
  const missing = [];
  if (mode === 'live' || mode === 'both') {
    if (!patch.app_key) missing.push('KIS_APP_KEY');
    if (!patch.app_secret) missing.push('KIS_APP_SECRET');
    if (!patch.account_number) missing.push('KIS_ACCOUNT_NUMBER');
  }
  if (mode === 'paper' || mode === 'both') {
    if (!patch.paper_app_key) missing.push('KIS_PAPER_APP_KEY');
    if (!patch.paper_app_secret) missing.push('KIS_PAPER_APP_SECRET');
    if (!patch.paper_account_number) missing.push('KIS_PAPER_ACCOUNT_NUMBER');
  }
  return missing;
}

function summarizeKis(kis = {}) {
  return {
    app_key: Boolean(String(kis.app_key || '').trim()),
    app_secret: Boolean(String(kis.app_secret || '').trim()),
    account_number: Boolean(String(kis.account_number || '').trim()),
    paper_app_key: Boolean(String(kis.paper_app_key || '').trim()),
    paper_app_secret: Boolean(String(kis.paper_app_secret || '').trim()),
    paper_account_number: Boolean(String(kis.paper_account_number || '').trim()),
    paper_trading: typeof kis.paper_trading === 'boolean' ? kis.paper_trading : null,
    symbolsCount: Array.isArray(kis.symbols) ? kis.symbols.length : 0,
    overseasSymbolsCount: Array.isArray(kis.overseas_symbols) ? kis.overseas_symbols.length : 0,
  };
}

export function applyKisLocalSecrets({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  write = 'both',
  mode = 'live',
  source = 'env',
} = {}) {
  const patch = source === 'hub-store'
    ? buildKisPatchFromHubStore(repoRoot)
    : buildKisPatchFromEnv(env);
  if (mode === 'live') patch.paper_trading = false;
  if (mode === 'paper') patch.paper_trading = true;
  const missing = validatePatch(patch, mode);
  if (missing.length > 0) {
    return {
      ok: false,
      code: source === 'hub-store' ? 'kis_hub_store_missing' : 'kis_env_missing',
      missing,
      write,
      mode,
      source,
      message: source === 'hub-store'
        ? 'KIS values were not found in the local Hub secrets store.'
        : 'KIS secret values are intentionally not read from chat. Provide them through local env and rerun.',
    };
  }

  const outputs = {};
  if (write === 'both' || write === 'investment') {
    const configPath = path.join(repoRoot, 'bots', 'investment', 'config.yaml');
    const config = readYaml(configPath, {});
    config.kis = { ...(config.kis || {}), ...patch };
    writePrivateFile(configPath, `${yaml.dump(config, { lineWidth: 120, noRefs: true })}`);
    outputs.investmentConfig = {
      path: configPath,
      kis: summarizeKis(config.kis),
    };
  }

  if (write === 'both' || write === 'hub') {
    const storePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');
    const store = readJson(storePath, {});
    store.kis = { ...(store.kis || {}), ...patch };
    writePrivateFile(storePath, `${JSON.stringify(store, null, 2)}\n`);
    outputs.hubSecretsStore = {
      path: storePath,
      kis: summarizeKis(store.kis),
    };
  }

  return {
    ok: true,
    write,
    mode,
    source,
    outputs,
  };
}

export async function runSetupKisLocalSecrets() {
  const write = argValue('--write', 'both');
  const mode = hasFlag('--paper') ? 'paper' : hasFlag('--both-modes') ? 'both' : 'live';
  const repoRoot = argValue('--repo-root', DEFAULT_REPO_ROOT);
  const source = argValue('--source', 'env');
  return applyKisLocalSecrets({ repoRoot, write, mode, source });
}

async function main() {
  const result = await runSetupKisLocalSecrets();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) {
    console.error(`KIS setup blocked: ${result.code} (${(result.missing || []).join(', ')})`);
  } else {
    console.log('KIS local secrets configured');
  }
  if (!result.ok) process.exit(2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'KIS local secret setup failed:',
  });
}

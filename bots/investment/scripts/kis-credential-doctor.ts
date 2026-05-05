#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  getKisAccount,
  getKisAppKey,
  getKisAppSecret,
  hasKisCredentials,
  isKisPaper,
  loadSecrets,
} from '../shared/secrets.ts';
import { getDomesticQuoteSnapshot, getOverseasQuoteSnapshot } from '../shared/kis-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INVESTMENT_CONFIG = path.join(REPO_ROOT, 'bots', 'investment', 'config.yaml');
const HUB_SECRET_STORE = path.join(REPO_ROOT, 'bots', 'hub', 'secrets-store.json');
const LIVE_KEYS = ['KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ACCOUNT_NUMBER'];
const PAPER_KEYS = ['KIS_PAPER_APP_KEY', 'KIS_PAPER_APP_SECRET', 'KIS_PAPER_ACCOUNT_NUMBER'];

function hasFlag(name) {
  return process.argv.includes(name);
}

function readYaml(file, fallback = {}) {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) || fallback;
  } catch {
    return fallback;
  }
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function launchctlGetenv(key) {
  try {
    return String(execFileSync('launchctl', ['getenv', key], { encoding: 'utf8' }) || '').trim();
  } catch {
    return '';
  }
}

function maskAccount(account = {}) {
  const cano = String(account?.cano || '');
  const product = String(account?.acntPrdtCd || '');
  if (!cano) return '';
  const maskedCano = cano.length <= 4 ? '*'.repeat(cano.length) : `${cano.slice(0, 2)}${'*'.repeat(Math.max(2, cano.length - 4))}${cano.slice(-2)}`;
  return product ? `${maskedCano}-${product}` : maskedCano;
}

function summarizeSource(kis = {}) {
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

function summarizeEnv(keys, source = process.env) {
  return Object.fromEntries(keys.map((key) => [key, Boolean(String(source[key] || '').trim())]));
}

async function runQuoteCheck() {
  const checks = [];
  try {
    const domestic = await getDomesticQuoteSnapshot(process.env.KIS_DOCTOR_DOMESTIC_SYMBOL || '005930', isKisPaper());
    checks.push({
      market: 'kis_domestic',
      ok: Number(domestic?.price || 0) > 0,
      symbol: domestic?.symbol || process.env.KIS_DOCTOR_DOMESTIC_SYMBOL || '005930',
      pricePresent: Number(domestic?.price || 0) > 0,
    });
  } catch (error) {
    checks.push({
      market: 'kis_domestic',
      ok: false,
      error: error?.message || String(error),
    });
  }

  try {
    const overseas = await getOverseasQuoteSnapshot(process.env.KIS_DOCTOR_OVERSEAS_SYMBOL || 'AAPL');
    checks.push({
      market: 'kis_overseas',
      ok: Number(overseas?.price || 0) > 0,
      symbol: overseas?.symbol || process.env.KIS_DOCTOR_OVERSEAS_SYMBOL || 'AAPL',
      pricePresent: Number(overseas?.price || 0) > 0,
    });
  } catch (error) {
    checks.push({
      market: 'kis_overseas',
      ok: false,
      error: error?.message || String(error),
    });
  }

  return checks;
}

export async function buildKisCredentialDoctorReport({ liveCheck = false } = {}) {
  const config = readYaml(INVESTMENT_CONFIG, {});
  const store = readJson(HUB_SECRET_STORE, {});
  const hubKis = store.kis || store.investment_accounts?.kis || store.config?.kis || {};
  const secrets = loadSecrets();
  const account = getKisAccount();
  const resolved = {
    paper: isKisPaper(),
    appKeyPresent: Boolean(getKisAppKey()),
    appSecretPresent: Boolean(getKisAppSecret()),
    accountPresent: Boolean(account?.cano),
    accountMasked: maskAccount(account),
    hasKisCredentials: hasKisCredentials(),
    kisMode: secrets.kis_mode || 'inherit',
    tradingMode: secrets.trading_mode || 'paper',
    paperMode: secrets.paper_mode !== false,
  };

  const liveCheckResult = {
    requested: liveCheck,
    skipped: liveCheck && !resolved.hasKisCredentials ? 'kis_credentials_missing' : null,
    checks: [],
  };
  if (liveCheck && resolved.hasKisCredentials) {
    liveCheckResult.checks = await runQuoteCheck();
  }

  const ready = resolved.hasKisCredentials
    && resolved.accountPresent
    && (!liveCheck || liveCheckResult.checks.every((item) => item.ok));

  return {
    ok: ready,
    status: ready ? 'kis_ready' : 'kis_not_ready',
    sources: {
      investmentConfig: summarizeSource(config.kis || {}),
      hubSecretsStore: summarizeSource(hubKis),
      processEnv: summarizeEnv([...LIVE_KEYS, ...PAPER_KEYS]),
      launchctlEnv: summarizeEnv([...LIVE_KEYS, ...PAPER_KEYS], Object.fromEntries([...LIVE_KEYS, ...PAPER_KEYS].map((key) => [key, launchctlGetenv(key)]))),
    },
    resolved,
    liveCheck: liveCheckResult,
    nextActions: ready
      ? []
      : [
          'KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NUMBER를 로컬 env로 주입한 뒤 kis:setup을 실행하세요.',
          '절대 키/토큰을 채팅이나 tracked 파일에 붙여넣지 마세요.',
        ],
  };
}

async function main() {
  const result = await buildKisCredentialDoctorReport({ liveCheck: hasFlag('--live-check') });
  console.log(JSON.stringify(result, null, 2));
  if (hasFlag('--require-ready') && !result.ok) process.exit(2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'KIS credential doctor failed:',
  });
}

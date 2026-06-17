#!/usr/bin/env node
// @ts-nocheck

import { getTossCredentials, hasTossCredentials, initHubSecrets, maskSecret } from '../shared/secrets.ts';
import {
  getAccounts,
  getHoldings,
  getSecuritiesWarning,
  getTossToken,
  resolveTossAccount,
} from '../shared/brokers/toss-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function redactError(error) {
  const message = String(error?.message || error || '');
  const credentials = getTossCredentials();
  return message
    .replaceAll(credentials.apiKey || '__no_api_key__', maskSecret(credentials.apiKey))
    .replaceAll(credentials.secretKey || '__no_secret_key__', maskSecret(credentials.secretKey));
}

function credentialStatus() {
  const credentials = getTossCredentials();
  return {
    apiKeyPresent: Boolean(credentials.apiKey),
    secretKeyPresent: Boolean(credentials.secretKey),
    apiKeyFormatOk: String(credentials.apiKey || '').length >= 8,
    secretKeyFormatOk: String(credentials.secretKey || '').length >= 8,
    mode: credentials.mode,
    liveTrading: credentials.liveTrading === true,
    accountDomesticPresent: Boolean(credentials.accountDomestic),
    accountOverseasPresent: Boolean(credentials.accountOverseas),
    horizon: credentials.horizon,
    valuesRedacted: true,
  };
}

function maskAccountIdentifier(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 2)}${'*'.repeat(Math.max(2, raw.length - 4))}${raw.slice(-2)}`;
}

async function diagnoseConfiguredAccount(market, credentials, accounts) {
  const configured = market === 'overseas' ? credentials.accountOverseas : credentials.accountDomestic;
  const resolved = resolveTossAccount({ market }, credentials, accounts);
  const output = {
    market,
    configuredPresent: Boolean(configured),
    configuredMasked: maskAccountIdentifier(configured),
    resolvedOk: resolved.ok === true,
    accountSeq: resolved.ok ? resolved.account : null,
    source: resolved.source || null,
    skippedReason: resolved.skippedReason || null,
    holdingsCheck: {
      attempted: false,
      ok: false,
      count: 0,
      skippedReason: null,
      error: null,
    },
  };
  if (!configured) {
    output.holdingsCheck.skippedReason = `toss_account_required_${market}`;
    return output;
  }
  output.holdingsCheck.attempted = true;
  try {
    const holdings = await getHoldings(market);
    output.holdingsCheck.ok = holdings?.skipped !== true;
    output.holdingsCheck.count = Array.isArray(holdings?.holdings) ? holdings.holdings.length : 0;
    output.holdingsCheck.skippedReason = holdings?.skippedReason || null;
  } catch (error) {
    output.holdingsCheck.error = redactError(error);
  }
  return output;
}

export async function runTossSecretDoctor() {
  await initHubSecrets();
  const credentials = credentialStatus();
  const rawCredentials = getTossCredentials();
  const result = {
    ok: false,
    status: 'toss_credentials_missing',
    credentials,
    accountHeaderGuidance: 'X-Tossinvest-Account 헤더에는 accountSeq(예: 1)를 사용합니다. secrets에는 accountSeq, accountNo:Seq, accountNo 모두 입력 가능하며 자동 환원합니다.',
    token: {
      attempted: false,
      ok: false,
      expiresIn: null,
      valueRedacted: true,
      error: null,
    },
    accounts: {
      attempted: false,
      ok: false,
      count: 0,
      identifiers: [],
      error: null,
    },
    configuredAccounts: {
      domestic: null,
      overseas: null,
    },
    securitiesWarning: {
      attempted: false,
      ok: false,
      symbol: '005930',
      count: 0,
      error: null,
    },
    nextActions: [],
  };

  if (!hasTossCredentials()) {
    result.nextActions = [
      'Hub secrets-store.json의 toss.api_key / toss.secret_key를 마스터가 입력해야 합니다.',
      '키/토큰 값은 채팅이나 tracked 파일에 붙여넣지 마세요.',
    ];
    return result;
  }

  result.token.attempted = true;
  try {
    const token = await getTossToken();
    result.token.ok = true;
    result.token.expiresIn = token.expiresIn;
  } catch (error) {
    result.status = 'toss_token_failed';
    result.token.error = redactError(error);
    result.nextActions = ['토스 Open API 키/시크릿 유효성 또는 앱 권한 상태를 확인하세요.'];
    return result;
  }

  result.accounts.attempted = true;
  let accounts = [];
  try {
    accounts = await getAccounts();
    result.accounts.ok = true;
    result.accounts.count = accounts.length;
    result.accounts.identifiers = accounts.map((account) => ({
      idMasked: maskAccountIdentifier(account.id),
      accountType: account.accountType,
      accountSeq: account.accountSeq,
    }));
  } catch (error) {
    result.accounts.error = redactError(error);
  }

  result.configuredAccounts.domestic = await diagnoseConfiguredAccount('domestic', rawCredentials, accounts);
  result.configuredAccounts.overseas = await diagnoseConfiguredAccount('overseas', rawCredentials, accounts);

  result.securitiesWarning.attempted = true;
  try {
    const warnings = await getSecuritiesWarning(result.securitiesWarning.symbol);
    result.securitiesWarning.ok = true;
    result.securitiesWarning.count = warnings.length;
  } catch (error) {
    result.securitiesWarning.error = redactError(error);
  }

  result.ok = result.token.ok && result.accounts.ok && result.securitiesWarning.ok;
  result.status = result.ok ? 'toss_ready' : 'toss_partial';
  result.nextActions = result.ok
    ? ['Hub secrets-store.json toss.account_domestic/account_overseas에는 accountSeq, accountNo:Seq, accountNo 중 편한 형식으로 입력할 수 있습니다. 런타임은 accountSeq로 자동 환원합니다.']
    : ['토큰은 발급됐지만 일부 읽기 API가 실패했습니다. 토스 앱 권한과 계좌 연결 상태를 확인하세요.'];
  return result;
}

async function main() {
  const result = await runTossSecretDoctor();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[toss-secret-doctor] ${result.status}`);
    console.log(`- credentials: api_key=${result.credentials.apiKeyPresent ? 'present' : 'missing'} secret_key=${result.credentials.secretKeyPresent ? 'present' : 'missing'} mode=${result.credentials.mode} live_trading=${String(result.credentials.liveTrading)}`);
    console.log(`- token: ${result.token.ok ? `ok expires_in=${result.token.expiresIn}` : (result.token.error || 'skipped')}`);
    console.log(`- accounts: ${result.accounts.ok ? `${result.accounts.count} found` : (result.accounts.error || 'skipped')}`);
    console.log(`- account-header: ${result.accountHeaderGuidance}`);
    console.log(`- configured domestic: ${result.configuredAccounts.domestic?.resolvedOk ? `accountSeq=${result.configuredAccounts.domestic.accountSeq}` : (result.configuredAccounts.domestic?.skippedReason || 'skipped')}`);
    console.log(`- configured overseas: ${result.configuredAccounts.overseas?.resolvedOk ? `accountSeq=${result.configuredAccounts.overseas.accountSeq}` : (result.configuredAccounts.overseas?.skippedReason || 'skipped')}`);
    console.log(`- securities-warning: ${result.securitiesWarning.ok ? `${result.securitiesWarning.count} warnings` : (result.securitiesWarning.error || 'skipped')}`);
  }
  if (hasFlag('require-ready') && !result.ok) process.exitCode = 2;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'toss-secret-doctor error:' });
}

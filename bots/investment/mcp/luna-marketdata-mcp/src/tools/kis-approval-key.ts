import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_MARKETDATA_REAL_TIMEOUT_MS || 5000);
const APPROVAL_TTL_MS = Number(process.env.KIS_WS_APPROVAL_KEY_TTL_MS || 50 * 60 * 1000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_CONFIG_PATH = path.resolve(__dirname, '../../../../config.yaml');
const HUB_SECRETS_PATH = path.resolve(__dirname, '../../../../../hub/secrets-store.json');

const approvalCache = new Map();
const approvalInflight = new Map();

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

function getLocalKisSecrets() {
  const config = readYaml(INVESTMENT_CONFIG_PATH, {});
  const store = readJson(HUB_SECRETS_PATH, {});
  const hubKis = store.kis || store.investment_accounts?.kis || store.config?.kis || {};
  return {
    appKey: config.kis?.app_key || hubKis.app_key || '',
    appSecret: config.kis?.app_secret || hubKis.app_secret || '',
  };
}

async function getKisSecrets() {
  const secrets = await import('../../../../shared/secrets.ts').catch(() => null);
  const local = getLocalKisSecrets();
  const appKey = process.env.KIS_APP_KEY || secrets?.getKisAppKey?.() || local.appKey || '';
  const appSecret = process.env.KIS_APP_SECRET || secrets?.getKisAppSecret?.() || local.appSecret || '';
  return { appKey, appSecret };
}

async function fetchApprovalKey(args = {}) {
  const { appKey, appSecret } = await getKisSecrets();
  if (!appKey || !appSecret) throw new Error('kis_credentials_missing');
  const paper = args.paper === true || process.env.KIS_MODE === 'mock';
  const apiBase = paper ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443';
  const response = await fetch(`${apiBase}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
    signal: AbortSignal.timeout(Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS))),
  });
  if (!response.ok) throw new Error(`kis_approval_http_${response.status}`);
  const body = await response.json();
  if (!body.approval_key) throw new Error('kis_approval_key_missing');
  return body.approval_key;
}

export async function getKisRealtimeApprovalKey(args = {}) {
  const paper = args.paper === true || process.env.KIS_MODE === 'mock';
  const key = paper ? 'paper' : 'live';
  const now = Date.now();
  const cached = approvalCache.get(key);
  if (cached?.approvalKey && now - cached.issuedAt < Math.max(30_000, APPROVAL_TTL_MS)) {
    return cached.approvalKey;
  }
  if (approvalInflight.has(key)) return approvalInflight.get(key);
  const promise = fetchApprovalKey(args)
    .then((approvalKey) => {
      approvalCache.set(key, { approvalKey, issuedAt: Date.now() });
      return approvalKey;
    })
    .finally(() => approvalInflight.delete(key));
  approvalInflight.set(key, promise);
  return promise;
}

export function clearKisRealtimeApprovalKeyCache() {
  approvalCache.clear();
  approvalInflight.clear();
}

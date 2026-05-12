import { getMarketSnapshot } from './market-snapshot.ts';
import { simulatedFallbackOrBlock } from './live-fallback-policy.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  clearKisRealtimeApprovalKeyCache,
  getKisRealtimeApprovalKey,
  isKisInvalidApprovalError,
  redactKisInvalidApprovalError,
} from './kis-approval-key.ts';

const KIS_WS_LIVE = 'ws://ops.koreainvestment.com:21000';
const KIS_WS_MOCK = 'ws://ops.koreainvestment.com:31000';
const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_MARKETDATA_REAL_TIMEOUT_MS || 5000);
const subscriptions = new Map();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_CONFIG_PATH = path.resolve(__dirname, '../../../../config.yaml');
const HUB_SECRETS_PATH = path.resolve(__dirname, '../../../../../hub/secrets-store.json');

function isRealEnabled(args = {}) {
  if (args.disableReal === true) return false;
  return process.env.LUNA_MARKETDATA_REAL_WS_ENABLED !== 'false';
}

function normalizeSymbol(symbol = '005930') {
  return String(symbol || '005930').trim().toUpperCase();
}

function fallbackSnapshot(args = {}, reason = 'kis_domestic_realtime_unavailable') {
  return simulatedFallbackOrBlock(() => ({
    ...getMarketSnapshot({ ...args, market: 'kis_domestic', symbol: args.symbol || '005930' }),
    providerMode: 'simulated_fallback',
    fallbackReason: String(reason || 'kis_domestic_realtime_unavailable').slice(0, 240),
  }), { args, market: 'kis_domestic', symbol: args.symbol || '005930', reason, tool: 'get_market_snapshot' });
}

function addWsListener(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  if (typeof ws.on === 'function') ws.on(event, handler);
}

function messageText(eventOrRaw) {
  const raw = eventOrRaw?.data ?? eventOrRaw;
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw || '');
}

export function redactKisWsDiagnosticMessage(text) {
  return redactKisInvalidApprovalError(text)
    .replace(/("approval_key"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/("key"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/("iv"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2');
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

async function getApprovalKey(args = {}) {
  return getKisRealtimeApprovalKey(args);
}

function parseDomesticCsv(raw, symbol) {
  const parts = String(raw || '').split('|');
  const trId = parts[1] || '';
  const payload = parts.slice(3).join('|');
  const fields = payload.includes('^') ? payload.split('^') : parts.slice(3);
  if (!['H0STCNT0', 'H0STASP0'].includes(trId)) return null;
  const candidateSymbol = fields[0] || symbol;
  const numeric = fields.map((item) => Number(String(item || '').replace(/,/g, ''))).filter((value) => Number.isFinite(value) && value > 0);
  const price = numeric.find((value) => value > 10) || 0;
  if (!price) return null;
  return {
    ok: true,
    source: 'kis_domestic_ws',
    providerMode: 'websocket',
    market: 'kis_domestic',
    symbol: normalizeSymbol(candidateSymbol || symbol),
    price,
    volume24h: numeric[numeric.length - 1] || 0,
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

async function kisDomesticWsSnapshot(args = {}) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('native_websocket_unavailable');
  const symbol = normalizeSymbol(args.symbol || '005930');
  const existing = subscriptions.get(symbol);
  if (existing?.lastSnapshot?.ok) return existing.lastSnapshot;

  const approvalKey = await getApprovalKey(args);
  const paper = args.paper === true || process.env.KIS_MODE === 'mock';
  const ws = new globalThis.WebSocket(args.wsUrl || (paper ? KIS_WS_MOCK : KIS_WS_LIVE));
  const entry = { ws, symbol, status: 'connecting', lastSnapshot: null, openedAt: new Date().toISOString() };
  subscriptions.set(symbol, entry);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (entry.lastSnapshot?.ok) resolve(entry.lastSnapshot);
      else reject(new Error('kis_domestic_ws_snapshot_timeout'));
    }, Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS)));

    addWsListener(ws, 'open', () => {
      entry.status = 'open';
      ws.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
        body: { input: { tr_id: 'H0STCNT0', tr_key: symbol } },
      }));
      ws.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
        body: { input: { tr_id: 'H0STASP0', tr_key: symbol } },
      }));
    });
    addWsListener(ws, 'message', (event) => {
      const text = messageText(event);
      const snapshot = text.startsWith('0|') || text.startsWith('1|') ? parseDomesticCsv(text, symbol) : null;
      if (snapshot?.ok) {
        entry.status = 'ready';
        entry.lastSnapshot = snapshot;
        clearTimeout(timer);
        resolve(snapshot);
      }
    });
    addWsListener(ws, 'error', (event) => {
      clearTimeout(timer);
      reject(new Error(event?.message || 'kis_domestic_ws_error'));
    });
  });

  return entry.lastSnapshot;
}

export async function probeKisDomesticRealtime(args = {}) {
  const symbol = normalizeSymbol(args.symbol || '005930');
  const startedAt = new Date().toISOString();
  const timeoutMs = Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS));
  const result = {
    ok: false,
    market: 'kis_domestic',
    symbol,
    startedAt,
    approvalKeyIssued: false,
    wsOpened: false,
    subscriptionSent: false,
    subscriptionAccepted: false,
    firstTickReceived: false,
    providerMode: 'websocket_probe',
    messages: [],
    error: null,
  };

  if (!isRealEnabled(args)) {
    return { ...result, error: 'real_ws_disabled', checkedAt: new Date().toISOString() };
  }
  if (typeof globalThis.WebSocket !== 'function') {
    return { ...result, error: 'native_websocket_unavailable', checkedAt: new Date().toISOString() };
  }

  let ws = null;
  try {
    const approvalKey = await getApprovalKey(args);
    result.approvalKeyIssued = Boolean(approvalKey);
    const paper = args.paper === true || process.env.KIS_MODE === 'mock';
    ws = new globalThis.WebSocket(args.wsUrl || (paper ? KIS_WS_MOCK : KIS_WS_LIVE));

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      addWsListener(ws, 'open', () => {
        result.wsOpened = true;
        try {
          ws.send(JSON.stringify({
            header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
            body: { input: { tr_id: 'H0STCNT0', tr_key: symbol } },
          }));
          ws.send(JSON.stringify({
            header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
            body: { input: { tr_id: 'H0STASP0', tr_key: symbol } },
          }));
          result.subscriptionSent = true;
        } catch (error) {
          result.error = error?.message || String(error);
          clearTimeout(timer);
          resolve();
        }
      });
      addWsListener(ws, 'message', (event) => {
        const text = messageText(event);
        result.messages.push(redactKisWsDiagnosticMessage(text).slice(0, 240));
        try {
          const parsed = JSON.parse(text);
          const rtCd = String(parsed?.body?.rt_cd ?? '');
          if (rtCd === '0') result.subscriptionAccepted = true;
          else if (rtCd) result.error = parsed?.body?.msg1 || parsed?.body?.msg_cd || `kis_domestic_ws_rejected:${rtCd}`;
        } catch (_) {
          // Non-JSON payloads are handled by the market-data parser below.
        }
        const snapshot = text.startsWith('0|') || text.startsWith('1|') ? parseDomesticCsv(text, symbol) : null;
        if (snapshot?.ok) {
          result.subscriptionAccepted = true;
          result.firstTickReceived = true;
          clearTimeout(timer);
          resolve();
        }
      });
      addWsListener(ws, 'error', (event) => {
        result.error = result.error || event?.message || 'kis_domestic_ws_error';
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    result.error = error?.message || String(error);
  } finally {
    try {
      ws?.close?.();
    } catch (_) {
      // best-effort cleanup only
    }
  }

  if (!args.__approvalRetry && isKisInvalidApprovalError(result.error)) {
    clearKisRealtimeApprovalKeyCache();
    const retry = await probeKisDomesticRealtime({
      ...args,
      __approvalRetry: true,
      forceRefreshApprovalKey: true,
    });
    return {
      ...retry,
      approvalKeyRetry: {
        attempted: true,
        firstError: redactKisInvalidApprovalError(result.error).slice(0, 120),
      },
      messages: [...result.messages, ...(retry.messages || [])].slice(-8),
    };
  }

  result.ok = result.approvalKeyIssued && result.wsOpened && result.subscriptionSent && result.subscriptionAccepted && !result.error;
  result.status = result.firstTickReceived
    ? 'kis_domestic_realtime_tick_ready'
    : result.ok
      ? 'kis_domestic_realtime_subscription_ready_no_tick'
      : 'kis_domestic_realtime_probe_failed';
  result.checkedAt = new Date().toISOString();
  return result;
}

async function kisDomesticRestSnapshot(args = {}) {
  const kis = await import('../../../../shared/kis-client.ts');
  const quote = await kis.getDomesticQuoteSnapshot(normalizeSymbol(args.symbol || '005930'), args.paper);
  return {
    ok: true,
    source: 'kis_domestic_rest',
    providerMode: 'rest',
    market: 'kis_domestic',
    symbol: normalizeSymbol(quote.symbol || args.symbol || '005930'),
    price: Number(quote.price || 0),
    open: Number(quote.open || 0),
    high: Number(quote.high || 0),
    low: Number(quote.low || 0),
    volume24h: Number(quote.volume || 0),
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function kisDomesticSnapshot(args = {}) {
  if (!isRealEnabled(args)) return fallbackSnapshot(args, 'real_ws_disabled');
  try {
    return await kisDomesticWsSnapshot(args);
  } catch (wsError) {
    try {
      return await kisDomesticRestSnapshot(args);
    } catch (_) {
      return fallbackSnapshot(args, wsError?.message || wsError);
    }
  }
}

export async function subscribeKisDomesticMarketData(args = {}) {
  const snapshot = await kisDomesticSnapshot(args);
  return { ok: snapshot.ok !== false, subscribed: snapshot.ok !== false, providerMode: snapshot.providerMode, subscription: snapshot };
}

export function unsubscribeKisDomesticMarketData(args = {}) {
  const symbol = normalizeSymbol(args.symbol || '005930');
  const entry = subscriptions.get(symbol);
  try {
    entry?.ws?.close?.();
  } catch (_) {
    // best-effort cleanup only
  }
  const removed = subscriptions.delete(symbol);
  return { ok: true, unsubscribed: removed, market: 'kis_domestic', key: symbol, count: subscriptions.size };
}

export function closeKisDomesticSubscriptions() {
  for (const entry of subscriptions.values()) {
    try {
      entry?.ws?.close?.();
    } catch (_) {
      // best-effort cleanup only
    }
  }
  subscriptions.clear();
}

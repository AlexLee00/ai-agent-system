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
type MarketDataArgs = {
  symbol?: string;
  disableReal?: boolean;
  paper?: boolean;
  wsUrl?: string;
  timeoutMs?: number;
  __approvalRetry?: boolean;
  forceRefreshApprovalKey?: boolean;
  [key: string]: unknown;
};
type MarketSnapshot = {
  ok: boolean;
  source?: string;
  providerMode?: string;
  market?: string;
  symbol?: string;
  price?: number;
  volume24h?: number;
  stale?: boolean;
  fetchedAt?: string;
  [key: string]: unknown;
};
type WsLike = {
  addEventListener?: (event: string, handler: (event: any) => void) => void;
  on?: (event: string, handler: (event: any) => void) => void;
  send: (payload: string) => void;
  close?: () => void;
};
type SubscriptionEntry = {
  ws: WsLike;
  symbol: string;
  status: string;
  lastSnapshot: MarketSnapshot | null;
  openedAt: string;
};
type ProbeResult = {
  ok: boolean;
  market: string;
  symbol: string;
  startedAt: string;
  approvalKeyIssued: boolean;
  wsOpened: boolean;
  subscriptionSent: boolean;
  subscriptionAccepted: boolean;
  firstTickReceived: boolean;
  providerMode: string;
  messages: string[];
  error: string | null;
  status?: string;
  checkedAt?: string;
  approvalKeyRetry?: {
    attempted: boolean;
    firstError: string;
  };
};
const subscriptions = new Map<string, SubscriptionEntry>();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_CONFIG_PATH = path.resolve(__dirname, '../../../../config.yaml');
const HUB_SECRETS_PATH = path.resolve(__dirname, '../../../../../hub/secrets-store.json');

function isRealEnabled(args: MarketDataArgs = {}) {
  if (args.disableReal === true) return false;
  return process.env.LUNA_MARKETDATA_REAL_WS_ENABLED !== 'false';
}

function normalizeSymbol(symbol: unknown = 'AAPL') {
  return String(symbol || 'AAPL').trim().toUpperCase();
}

function fallbackSnapshot(args: MarketDataArgs = {}, reason: unknown = 'kis_overseas_realtime_unavailable') {
  return simulatedFallbackOrBlock(() => ({
    ...getMarketSnapshot({ ...args, market: 'kis_overseas', symbol: String(args.symbol || 'AAPL') }),
    providerMode: 'simulated_fallback',
    fallbackReason: String(reason || 'kis_overseas_realtime_unavailable').slice(0, 240),
  }), { args, market: 'kis_overseas', symbol: String(args.symbol || 'AAPL'), reason: String(reason || ''), tool: 'get_market_snapshot' }) as MarketSnapshot;
}

function addWsListener(ws: WsLike, event: string, handler: (event: any) => void) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  if (typeof ws.on === 'function') ws.on(event, handler);
}

function messageText(eventOrRaw: any): string {
  const raw = eventOrRaw?.data ?? eventOrRaw;
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw || '');
}

export function redactKisWsDiagnosticMessage(text: string) {
  return redactKisInvalidApprovalError(text)
    .replace(/("approval_key"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/("key"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/("iv"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2');
}

function readYaml(file: string, fallback: Record<string, any> = {}): any {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) || fallback;
  } catch {
    return fallback;
  }
}

function readJson(file: string, fallback: Record<string, any> = {}): any {
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

async function getApprovalKey(args: MarketDataArgs = {}) {
  return getKisRealtimeApprovalKey(args);
}

function parseOverseasCsv(raw: unknown, symbol: string): MarketSnapshot | null {
  const parts = String(raw || '').split('|');
  const trId = parts[1] || '';
  const payload = parts.slice(3).join('|');
  const fields = payload.includes('^') ? payload.split('^') : parts.slice(3);
  if (!['HDFSCNT0', 'HDFSASP0'].includes(trId)) return null;
  const candidateSymbol = fields[0] || symbol;
  const numeric = fields.map((item) => Number(String(item || '').replace(/,/g, ''))).filter((value) => Number.isFinite(value) && value > 0);
  const price = numeric.find((value) => value > 0.01) || 0;
  if (!price) return null;
  return {
    ok: true,
    source: 'kis_overseas_ws',
    providerMode: 'websocket',
    market: 'kis_overseas',
    symbol: normalizeSymbol(candidateSymbol || symbol),
    price,
    volume24h: numeric[numeric.length - 1] || 0,
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

async function kisOverseasWsSnapshot(args: MarketDataArgs = {}): Promise<MarketSnapshot | null> {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('native_websocket_unavailable');
  const symbol = normalizeSymbol(args.symbol || 'AAPL');
  const existing = subscriptions.get(symbol);
  if (existing?.lastSnapshot?.ok) return existing.lastSnapshot;

  const approvalKey = await getApprovalKey(args);
  const paper = args.paper === true || process.env.KIS_MODE === 'mock';
  const ws = new globalThis.WebSocket(args.wsUrl || (paper ? KIS_WS_MOCK : KIS_WS_LIVE)) as WsLike;
  const entry: SubscriptionEntry = { ws, symbol, status: 'connecting', lastSnapshot: null, openedAt: new Date().toISOString() };
  subscriptions.set(symbol, entry);

  await new Promise<MarketSnapshot | void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (entry.lastSnapshot?.ok) resolve(entry.lastSnapshot);
      else reject(new Error('kis_overseas_ws_snapshot_timeout'));
    }, Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS)));

    addWsListener(ws, 'open', () => {
      entry.status = 'open';
      ws.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
        body: { input: { tr_id: 'HDFSCNT0', tr_key: symbol } },
      }));
      ws.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
        body: { input: { tr_id: 'HDFSASP0', tr_key: symbol } },
      }));
    });
    addWsListener(ws, 'message', (event) => {
      const text = messageText(event);
      const snapshot = text.startsWith('0|') || text.startsWith('1|') ? parseOverseasCsv(text, symbol) : null;
      if (snapshot?.ok) {
        entry.status = 'ready';
        entry.lastSnapshot = snapshot;
        clearTimeout(timer);
        resolve(snapshot);
      }
    });
    addWsListener(ws, 'error', (event) => {
      clearTimeout(timer);
      reject(new Error(event?.message || 'kis_overseas_ws_error'));
    });
  });

  return entry.lastSnapshot;
}

export async function probeKisOverseasRealtime(args: MarketDataArgs = {}): Promise<ProbeResult> {
  const symbol = normalizeSymbol(args.symbol || 'AAPL');
  const startedAt = new Date().toISOString();
  const timeoutMs = Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS));
  const result: ProbeResult = {
    ok: false,
    market: 'kis_overseas',
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

  let ws: WsLike | null = null;
  try {
    const approvalKey = await getApprovalKey(args);
    result.approvalKeyIssued = Boolean(approvalKey);
    const paper = args.paper === true || process.env.KIS_MODE === 'mock';
    ws = new globalThis.WebSocket(args.wsUrl || (paper ? KIS_WS_MOCK : KIS_WS_LIVE)) as WsLike;
    const activeWs = ws;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      addWsListener(activeWs, 'open', () => {
        result.wsOpened = true;
        try {
          activeWs.send(JSON.stringify({
            header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
            body: { input: { tr_id: 'HDFSCNT0', tr_key: symbol } },
          }));
          activeWs.send(JSON.stringify({
            header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
            body: { input: { tr_id: 'HDFSASP0', tr_key: symbol } },
          }));
          result.subscriptionSent = true;
        } catch (error: any) {
          result.error = error?.message || String(error);
          clearTimeout(timer);
          resolve();
        }
      });
      addWsListener(activeWs, 'message', (event) => {
        const text = messageText(event);
        result.messages.push(redactKisWsDiagnosticMessage(text).slice(0, 240));
        try {
          const parsed = JSON.parse(text);
          const rtCd = String(parsed?.body?.rt_cd ?? '');
          if (rtCd === '0') result.subscriptionAccepted = true;
          else if (rtCd) result.error = parsed?.body?.msg1 || parsed?.body?.msg_cd || `kis_overseas_ws_rejected:${rtCd}`;
        } catch (_) {
          // Non-JSON payloads are handled by the market-data parser below.
        }
        const snapshot = text.startsWith('0|') || text.startsWith('1|') ? parseOverseasCsv(text, symbol) : null;
        if (snapshot?.ok) {
          result.subscriptionAccepted = true;
          result.firstTickReceived = true;
          clearTimeout(timer);
          resolve();
        }
      });
      addWsListener(activeWs, 'error', (event) => {
        result.error = result.error || event?.message || 'kis_overseas_ws_error';
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error: any) {
    result.error = error?.message || String(error);
  } finally {
    try {
      ws?.close?.();
    } catch (_) {
      // best-effort cleanup only
    }
  }

  if (!args.__approvalRetry && isKisInvalidApprovalError(result.error || undefined)) {
    clearKisRealtimeApprovalKeyCache();
    const retry = await probeKisOverseasRealtime({
      ...args,
      __approvalRetry: true,
      forceRefreshApprovalKey: true,
    });
    return {
      ...retry,
      approvalKeyRetry: {
        attempted: true,
        firstError: redactKisInvalidApprovalError(result.error || undefined).slice(0, 120),
      },
      messages: [...result.messages, ...(retry.messages || [])].slice(-8),
    };
  }

  result.ok = result.approvalKeyIssued && result.wsOpened && result.subscriptionSent && result.subscriptionAccepted && !result.error;
  result.status = result.firstTickReceived
    ? 'kis_overseas_realtime_tick_ready'
    : result.ok
      ? 'kis_overseas_realtime_subscription_ready_no_tick'
      : 'kis_overseas_realtime_probe_failed';
  result.checkedAt = new Date().toISOString();
  return result;
}

async function kisOverseasRestSnapshot(args: MarketDataArgs = {}): Promise<MarketSnapshot> {
  const kis = await import('../../../../shared/kis-client.ts');
  const quote: any = await kis.getOverseasQuoteSnapshot(normalizeSymbol(args.symbol || 'AAPL'));
  return {
    ok: true,
    source: 'kis_overseas_rest',
    providerMode: 'rest',
    market: 'kis_overseas',
    symbol: normalizeSymbol(quote.symbol || args.symbol || 'AAPL'),
    price: Number(quote.price || 0),
    open: Number(quote.open || 0),
    high: Number(quote.high || 0),
    low: Number(quote.low || 0),
    changePct24h: Number(quote.changePct || 0) / 100,
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function kisOverseasSnapshot(args: MarketDataArgs = {}): Promise<MarketSnapshot> {
  if (!isRealEnabled(args)) return fallbackSnapshot(args, 'real_ws_disabled');
  try {
    return await kisOverseasWsSnapshot(args) || fallbackSnapshot(args, 'kis_overseas_ws_snapshot_empty');
  } catch (wsError: any) {
    try {
      return await kisOverseasRestSnapshot(args);
    } catch (_) {
      return fallbackSnapshot(args, wsError?.message || wsError);
    }
  }
}

export async function subscribeKisOverseasMarketData(args: MarketDataArgs = {}) {
  const snapshot = await kisOverseasSnapshot(args);
  return { ok: snapshot.ok !== false, subscribed: snapshot.ok !== false, providerMode: snapshot.providerMode, subscription: snapshot };
}

export function unsubscribeKisOverseasMarketData(args: MarketDataArgs = {}) {
  const symbol = normalizeSymbol(args.symbol || 'AAPL');
  const entry = subscriptions.get(symbol);
  try {
    entry?.ws?.close?.();
  } catch (_) {
    // best-effort cleanup only
  }
  const removed = subscriptions.delete(symbol);
  return { ok: true, unsubscribed: removed, market: 'kis_overseas', key: symbol, count: subscriptions.size };
}

export function closeKisOverseasSubscriptions() {
  for (const entry of subscriptions.values()) {
    try {
      entry?.ws?.close?.();
    } catch (_) {
      // best-effort cleanup only
    }
  }
  subscriptions.clear();
}

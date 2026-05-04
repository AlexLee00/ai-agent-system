import { getMarketSnapshot } from './market-snapshot.ts';
import { simulatedFallbackOrBlock } from './live-fallback-policy.ts';

const KIS_WS_LIVE = 'wss://openapi.koreainvestment.com:9443';
const KIS_WS_MOCK = 'wss://openapivts.koreainvestment.com:31000';
const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_MARKETDATA_REAL_TIMEOUT_MS || 5000);
const subscriptions = new Map();

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

async function getKisSecrets() {
  const secrets = await import('../../../../shared/secrets.ts').catch(() => null);
  const appKey = process.env.KIS_APP_KEY || secrets?.getKisAppKey?.() || '';
  const appSecret = process.env.KIS_APP_SECRET || secrets?.getKisAppSecret?.() || '';
  return { appKey, appSecret };
}

async function getApprovalKey(args = {}) {
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

/**
 * shared/binance-ws-enhanced.js
 * Binance Combined Stream WebSocket — orderbook + trade tick + kline 실시간
 *
 * 기존 hephaestos.ts REST 폴링 보완: 변동 이벤트를 JayBus로 브로드캐스트.
 * Kill Switch: LUNA_BINANCE_WS_ENABLED=true
 *
 * 토픽 (JayBus):
 *   luna.binance.trade.{symbol}         체결 tick
 *   luna.binance.orderbook.{symbol}     orderbook (100ms)
 *   luna.binance.kline.{symbol}.{tf}    실시간 봉
 */

const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));

const SYMBOLS = (process.env.LUNA_BINANCE_SYMBOLS || 'btcusdt,ethusdt,solusdt,bnbusdt').split(',');
const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT = 20;

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function buildStreams(symbols) {
  return symbols.flatMap(s => [
    `${s}@depth20@100ms`,
    `${s}@trade`,
    `${s}@kline_1m`,
    `${s}@kline_5m`,
  ]);
}

function connect() {
  const streams = buildStreams(SYMBOLS);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  console.log(`[Binance-WS] 연결 시도 (${SYMBOLS.length}개 심볼, ${streams.length}개 스트림)`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[Binance-WS] 연결됨');
    reconnectAttempts = 0;
  });

  ws.on('message', (raw) => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      if (!stream || !data) return;
      routeMessage(stream, data);
    } catch (_) { /* ignore */ }
  });

  ws.on('close', () => {
    console.warn('[Binance-WS] 연결 끊김, 재연결 예정');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Binance-WS] 오류:', err.message);
  });
}

function routeMessage(stream, data) {
  if (stream.endsWith('@trade')) {
    publishTrade(data);
  } else if (stream.includes('@depth20')) {
    publishOrderbook(stream, data);
  } else if (stream.includes('@kline_')) {
    publishKline(stream, data);
  }
}

function publishTrade(data) {
  const symbol = data.s?.toLowerCase();
  if (!symbol) return;
  const payload = {
    symbol,
    tradeId: data.t,
    price: parseFloat(data.p),
    qty: parseFloat(data.q),
    timestamp: data.T,
    isBuyerMaker: data.m,
  };
  publishToHub(`luna.binance.trade.${symbol}`, payload);
}

function publishOrderbook(stream, data) {
  const symbol = stream.split('@')[0];
  const payload = {
    symbol,
    bids: data.bids?.slice(0, 5).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: data.asks?.slice(0, 5).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    timestamp: Date.now(),
  };
  publishToHub(`luna.binance.orderbook.${symbol}`, payload);
}

function publishKline(stream, data) {
  const [symbolStream, tfPart] = stream.split('@kline_');
  const symbol = symbolStream;
  const tf = tfPart;
  if (!data.k?.x) return; // 봉 미완성 — 완성된 봉만 발행

  const k = data.k;
  const payload = {
    symbol,
    timeframe: tf,
    timestamp: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    closed: k.x,
  };
  publishToHub(`luna.binance.kline.${symbol}.${tf}`, payload);
}

async function publishToHub(topic, payload) {
  if (!HUB_TOKEN) return;
  try {
    await fetch(`${HUB_BASE}/hub/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUB_TOKEN}`,
      },
      body: JSON.stringify({
        source: 'luna.binance',
        topic,
        payload,
        timestamp: Date.now(),
      }),
    });
  } catch (_) { /* Hub 실패 무시 */ }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT) {
    console.error('[Binance-WS] 최대 재연결 초과');
    return;
  }
  const delay = Math.min(60_000, RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Kill Switch 체크
if (process.env.LUNA_BINANCE_WS_ENABLED !== 'true') {
  console.log('[Binance-WS] Kill Switch OFF — 비활성 (LUNA_BINANCE_WS_ENABLED=true 로 활성화)');
} else {
  connect();
}

process.on('SIGTERM', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  process.exit(0);
});

export { connect, publishToHub };

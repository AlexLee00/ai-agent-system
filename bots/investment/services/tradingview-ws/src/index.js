/**
 * services/tradingview-ws/src/index.js
 * TradingView WebSocket OHLCV 브로드캐스트 서비스 (dovudo 패턴 포팅)
 *
 * - WebSocket API 서버 (포트 8082)
 * - 동적 구독/해지 (심볼 + 타임프레임)
 * - Stale detection + Auto-recovery (개별 재구독 → 전체 재연결)
 * - Prometheus 메트릭스 (:8083/metrics)
 * - JayBus 브릿지: Hub /hub/events/publish 경유
 *
 * 환경변수:
 *   TV_WS_PORT=8082         클라이언트 WebSocket 포트
 *   TV_METRICS_PORT=8083    Prometheus 메트릭스 포트
 *   TV_STALE_THRESHOLD_MS=30000  Stale 판단 임계값
 *   HUB_BASE_URL            Hub URL
 *   HUB_AUTH_TOKEN          Hub 인증 토큰
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { Registry, Gauge, Counter, collectDefaultMetrics } from 'prom-client';

const TV_WS_PORT = parseInt(process.env.TV_WS_PORT || '8082', 10);
const METRICS_PORT = parseInt(process.env.TV_METRICS_PORT || '8083', 10);
const STALE_THRESHOLD_MS = parseInt(process.env.TV_STALE_THRESHOLD_MS || '30000', 10);
const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const RECONNECT_DELAY_BASE_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Prometheus 메트릭스
const registry = new Registry();
collectDefaultMetrics({ register: registry });

const staleSubscriptionsGauge = new Gauge({
  name: 'luna_tv_stale_subscriptions',
  help: 'TradingView stale 구독 수',
  labelNames: ['symbol', 'timeframe'],
  registers: [registry],
});
const recoveryAttemptsCounter = new Counter({
  name: 'luna_tv_recovery_attempts_total',
  help: 'TradingView 재연결 시도 수',
  labelNames: ['type'],
  registers: [registry],
});
const barPublishedCounter = new Counter({
  name: 'luna_tv_bars_published_total',
  help: '발행된 OHLCV 봉 수',
  labelNames: ['symbol', 'timeframe'],
  registers: [registry],
});

// 구독 상태 관리
const subscriptions = new Map(); // key: `${symbol}:${timeframe}` → { symbol, timeframe, lastBarAt }
const clientSockets = new Set(); // 연결된 클라이언트 WebSocket
const latestBars = new Map(); // key: `${symbol}:${timeframe}` → { symbol, timeframe, lastBarAt, bar }

// TradingView 연결 (실제 환경에서는 TV WebSocket API)
// NOTE: TradingView WebSocket은 공식 API가 없어 dovudo 패턴의 비공개 프로토콜 사용
// 실제 배포 시 TV WS 인증 토큰/세션 필요
let tvWs = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let staleCheckTimer = null;

function connectTradingView() {
  // dovudo/tradingview-websocket 패턴: wss://data.tradingview.com/socket.io/websocket
  const tvUrl = process.env.TV_WS_URL || 'wss://data.tradingview.com/socket.io/websocket?from=chart%2F&date=2024_09_25-10_03&type=chart';
  console.log(`[TV-WS] TradingView 연결 시도 #${reconnectAttempts + 1}: ${tvUrl.substring(0, 60)}...`);

  try {
    tvWs = new WebSocket(tvUrl, {
      headers: {
        'Origin': 'https://www.tradingview.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    });
  } catch (err) {
    console.error('[TV-WS] WebSocket 생성 실패:', err.message);
    scheduleReconnect();
    return;
  }

  tvWs.on('open', () => {
    console.log('[TV-WS] TradingView 연결됨');
    reconnectAttempts = 0;
    // 기존 구독 복원
    for (const { symbol, timeframe } of subscriptions.values()) {
      sendTvSubscribe(symbol, timeframe);
    }
  });

  tvWs.on('message', (raw) => {
    handleTvMessage(raw.toString());
  });

  tvWs.on('close', (code) => {
    console.warn(`[TV-WS] 연결 끊김 (code=${code}), 재연결 예정`);
    scheduleReconnect();
  });

  tvWs.on('error', (err) => {
    console.error('[TV-WS] 오류:', err.message);
  });
}

function handleTvMessage(raw) {
  // TradingView 메시지는 ~m~N~m~{json} 형식
  const matches = raw.match(/~m~\d+~m~(.+)/g);
  if (!matches) return;

  for (const match of matches) {
    const jsonStr = match.replace(/~m~\d+~m~/, '');
    if (jsonStr.startsWith('~h~')) {
      // heartbeat → pong
      const hbNum = jsonStr.slice(3);
      tvWs.send(`~m~${hbNum.length + 6}~m~~h~${hbNum}`);
      continue;
    }
    try {
      const msg = JSON.parse(jsonStr);
      if (msg.m === 'du' || msg.m === 'timescale_update') {
        // OHLCV 업데이트
        processOhlcvUpdate(msg);
      }
    } catch (_) { /* ignore */ }
  }
}

function processOhlcvUpdate(msg) {
  // msg.p[1].sds_1.s 에 bar 데이터
  if (!msg.p || !msg.p[1]) return;
  const seriesData = msg.p[1];

  for (const [key, sub] of subscriptions.entries()) {
    const bars = seriesData[`sds_${key}`]?.s;
    if (!bars || !Array.isArray(bars)) continue;

    for (const bar of bars) {
      const [timestamp, open, high, low, close, volume] = bar.v;
      const barPayload = {
        symbol: sub.symbol,
        timeframe: sub.timeframe,
        timestamp: Math.floor(timestamp * 1000),
        open, high, low, close, volume,
      };

      sub.lastBarAt = Date.now();
      latestBars.set(key, {
        symbol: sub.symbol,
        timeframe: sub.timeframe,
        lastBarAt: sub.lastBarAt,
        bar: barPayload,
      });
      staleSubscriptionsGauge.set({ symbol: sub.symbol, timeframe: sub.timeframe }, 0);
      barPublishedCounter.inc({ symbol: sub.symbol, timeframe: sub.timeframe });

      broadcastToClients(barPayload);
      publishToHub(sub.symbol, sub.timeframe, barPayload);
    }
  }
}

function sendTvSubscribe(symbol, timeframe) {
  if (!tvWs || tvWs.readyState !== WebSocket.OPEN) return;
  // TradingView 구독 메시지 (create_series 형식)
  const seriesMsg = JSON.stringify({
    m: 'create_series',
    p: ['cs_1', `sds_${symbol}:${timeframe}`, 's1', symbol, timeframe, 300, ''],
  });
  const len = seriesMsg.length;
  tvWs.send(`~m~${len}~m~${seriesMsg}`);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[TV-WS] 최대 재연결 시도 초과');
    recoveryAttemptsCounter.inc({ type: 'failed' });
    return;
  }
  const delay = Math.min(60_000, RECONNECT_DELAY_BASE_MS * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  recoveryAttemptsCounter.inc({ type: 'scheduled' });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTradingView();
  }, delay);
}

function startStaleChecker() {
  staleCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, sub] of subscriptions.entries()) {
      if (sub.lastBarAt && now - sub.lastBarAt > STALE_THRESHOLD_MS) {
        console.warn(`[TV-WS] Stale 구독 감지: ${key}`);
        staleSubscriptionsGauge.set({ symbol: sub.symbol, timeframe: sub.timeframe }, 1);
        // 개별 재구독 시도
        sendTvSubscribe(sub.symbol, sub.timeframe);
        recoveryAttemptsCounter.inc({ type: 'resubscribe' });
      }
    }
  }, 10_000);
}

// JayBus Hub 브릿지
async function publishToHub(symbol, timeframe, bar) {
  if (!HUB_TOKEN) return;
  try {
    await fetch(`${HUB_BASE}/hub/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUB_TOKEN}`,
      },
      body: JSON.stringify({
        source: 'luna.tradingview',
        topic: `luna.tv.bar.${symbol}.${timeframe}`,
        payload: bar,
        timestamp: Date.now(),
      }),
    });
  } catch (_) { /* Hub 실패는 무시 — 독립 동작 유지 */ }
}

// 클라이언트에 브로드캐스트
function broadcastToClients(bar) {
  const msg = JSON.stringify(bar);
  for (const ws of clientSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// 클라이언트 WebSocket 서버 (포트 8082)
const wss = new WebSocketServer({ port: TV_WS_PORT });

wss.on('connection', (ws, req) => {
  console.log(`[TV-WS] 클라이언트 연결: ${req.socket.remoteAddress}`);
  clientSockets.add(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === 'subscribe' && msg.symbol && msg.timeframe) {
        const key = `${msg.symbol}:${msg.timeframe}`;
        if (!subscriptions.has(key)) {
          subscriptions.set(key, { symbol: msg.symbol, timeframe: msg.timeframe, lastBarAt: null });
          sendTvSubscribe(msg.symbol, msg.timeframe);
          console.log(`[TV-WS] 구독 추가: ${key}`);
        }
        ws.send(JSON.stringify({ ok: true, action: 'subscribed', key }));
      } else if (msg.action === 'unsubscribe' && msg.symbol && msg.timeframe) {
        const key = `${msg.symbol}:${msg.timeframe}`;
        subscriptions.delete(key);
        latestBars.delete(key);
        staleSubscriptionsGauge.remove({ symbol: msg.symbol, timeframe: msg.timeframe });
        ws.send(JSON.stringify({ ok: true, action: 'unsubscribed', key }));
      } else if (msg.action === 'list') {
        ws.send(JSON.stringify({ ok: true, subscriptions: [...subscriptions.keys()] }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  ws.on('close', () => clientSockets.delete(ws));
  ws.on('error', () => clientSockets.delete(ws));

  // 환영 메시지 + 현재 구독 목록
  ws.send(JSON.stringify({ type: 'connected', subscriptions: [...subscriptions.keys()] }));
});

// Prometheus 메트릭스 서버 (포트 8083)
const metricsServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${METRICS_PORT}`}`);
  if (url.pathname === '/metrics') {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } else if (url.pathname === '/health') {
    const tvStatus = tvWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      tv_ws: tvStatus,
      subscriptions: subscriptions.size,
      clients: clientSockets.size,
    }));
  } else if (url.pathname === '/subscribe') {
    const symbol = url.searchParams.get('symbol');
    const timeframe = url.searchParams.get('timeframe');
    if (!symbol || !timeframe) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'symbol,timeframe required' }));
      return;
    }
    const key = `${symbol}:${timeframe}`;
    if (!subscriptions.has(key)) {
      subscriptions.set(key, { symbol, timeframe, lastBarAt: null });
      sendTvSubscribe(symbol, timeframe);
      console.log(`[TV-WS] HTTP 구독 추가: ${key}`);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, key, subscriptions: subscriptions.size }));
  } else if (url.pathname === '/unsubscribe') {
    const symbol = url.searchParams.get('symbol');
    const timeframe = url.searchParams.get('timeframe');
    if (!symbol || !timeframe) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'symbol,timeframe required' }));
      return;
    }
    const key = `${symbol}:${timeframe}`;
    subscriptions.delete(key);
    latestBars.delete(key);
    staleSubscriptionsGauge.remove({ symbol, timeframe });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, key, subscriptions: subscriptions.size }));
  } else if (url.pathname === '/latest') {
    const symbols = (url.searchParams.get('symbols') || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const timeframes = (url.searchParams.get('timeframes') || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const now = Date.now();
    const rows = [...latestBars.values()].filter((item) => {
      if (symbols.length > 0 && !symbols.includes(item.symbol)) return false;
      if (timeframes.length > 0 && !timeframes.includes(item.timeframe)) return false;
      return true;
    }).map((item) => ({
      symbol: item.symbol,
      timeframe: item.timeframe,
      lastBarAt: item.lastBarAt,
      ageMs: item.lastBarAt ? Math.max(0, now - item.lastBarAt) : null,
      bar: item.bar,
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      tv_ws: tvWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      count: rows.length,
      bars: rows,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

metricsServer.listen(METRICS_PORT, () => {
  console.log(`[TV-WS] Prometheus 메트릭스: http://localhost:${METRICS_PORT}/metrics`);
});

// 시작
console.log(`[TV-WS] 클라이언트 WS 서버: ws://localhost:${TV_WS_PORT}`);
connectTradingView();
startStaleChecker();

// graceful shutdown
process.on('SIGTERM', () => {
  console.log('[TV-WS] SIGTERM 수신, 종료 중...');
  if (staleCheckTimer) clearInterval(staleCheckTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  tvWs?.close();
  wss.close();
  metricsServer.close();
  process.exit(0);
});

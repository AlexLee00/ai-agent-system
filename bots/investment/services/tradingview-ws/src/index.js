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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Registry, Gauge, Counter, collectDefaultMetrics } from 'prom-client';

const TV_WS_PORT = parseInt(process.env.TV_WS_PORT || '8082', 10);
const METRICS_PORT = parseInt(process.env.TV_METRICS_PORT || '8083', 10);
const STALE_THRESHOLD_MS = parseInt(process.env.TV_STALE_THRESHOLD_MS || '30000', 10);
const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const RECONNECT_DELAY_BASE_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RUNTIME_REEVAL_ENABLED = process.env.TV_RUNTIME_REEVAL_ENABLED === 'true';
const RUNTIME_REEVAL_PREFIX = process.env.TV_RUNTIME_REEVAL_PREFIX || '/Users/alexlee/projects/ai-agent-system/bots/investment';
const RUNTIME_REEVAL_COOLDOWN_MS = parseInt(process.env.TV_RUNTIME_REEVAL_COOLDOWN_MS || '45000', 10);
const RUNTIME_REEVAL_ACTIVE_ONLY = process.env.TV_RUNTIME_REEVAL_ACTIVE_ONLY === 'true';
const RUNTIME_REEVAL_TIMEFRAMES = String(process.env.TV_RUNTIME_REEVAL_TIMEFRAMES || '1h,4h')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const RUNTIME_REEVAL_TIMEFRAMES_BY_EXCHANGE = String(process.env.TV_RUNTIME_REEVAL_TIMEFRAMES_BY_EXCHANGE || '')
  .split(';')
  .map((item) => item.trim())
  .filter(Boolean)
  .reduce((acc, item) => {
    const [exchange, rawList] = item.split(':');
    if (!exchange || !rawList) return acc;
    acc[exchange.trim()] = rawList.split(',').map((value) => value.trim()).filter(Boolean);
    return acc;
  }, {});
const execFileAsync = promisify(execFile);

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
const seriesIds = new Map(); // key → TradingView series id

// TradingView 연결 (실제 환경에서는 TV WebSocket API)
// NOTE: TradingView WebSocket은 공식 API가 없어 dovudo 패턴의 비공개 프로토콜 사용
// 실제 배포 시 TV WS 인증 토큰/세션 필요
let tvWs = null;
const chartSessionId = `cs_luna_${Math.random().toString(36).slice(2, 10)}`;
let reconnectAttempts = 0;
let reconnectTimer = null;
let staleCheckTimer = null;
const runtimeReevalCooldowns = new Map();
const runtimeActiveScopeCache = new Map();

function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

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
    sendTvMessage({ m: 'set_auth_token', p: ['unauthorized_user_token'] });
    sendTvMessage({ m: 'chart_create_session', p: [chartSessionId, ''] });
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

function encodeTvFrame(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `~m~${text.length}~m~${text}`;
}

function sendTvMessage(payload) {
  if (!tvWs || tvWs.readyState !== WebSocket.OPEN) return false;
  tvWs.send(encodeTvFrame(payload));
  return true;
}

function decodeTvFrames(raw = '') {
  const frames = [];
  let offset = 0;
  const text = String(raw || '');
  while (offset < text.length) {
    const marker = text.indexOf('~m~', offset);
    if (marker < 0) break;
    const lengthStart = marker + 3;
    const lengthEnd = text.indexOf('~m~', lengthStart);
    if (lengthEnd < 0) break;
    const length = Number(text.slice(lengthStart, lengthEnd));
    if (!Number.isFinite(length) || length < 0) {
      offset = lengthEnd + 3;
      continue;
    }
    const payloadStart = lengthEnd + 3;
    const payload = text.slice(payloadStart, payloadStart + length);
    if (payload.length < length) break;
    frames.push(payload);
    offset = payloadStart + length;
  }
  return frames;
}

function sanitizeTvId(value = '') {
  const id = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return id.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'series';
}

function subscriptionKey(symbol, timeframe) {
  return `${symbol}:${timeframe}`;
}

function getSeriesId(symbol, timeframe) {
  const key = subscriptionKey(symbol, timeframe);
  if (!seriesIds.has(key)) {
    seriesIds.set(key, `sds_${sanitizeTvId(key)}`);
  }
  return seriesIds.get(key);
}

function getSymbolAlias(symbol, timeframe) {
  return `sym_${sanitizeTvId(subscriptionKey(symbol, timeframe))}`;
}

function handleTvMessage(raw) {
  // TradingView 메시지는 ~m~N~m~{json} 형식
  const frames = decodeTvFrames(raw);
  if (!frames.length) return;

  for (const jsonStr of frames) {
    if (jsonStr.startsWith('~h~')) {
      // heartbeat → pong
      const hbNum = jsonStr.slice(3);
      sendTvMessage(`~h~${hbNum}`);
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
    const bars = seriesData[getSeriesId(sub.symbol, sub.timeframe)]?.s;
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
      triggerRuntimeReevaluation(sub.symbol, sub.timeframe, barPayload).catch(() => {});
    }
  }
}

function inferRuntimeScope(tvSymbol = '') {
  if (!tvSymbol) return null;
  if (tvSymbol.startsWith('BINANCE:')) {
    const raw = tvSymbol.replace('BINANCE:', '');
    const normalized = raw.endsWith('USDT') ? `${raw.slice(0, -4)}/USDT` : raw;
    return { symbol: normalized, exchange: 'binance' };
  }
  if (tvSymbol.startsWith('KRX:')) {
    return { symbol: tvSymbol.replace('KRX:', ''), exchange: 'kis' };
  }
  if (/^(NASDAQ|NYSE|AMEX):/.test(tvSymbol)) {
    return { symbol: tvSymbol.split(':')[1] || null, exchange: 'kis_overseas' };
  }
  return null;
}

async function triggerRuntimeReevaluation(tvSymbol, timeframe, barPayload) {
  if (!RUNTIME_REEVAL_ENABLED) return;
  const scope = inferRuntimeScope(tvSymbol);
  if (!scope?.symbol || !scope?.exchange) return;
  const allowedTimeframes = RUNTIME_REEVAL_TIMEFRAMES_BY_EXCHANGE[scope.exchange] || RUNTIME_REEVAL_TIMEFRAMES;
  if (!allowedTimeframes.includes(String(timeframe || ''))) return;
  if (RUNTIME_REEVAL_ACTIVE_ONLY) {
    const active = await hasActiveRuntimeScope(scope);
    if (!active) return;
  }

  const key = `${scope.exchange}:${scope.symbol}:${timeframe}`;
  const now = Date.now();
  const previous = runtimeReevalCooldowns.get(key) || 0;
  if (now - previous < RUNTIME_REEVAL_COOLDOWN_MS) return;
  runtimeReevalCooldowns.set(key, now);

  try {
    const { stdout } = await execFileAsync('npm', [
      '--prefix',
      RUNTIME_REEVAL_PREFIX,
      'run',
      'runtime:position-reeval-event',
      '--',
      `--symbol=${scope.symbol}`,
      `--exchange=${scope.exchange}`,
      '--event-source=tradingview_ws',
      '--attention-type=tv_live_bar',
      `--attention-reason=${timeframe} bar update`,
      `--timeframe=${timeframe}`,
      '--json',
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 4,
    });
    console.log(`[TV-WS] runtime reevaluation ${key}: ${String(stdout || '').trim().slice(0, 240)}`);
  } catch (err) {
    console.warn(`[TV-WS] runtime reevaluation 실패 ${key}: ${err?.message || err}`);
  }
}

async function hasActiveRuntimeScope(scope) {
  const key = `${scope.exchange}:${scope.symbol}`;
  const cached = runtimeActiveScopeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < 60_000) return cached.active;
  try {
    const { stdout } = await execFileAsync('npm', [
      '--prefix',
      RUNTIME_REEVAL_PREFIX,
      'run',
      'runtime:position-runtime',
      '--',
      `--exchange=${scope.exchange}`,
      `--symbol=${scope.symbol}`,
      '--limit=10',
      '--json',
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 4,
    });
    const parsed = extractJsonObject(stdout) || {};
    const active = Array.isArray(parsed?.rows)
      ? parsed.rows.some((row) => row?.symbol === scope.symbol && row?.exchange === scope.exchange && row?.runtimeState)
      : false;
    runtimeActiveScopeCache.set(key, { checkedAt: now, active });
    return active;
  } catch (err) {
    console.warn(`[TV-WS] active runtime scope 확인 실패 ${key}: ${err?.message || err}`);
    runtimeActiveScopeCache.set(key, { checkedAt: now, active: false });
    return false;
  }
}

function sendTvSubscribe(symbol, timeframe) {
  if (!tvWs || tvWs.readyState !== WebSocket.OPEN) return;
  const symbolAlias = getSymbolAlias(symbol, timeframe);
  const seriesId = getSeriesId(symbol, timeframe);
  const symbolPayload = `=${JSON.stringify({
    symbol,
    adjustment: 'splits',
    session: 'regular',
  })}`;
  sendTvMessage({ m: 'resolve_symbol', p: [chartSessionId, symbolAlias, symbolPayload] });
  sendTvMessage({ m: 'create_series', p: [chartSessionId, seriesId, 's1', symbolAlias, timeframe, 300, ''] });
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
      const lastSeenAt = sub.lastBarAt || sub.subscribedAt || 0;
      if (lastSeenAt && now - lastSeenAt > STALE_THRESHOLD_MS) {
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
          subscriptions.set(key, { symbol: msg.symbol, timeframe: msg.timeframe, subscribedAt: Date.now(), lastBarAt: null });
          sendTvSubscribe(msg.symbol, msg.timeframe);
          console.log(`[TV-WS] 구독 추가: ${key}`);
        }
        ws.send(JSON.stringify({ ok: true, action: 'subscribed', key }));
      } else if (msg.action === 'unsubscribe' && msg.symbol && msg.timeframe) {
        const key = `${msg.symbol}:${msg.timeframe}`;
        subscriptions.delete(key);
        latestBars.delete(key);
        seriesIds.delete(key);
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
      bars: latestBars.size,
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
      subscriptions.set(key, { symbol, timeframe, subscribedAt: Date.now(), lastBarAt: null });
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
    seriesIds.delete(key);
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

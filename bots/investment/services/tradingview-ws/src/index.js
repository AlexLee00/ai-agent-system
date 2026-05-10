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
const STALE_GRACE_MS = parseInt(process.env.TV_STALE_GRACE_MS || String(5 * 60 * 1000), 10);
const INITIAL_BAR_TIMEOUT_MS = parseInt(process.env.TV_INITIAL_BAR_TIMEOUT_MS || String(2 * 60 * 1000), 10);
const RESUBSCRIBE_COOLDOWN_MS = parseInt(process.env.TV_RESUBSCRIBE_COOLDOWN_MS || String(2 * 60 * 1000), 10);
const BINANCE_REST_FALLBACK_ENABLED = process.env.TV_BINANCE_REST_FALLBACK_ENABLED !== 'false';
const MAX_SUBSCRIPTIONS = parseInt(process.env.TV_MAX_SUBSCRIPTIONS || '24', 10);
const MAX_STALE_STRIKES = parseInt(process.env.TV_MAX_STALE_STRIKES || '3', 10);
const HTTP_SUBSCRIPTION_TTL_MS = parseInt(process.env.TV_HTTP_SUBSCRIPTION_TTL_MS || String(10 * 60 * 1000), 10);
const STALE_LOG_COOLDOWN_MS = parseInt(process.env.TV_STALE_LOG_COOLDOWN_MS || String(5 * 60 * 1000), 10);
const STALE_FORCE_RECONNECT_COOLDOWN_MS = parseInt(process.env.TV_STALE_FORCE_RECONNECT_COOLDOWN_MS || String(5 * 60 * 1000), 10);
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
const DEFAULT_SUBSCRIPTIONS = String(process.env.TV_DEFAULT_SUBSCRIPTIONS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [symbol, timeframe] = item.split('|').map((value) => value?.trim());
    return symbol && timeframe ? { symbol, timeframe } : null;
  })
  .filter(Boolean);
const DEFAULT_SUBSCRIPTION_KEYS = new Set(DEFAULT_SUBSCRIPTIONS.map((item) => subscriptionKey(item.symbol, item.timeframe)));
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
let nextClientId = 1;

// TradingView 연결 (실제 환경에서는 TV WebSocket API)
// NOTE: TradingView WebSocket은 공식 API가 없어 dovudo 패턴의 비공개 프로토콜 사용
// 실제 배포 시 TV WS 인증 토큰/세션 필요
let tvWs = null;
const chartSessionId = `cs_luna_${Math.random().toString(36).slice(2, 10)}`;
let reconnectAttempts = 0;
let reconnectTimer = null;
let staleCheckTimer = null;
let lastStaleForceReconnectAt = 0;
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

function isTradingViewRealtimeBar(item = {}) {
  const source = String(item.source || 'tradingview_ws_service');
  const providerMode = String(item.providerMode || 'websocket_http_latest');
  return source === 'tradingview_ws_service'
    && providerMode.includes('websocket')
    && !item.fallbackReason;
}

function removeSubscription(key, reason = 'removed') {
  const sub = subscriptions.get(key);
  if (!sub) return false;
  sendTvUnsubscribe(sub.symbol, sub.timeframe);
  subscriptions.delete(key);
  latestBars.delete(key);
  seriesIds.delete(key);
  staleSubscriptionsGauge.remove({ symbol: sub.symbol, timeframe: sub.timeframe });
  console.log(`[TV-WS] 구독 제거: ${key} (${reason})`);
  return true;
}

function pruneSubscriptionsIfNeeded(nextKey = null) {
  const max = Math.max(DEFAULT_SUBSCRIPTION_KEYS.size || 1, Number(MAX_SUBSCRIPTIONS || 24));
  if (subscriptions.size < max) return [];
  const removable = [...subscriptions.entries()]
    .filter(([key, sub]) => key !== nextKey && !sub.protected)
    .sort((left, right) => {
      const [, a] = left;
      const [, b] = right;
      const aDaily = String(a.timeframe).toUpperCase() === 'D' ? 1 : 0;
      const bDaily = String(b.timeframe).toUpperCase() === 'D' ? 1 : 0;
      if (aDaily !== bDaily) return bDaily - aDaily;
      if ((a.staleStrikes || 0) !== (b.staleStrikes || 0)) return (b.staleStrikes || 0) - (a.staleStrikes || 0);
      return (a.lastBarAt || a.subscribedAt || 0) - (b.lastBarAt || b.subscribedAt || 0);
    });
  const removed = [];
  while (subscriptions.size >= max && removable.length > 0) {
    const [key] = removable.shift();
    if (removeSubscription(key, 'max_subscription_prune')) removed.push(key);
  }
  return removed;
}

function resolveSubscriptionTtlMs(source, options = {}) {
  if (Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0) return Number(options.ttlMs);
  if (source === 'HTTP') return Math.max(30_000, Number(HTTP_SUBSCRIPTION_TTL_MS || 0));
  return 0;
}

function addSubscriptionOwner(sub, ownerId) {
  if (!ownerId) return;
  if (!sub.owners) sub.owners = new Set();
  sub.owners.add(ownerId);
}

function removeSubscriptionOwner(key, ownerId, reason = 'client_closed') {
  if (!ownerId) return false;
  const sub = subscriptions.get(key);
  if (!sub?.owners) return false;
  sub.owners.delete(ownerId);
  if (sub.protected || sub.owners.size > 0) return false;
  return removeSubscription(key, reason);
}

function timeframeDurationMs(timeframe) {
  const text = String(timeframe || '').trim().toLowerCase();
  if (text === 'd' || text === '1d') return 24 * 60 * 60 * 1000;
  if (text === 'w' || text === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (text.endsWith('h')) return Math.max(1, Number(text.slice(0, -1)) || 1) * 60 * 60 * 1000;
  if (text.endsWith('m')) return Math.max(1, Number(text.slice(0, -1)) || 1) * 60 * 1000;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric * 60 * 1000 : 60 * 60 * 1000;
}

function staleThresholdFor(sub) {
  if (!sub.lastBarAt) {
    return Math.max(STALE_THRESHOLD_MS, INITIAL_BAR_TIMEOUT_MS, timeframeDurationMs(sub.timeframe) + STALE_GRACE_MS);
  }
  return Math.max(STALE_THRESHOLD_MS, timeframeDurationMs(sub.timeframe) + STALE_GRACE_MS);
}

function binanceIntervalForTimeframe(timeframe) {
  const text = String(timeframe || '60').trim().toLowerCase();
  if (text === 'd' || text === '1d') return '1d';
  if (text === 'w' || text === '1w') return '1w';
  if (text.endsWith('h')) return `${Math.max(1, Number(text.slice(0, -1)) || 1)}h`;
  if (text.endsWith('m')) return `${Math.max(1, Number(text.slice(0, -1)) || 1)}m`;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0) return '1h';
  if (minutes % 60 === 0) return `${Math.max(1, minutes / 60)}h`;
  return `${minutes}m`;
}

function binanceSymbolFromTradingView(symbol) {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text.startsWith('BINANCE:')) return null;
  const raw = text.replace('BINANCE:', '').replace(/[^A-Z0-9]/g, '');
  return raw.endsWith('USDT') ? raw : null;
}

async function fetchBinanceRestFallbackBar(symbol, timeframe) {
  if (!BINANCE_REST_FALLBACK_ENABLED) return null;
  const binanceSymbol = binanceSymbolFromTradingView(symbol);
  if (!binanceSymbol) return null;
  const interval = binanceIntervalForTimeframe(timeframe);
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', binanceSymbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', '1');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[rows.length - 1] : null;
    if (!Array.isArray(row)) return null;
    const bar = {
      symbol,
      timeframe,
      timestamp: Number(row[0] || 0),
      open: Number(row[1] || 0),
      high: Number(row[2] || 0),
      low: Number(row[3] || 0),
      close: Number(row[4] || 0),
      volume: Number(row[5] || 0),
    };
    if (!(bar.close > 0)) return null;
    return {
      symbol,
      timeframe,
      lastBarAt: Date.now(),
      ageMs: Math.max(0, Date.now() - Number(row[6] || row[0] || Date.now())),
      source: 'tradingview_ws_service_binance_rest_fallback',
      providerMode: 'binance_rest_live_fallback',
      fallbackReason: 'tradingview_ws_latest_empty',
      bar,
    };
  } catch {
    return null;
  }
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

function addSubscription(symbol, timeframe, source = 'api', options = {}) {
  const key = subscriptionKey(symbol, timeframe);
  const now = Date.now();
  const ttlMs = resolveSubscriptionTtlMs(source, options);
  if (!subscriptions.has(key)) {
    pruneSubscriptionsIfNeeded(key);
    const sub = {
      symbol,
      timeframe,
      subscribedAt: now,
      lastRequestedAt: now,
      lastBarAt: null,
      lastResubscribeAt: 0,
      lastStaleLogAt: 0,
      staleStrikes: 0,
      protected: source === 'default' || DEFAULT_SUBSCRIPTION_KEYS.has(key),
      source,
      expiresAt: ttlMs > 0 ? now + ttlMs : null,
      owners: new Set(),
    };
    addSubscriptionOwner(sub, options.ownerId);
    subscriptions.set(key, sub);
    sendTvSubscribe(symbol, timeframe);
    console.log(`[TV-WS] ${source} 구독 추가: ${key}`);
  } else {
    const sub = subscriptions.get(key);
    sub.lastRequestedAt = now;
    sub.source = sub.source || source;
    if (ttlMs > 0 && !sub.protected) sub.expiresAt = Math.max(Number(sub.expiresAt || 0), now + ttlMs);
    addSubscriptionOwner(sub, options.ownerId);
  }
  return key;
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
      sub.staleStrikes = 0;
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

function sendTvUnsubscribe(symbol, timeframe) {
  if (!tvWs || tvWs.readyState !== WebSocket.OPEN) return;
  const seriesId = getSeriesId(symbol, timeframe);
  sendTvMessage({ m: 'remove_series', p: [chartSessionId, seriesId] });
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

function forceTradingViewReconnect(reason = 'stale_protected_subscription') {
  const now = Date.now();
  if (lastStaleForceReconnectAt && now - lastStaleForceReconnectAt < STALE_FORCE_RECONNECT_COOLDOWN_MS) return false;
  lastStaleForceReconnectAt = now;
  recoveryAttemptsCounter.inc({ type: 'force_reconnect' });
  console.warn(`[TV-WS] TradingView 세션 강제 재연결: ${reason}`);
  try {
    if (tvWs && tvWs.readyState === WebSocket.OPEN) tvWs.close(4000, reason);
    else scheduleReconnect();
  } catch (_) {
    scheduleReconnect();
  }
  return true;
}

function startStaleChecker() {
  staleCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, sub] of subscriptions.entries()) {
      if (!sub.protected && sub.expiresAt && now > sub.expiresAt && (!sub.owners || sub.owners.size === 0)) {
        removeSubscription(key, 'subscription_ttl_expired');
        recoveryAttemptsCounter.inc({ type: 'evict_expired' });
        continue;
      }
      const lastSeenAt = sub.lastBarAt || sub.subscribedAt || 0;
      if (lastSeenAt && now - lastSeenAt > staleThresholdFor(sub)) {
        if (sub.lastResubscribeAt && now - sub.lastResubscribeAt < RESUBSCRIBE_COOLDOWN_MS) {
          continue;
        }
        if (!sub.lastStaleLogAt || now - sub.lastStaleLogAt > STALE_LOG_COOLDOWN_MS) {
          console.warn(`[TV-WS] Stale 구독 감지: ${key}`);
          sub.lastStaleLogAt = now;
        }
        staleSubscriptionsGauge.set({ symbol: sub.symbol, timeframe: sub.timeframe }, 1);
        // 개별 재구독 시도
        sub.lastResubscribeAt = now;
        sub.staleStrikes = (sub.staleStrikes || 0) + 1;
        if (sub.protected && sub.staleStrikes >= Math.max(1, MAX_STALE_STRIKES)) {
          forceTradingViewReconnect(`protected_stale_strikes_${sub.staleStrikes}:${key}`);
          recoveryAttemptsCounter.inc({ type: 'protected_stale_reconnect' });
          continue;
        }
        if (!sub.protected && sub.staleStrikes >= Math.max(1, MAX_STALE_STRIKES)) {
          removeSubscription(key, `stale_strikes_${sub.staleStrikes}`);
          recoveryAttemptsCounter.inc({ type: 'evict_stale' });
          continue;
        }
        sendTvSubscribe(sub.symbol, sub.timeframe);
        recoveryAttemptsCounter.inc({ type: 'resubscribe' });
      }
    }
  }, 10_000);
}

function healthPayload() {
  const now = Date.now();
  const bars = [...latestBars.values()];
  const staleRows = [...subscriptions.entries()].filter(([, sub]) => {
    const lastSeenAt = sub.lastBarAt || sub.subscribedAt || 0;
    return lastSeenAt && now - lastSeenAt > staleThresholdFor(sub);
  }).map(([key, sub]) => ({
    key,
    symbol: sub.symbol,
    timeframe: sub.timeframe,
    protected: Boolean(sub.protected),
    staleStrikes: sub.staleStrikes || 0,
    ageMs: Math.max(0, now - (sub.lastBarAt || sub.subscribedAt || now)),
  }));
  const fallbackBars = bars.filter((item) => !isTradingViewRealtimeBar(item));
  const realtimeBars = bars.filter((item) => isTradingViewRealtimeBar(item));
  const tvStatus = tvWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
  return {
    status: 'ok',
    tv_ws: tvStatus,
    realtimeOk: tvStatus === 'connected' && realtimeBars.length > 0 && staleRows.length === 0,
    subscriptions: subscriptions.size,
    bars: latestBars.size,
    realtimeBars: realtimeBars.length,
    fallbackBars: fallbackBars.length,
    staleSubscriptions: staleRows.length,
    maxSubscriptions: Math.max(DEFAULT_SUBSCRIPTION_KEYS.size || 1, Number(MAX_SUBSCRIPTIONS || 24)),
    expiringSubscriptions: [...subscriptions.values()].filter((sub) => sub.expiresAt && !sub.protected).length,
    clients: clientSockets.size,
    staleDetails: staleRows.slice(0, 10),
  };
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
  const ownerId = `client-${nextClientId++}`;
  const ownedKeys = new Set();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === 'subscribe' && msg.symbol && msg.timeframe) {
        const key = addSubscription(msg.symbol, msg.timeframe, 'client', { ownerId });
        ownedKeys.add(key);
        ws.send(JSON.stringify({ ok: true, action: 'subscribed', key }));
      } else if (msg.action === 'unsubscribe' && msg.symbol && msg.timeframe) {
        const key = `${msg.symbol}:${msg.timeframe}`;
        ownedKeys.delete(key);
        if (!removeSubscriptionOwner(key, ownerId, 'client_unsubscribe')) {
          const sub = subscriptions.get(key);
          if (sub && !sub.protected && (!sub.owners || sub.owners.size === 0)) removeSubscription(key, 'client_unsubscribe');
        }
        ws.send(JSON.stringify({ ok: true, action: 'unsubscribed', key }));
      } else if (msg.action === 'list') {
        ws.send(JSON.stringify({ ok: true, subscriptions: [...subscriptions.keys()] }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  const cleanupClient = () => {
    clientSockets.delete(ws);
    for (const key of ownedKeys) {
      removeSubscriptionOwner(key, ownerId, 'client_closed');
    }
    ownedKeys.clear();
  };
  ws.on('close', cleanupClient);
  ws.on('error', cleanupClient);

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
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(healthPayload()));
  } else if (url.pathname === '/reconnect') {
    const reason = url.searchParams.get('reason') || 'http_reconnect';
    const forced = forceTradingViewReconnect(reason);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: forced,
      status: forced ? 'tradingview_reconnect_requested' : 'tradingview_reconnect_cooldown',
      reason,
      health: healthPayload(),
    }));
  } else if (url.pathname === '/subscribe') {
    const symbol = url.searchParams.get('symbol');
    const timeframe = url.searchParams.get('timeframe');
    if (!symbol || !timeframe) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'symbol,timeframe required' }));
      return;
    }
    const ttlMs = Number(url.searchParams.get('ttlMs') || 0) || undefined;
    const key = addSubscription(symbol, timeframe, 'HTTP', { ttlMs });
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
    removeSubscription(key, 'http_unsubscribe');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, key, subscriptions: subscriptions.size }));
  } else if (url.pathname === '/latest') {
    const requireReal = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('requireReal') || '').toLowerCase());
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
      if (requireReal && !isTradingViewRealtimeBar(item)) return false;
      return true;
    }).map((item) => ({
      symbol: item.symbol,
      timeframe: item.timeframe,
      lastBarAt: item.lastBarAt,
      ageMs: item.lastBarAt ? Math.max(0, now - item.lastBarAt) : null,
      source: item.source || 'tradingview_ws_service',
      providerMode: item.providerMode || 'websocket_http_latest',
      fallbackReason: item.fallbackReason || null,
      bar: item.bar,
    }));
    const requested = [];
    for (const symbol of symbols) {
      for (const timeframe of timeframes.length > 0 ? timeframes : ['60']) {
        requested.push({ symbol, timeframe });
      }
    }
    const existing = new Set(rows.map((item) => `${item.symbol}:${item.timeframe}`));
    for (const item of requested) {
      const key = subscriptionKey(item.symbol, item.timeframe);
      if (existing.has(key)) {
        if (requireReal) continue;
        const rowIndex = rows.findIndex((row) => subscriptionKey(row.symbol, row.timeframe) === key);
        const current = rowIndex >= 0 ? rows[rowIndex] : null;
        const sub = subscriptions.get(key) || { timeframe: item.timeframe, lastBarAt: current?.lastBarAt };
        const ageMs = current?.lastBarAt ? Math.max(0, now - current.lastBarAt) : null;
        const stale = Number.isFinite(ageMs) && ageMs > staleThresholdFor(sub);
        if (!stale || !isTradingViewRealtimeBar(current)) continue;
        const fallback = await fetchBinanceRestFallbackBar(item.symbol, item.timeframe);
        if (!fallback) continue;
        fallback.fallbackReason = 'tradingview_ws_latest_stale';
        latestBars.set(key, {
          symbol: item.symbol,
          timeframe: item.timeframe,
          lastBarAt: fallback.lastBarAt,
          source: fallback.source,
          providerMode: fallback.providerMode,
          fallbackReason: fallback.fallbackReason,
          bar: fallback.bar,
        });
        rows[rowIndex] = fallback;
        continue;
      }
      if (requireReal) continue;
      const fallback = await fetchBinanceRestFallbackBar(item.symbol, item.timeframe);
      if (!fallback) continue;
      const sub = subscriptions.get(key);
      if (sub) {
        sub.lastBarAt = fallback.lastBarAt;
        sub.staleStrikes = 0;
      }
      latestBars.set(key, {
        symbol: item.symbol,
        timeframe: item.timeframe,
        lastBarAt: fallback.lastBarAt,
        source: fallback.source,
        providerMode: fallback.providerMode,
        fallbackReason: fallback.fallbackReason,
        bar: fallback.bar,
      });
      rows.push(fallback);
      existing.add(key);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      tv_ws: tvWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      requireReal,
      realtimeOk: tvWs?.readyState === WebSocket.OPEN && rows.some((item) => isTradingViewRealtimeBar(item)),
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
for (const { symbol, timeframe } of DEFAULT_SUBSCRIPTIONS) {
  addSubscription(symbol, timeframe, 'default');
}
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

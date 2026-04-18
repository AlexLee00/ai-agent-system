/**
 * shared/kis-ws-client.js
 * KIS (한국투자증권) WebSocket 클라이언트
 *
 * 국내: H0STCNT0 (실시간 체결), H0STASP0 (실시간 호가)
 * 국외: HDFSCNT0 (실시간 체결), HDFSASP0 (실시간 호가)
 *
 * Kill Switch: LUNA_KIS_WS_ENABLED=true
 *              KIS_MARKET=domestic|overseas (기본 domestic)
 *
 * 토픽 (JayBus):
 *   luna.kis.tick.{symbol}    체결 tick
 *   luna.kis.quote.{symbol}   호가
 */

import { WebSocket } from 'ws';

const WS_URL_LIVE = 'wss://openapi.koreainvestment.com:9443';
const WS_URL_MOCK = 'wss://openapivts.koreainvestment.com:31000';

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const KIS_MARKET = process.env.KIS_MARKET || 'domestic'; // domestic | overseas
const KIS_MODE = process.env.KIS_MODE || 'live';         // live | mock

// 국내/국외 TR ID
const TR_IDS = {
  domestic: {
    trade:  'H0STCNT0',  // 국내 실시간 체결
    quote:  'H0STASP0',  // 국내 실시간 호가
  },
  overseas: {
    trade:  'HDFSCNT0',  // 해외 실시간 체결
    quote:  'HDFSASP0',  // 해외 실시간 호가
  },
};

export class KISWebSocketClient {
  constructor(market = KIS_MARKET, mode = KIS_MODE) {
    this.market = market;
    this.wsUrl = mode === 'mock' ? WS_URL_MOCK : WS_URL_LIVE;
    this.ws = null;
    this.approvalKey = null;
    this.subscriptions = new Map(); // key → { trId, symbol }
    this.reconnectAttempts = 0;
    this.maxReconnect = 10;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  async connect() {
    this.approvalKey = await this._getApprovalKey();
    if (!this.approvalKey) {
      console.error(`[KIS-WS-${this.market.toUpperCase()}] approval key 획득 실패`);
      return;
    }

    console.log(`[KIS-WS-${this.market.toUpperCase()}] 연결: ${this.wsUrl}`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log(`[KIS-WS-${this.market.toUpperCase()}] 연결됨`);
      this.reconnectAttempts = 0;
      // 재구독
      for (const { trId, symbol } of this.subscriptions.values()) {
        this._sendSubscribe(trId, symbol, true);
      }
      // 30초 PINGPONG
      this.pingTimer = setInterval(() => this._sendPing(), 30_000);
    });

    this.ws.on('message', (raw) => {
      this._handleMessage(raw.toString());
    });

    this.ws.on('close', () => {
      console.warn(`[KIS-WS-${this.market.toUpperCase()}] 연결 끊김`);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[KIS-WS-${this.market.toUpperCase()}] 오류:`, err.message);
    });
  }

  subscribe(symbol) {
    const trIds = TR_IDS[this.market];
    for (const [type, trId] of Object.entries(trIds)) {
      const key = `${trId}:${symbol}`;
      this.subscriptions.set(key, { trId, symbol, type });
      this._sendSubscribe(trId, symbol, true);
    }
    console.log(`[KIS-WS-${this.market.toUpperCase()}] 구독: ${symbol}`);
  }

  unsubscribe(symbol) {
    const trIds = TR_IDS[this.market];
    for (const [, trId] of Object.entries(trIds)) {
      const key = `${trId}:${symbol}`;
      this.subscriptions.delete(key);
      this._sendSubscribe(trId, symbol, false);
    }
  }

  _sendSubscribe(trId, symbol, register = true) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: 'P',
        tr_type: register ? '1' : '2',  // 1=등록, 2=해제
        'content-type': 'utf-8',
      },
      body: {
        input: { tr_id: trId, tr_key: symbol },
      },
    });
    this.ws.send(msg);
  }

  _sendPing() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
  }

  _handleMessage(raw) {
    // KIS: pipe(|) CSV 형식 또는 JSON
    if (raw.startsWith('0|') || raw.startsWith('1|')) {
      this._handleCsv(raw);
    } else {
      try {
        const msg = JSON.parse(raw);
        this._handleJson(msg);
      } catch (_) { /* ignore */ }
    }
  }

  _handleCsv(raw) {
    const [, trId, , ...fields] = raw.split('|');

    if (trId === 'H0STCNT0') {
      // 국내 체결: 종목코드|시간|현재가|체결량|...
      const [symbol, time, price, volume] = fields;
      this._publishTick(symbol, parseFloat(price), parseInt(volume, 10), time);
    } else if (trId === 'HDFSCNT0') {
      // 해외 체결
      const [symbol, , , price, volume, time] = fields;
      this._publishTick(symbol, parseFloat(price), parseInt(volume, 10), time);
    } else if (trId === 'H0STASP0' || trId === 'HDFSASP0') {
      // 호가
      const [symbol, time, askPrice1, bidPrice1] = fields;
      this._publishQuote(symbol, parseFloat(askPrice1), parseFloat(bidPrice1), time);
    }
  }

  _handleJson(msg) {
    const trId = msg.header?.tr_id;
    if (trId === 'PINGPONG') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    }
    // 구독 확인 응답 등 — 로그만
    if (msg.body?.rt_cd === '0') {
      console.log(`[KIS-WS-${this.market.toUpperCase()}] 구독 확인:`, msg.body?.msg1);
    }
  }

  _publishTick(symbol, price, volume, timestamp) {
    const payload = { symbol, price, volume, timestamp, market: this.market };
    publishToHub(`luna.kis.tick.${symbol}`, payload);
  }

  _publishQuote(symbol, askPrice, bidPrice, timestamp) {
    const payload = { symbol, askPrice, bidPrice, timestamp, market: this.market };
    publishToHub(`luna.kis.quote.${symbol}`, payload);
  }

  async _getApprovalKey() {
    // Hub secrets에서 KIS 앱 키 로드
    try {
      const res = await fetch(`${HUB_BASE}/hub/secrets`, {
        headers: { 'Authorization': `Bearer ${HUB_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Hub secrets 실패: ${res.status}`);
      const secrets = await res.json();
      const appKey = secrets?.investment?.KIS_APP_KEY || process.env.KIS_APP_KEY;
      const appSecret = secrets?.investment?.KIS_APP_SECRET || process.env.KIS_APP_SECRET;

      if (!appKey || !appSecret) {
        console.warn('[KIS-WS] KIS_APP_KEY/SECRET 없음 — approval key 없이 진행 불가');
        return null;
      }

      // WebSocket approval key 발급
      const apiBase = KIS_MODE === 'mock'
        ? 'https://openapivts.koreainvestment.com:29443'
        : 'https://openapi.koreainvestment.com:9443';

      const keyRes = await fetch(`${apiBase}/oauth2/Approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
      });
      if (!keyRes.ok) throw new Error(`approval key 발급 실패: ${keyRes.status}`);
      const { approval_key } = await keyRes.json();
      return approval_key;
    } catch (err) {
      console.error('[KIS-WS] approval key 오류:', err.message);
      return null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnect) {
      console.error(`[KIS-WS-${this.market.toUpperCase()}] 최대 재연결 초과`);
      return;
    }
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
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
        source: 'luna.kis',
        topic,
        payload,
        timestamp: Date.now(),
      }),
    });
  } catch (_) { /* Hub 실패 무시 */ }
}

// 독립 실행 진입점
if (process.env.LUNA_KIS_WS_ENABLED === 'true') {
  const market = KIS_MARKET;
  const symbols = (process.env.KIS_WS_SYMBOLS || '').split(',').filter(Boolean);

  if (symbols.length === 0) {
    console.warn('[KIS-WS] KIS_WS_SYMBOLS 없음 — 구독 심볼 없이 대기');
  }

  const client = new KISWebSocketClient(market);
  await client.connect();

  for (const symbol of symbols) {
    client.subscribe(symbol.trim());
  }

  process.on('SIGTERM', () => {
    client.disconnect();
    process.exit(0);
  });
} else {
  console.log('[KIS-WS] Kill Switch OFF (LUNA_KIS_WS_ENABLED=true 로 활성화)');
}

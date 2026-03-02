'use strict';

/**
 * lib/telegram.js — 투자봇 텔레그램 알림
 *
 * reservation 봇의 패턴 재사용.
 * 드라이런 신호/주문/에러를 텔레그램으로 발송.
 */

const https = require('https');
const { loadSecrets } = require('./secrets');

const SECRETS = loadSecrets();
const BOT_TOKEN = SECRETS.telegram_bot_token;
const DEFAULT_CHAT_ID = SECRETS.telegram_chat_id;

// ── 팀 이름 (변경 시 이 상수만 수정)
const TEAM_NAME = '루나팀';
const PREFIX = `📈 ${TEAM_NAME}`;

function tryTelegramSend(message, chatId = DEFAULT_CHAT_ID) {
  if (!BOT_TOKEN) {
    console.log(`[텔레그램 토큰 없음] ${message.slice(0, 80)}`);
    return Promise.resolve(false);
  }
  if (process.env.TELEGRAM_ENABLED === '0') return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      const text = `${PREFIX}\n\n${message}`;
      const body = Buffer.from(JSON.stringify({ chat_id: chatId, text }));
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${BOT_TOKEN}/sendMessage`,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(raw);
            if (!r.ok) console.warn(`⚠️ 텔레그램 API 오류: ${r.description || raw.slice(0, 80)}`);
            resolve(r.ok === true);
          } catch { resolve(false); }
        });
      });
      req.on('error', (e) => { console.warn(`⚠️ 텔레그램 오류: ${e.message}`); resolve(false); });
      req.setTimeout(10000, () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    } catch (e) { console.warn(`⚠️ 텔레그램 예외: ${e.message}`); resolve(false); }
  });
}

async function sendTelegram(message, chatId = DEFAULT_CHAT_ID) {
  if (process.env.TELEGRAM_ENABLED === '0') {
    console.log(`[텔레그램 비활성] ${message.slice(0, 60)}`);
    return true;
  }
  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    if (await tryTelegramSend(message, chatId)) {
      console.log(`📱 [텔레그램] 발송${i > 1 ? ` (${i}번째)` : ''}: ${message.slice(0, 50)}`);
      return true;
    }
    if (i < MAX_TRIES) await new Promise(r => setTimeout(r, i * 2000));
  }
  console.error(`❌ 텔레그램 최종 실패`);
  return false;
}

// ─── 투자봇 전용 포매터 ────────────────────────────────────────────

function notifySignal({ symbol, action, amountUsdt, confidence, reasoning, dryRun }) {
  const tag = dryRun ? '[드라이런] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg = [
    `${tag}${emoji} ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sendTelegram(msg);
}

function notifyTrade({ symbol, side, amount, price, totalUsdt, dryRun }) {
  const tag = dryRun ? '[드라이런] ' : '';
  const emoji = side === 'buy' ? '✅ 매수' : '✅ 매도';
  const msg = [
    `${tag}${emoji} 체결 — ${symbol}`,
    `수량: ${amount?.toFixed(6)} / 가격: $${price?.toLocaleString()}`,
    `총액: $${totalUsdt?.toFixed(2)}`,
  ].join('\n');
  return sendTelegram(msg);
}

function notifyError(context, error) {
  const msg = `❌ [오류] ${context}\n${error?.message || error}`;
  return sendTelegram(msg);
}

function notifyRiskRejection({ symbol, action, reason }) {
  const msg = `🚫 [리스크 거부] ${action} ${symbol}\n사유: ${reason}`;
  return sendTelegram(msg);
}

// ─── KIS 전용 포매터 (원화 단위) ──────────────────────────────────

function notifyKisSignal({ symbol, action, amountUsdt: amountKrw, confidence, reasoning, dryRun }) {
  const tag = dryRun ? '[드라이런] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg = [
    `${tag}${emoji} [KIS] ${action} 신호 — ${symbol}`,
    `금액: ${amountKrw?.toLocaleString()}원`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sendTelegram(msg);
}

function notifyKisTrade({ symbol, side, qty, price, totalKrw, dryRun }) {
  const tag = dryRun ? '[드라이런] ' : '';
  const emoji = side === 'buy' ? '✅ 매수' : '✅ 매도';
  const msg = [
    `${tag}${emoji} [KIS] 체결 — ${symbol}`,
    `수량: ${qty}주 / 가격: ${price?.toLocaleString()}원`,
    `총액: ${totalKrw?.toLocaleString()}원`,
  ].join('\n');
  return sendTelegram(msg);
}

module.exports = {
  sendTelegram,
  notifySignal, notifyTrade, notifyError, notifyRiskRejection,
  notifyKisSignal, notifyKisTrade,
};

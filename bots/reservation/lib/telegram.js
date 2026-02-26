/**
 * lib/telegram.js — Telegram Bot API 직접 발송 모듈
 *
 * openclaw agent --deliver를 사용하지 않고 Telegram Bot API를 직접 호출.
 * openclaw는 사용자 ↔ 스카 대화용, 단방향 알림은 Bot API 직접 사용.
 */

const https = require('https');
const { loadSecrets } = require('./secrets');
const { log } = require('./utils');

const SECRETS = loadSecrets();
const BOT_TOKEN = SECRETS.telegram_bot_token;
const DEFAULT_CHAT_ID = SECRETS.telegram_chat_id;

/**
 * Telegram Bot API로 메시지 1회 전송 시도
 * @returns {Promise<boolean>} 성공 여부
 */
function tryTelegramSend(message, chatId = DEFAULT_CHAT_ID) {
  if (process.env.TELEGRAM_ENABLED === '0') return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      const text = `🔔 스카봇\n\n${message}`;
      const body = Buffer.from(JSON.stringify({ chat_id: chatId, text }));
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(raw);
            if (!r.ok) log(`⚠️ 텔레그램 API 오류: ${r.description || raw.slice(0, 80)}`);
            resolve(r.ok === true);
          } catch { resolve(false); }
        });
      });
      req.on('error', (e) => { log(`⚠️ 텔레그램 요청 오류: ${e.message}`); resolve(false); });
      req.setTimeout(10000, () => { req.destroy(); log('⏱️ 텔레그램 발송 타임아웃'); resolve(false); });
      req.write(body);
      req.end();
    } catch (e) { log(`⚠️ 텔레그램 발송 예외: ${e.message}`); resolve(false); }
  });
}

/**
 * 텔레그램 메시지 발송 — 3회 재시도
 * @param {string} message  발송할 메시지 본문
 * @param {string} [chatId] 수신자 chat_id (기본: secrets.telegram_chat_id)
 * @returns {Promise<boolean>}
 */
async function sendTelegram(message, chatId = DEFAULT_CHAT_ID) {
  if (process.env.TELEGRAM_ENABLED === '0') {
    log(`[텔레그램 비활성화] ${message.slice(0, 60)}`);
    return true;
  }
  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    if (await tryTelegramSend(message, chatId)) {
      log(`📱 [텔레그램] 발송 성공${i > 1 ? ` (${i}번째 시도)` : ''}: ${message.slice(0, 50)}`);
      return true;
    }
    if (i < MAX_TRIES) {
      log(`⚠️ 텔레그램 발송 실패 (${i}/${MAX_TRIES}), ${i * 3}초 후 재시도...`);
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
  log(`❌ 텔레그램 발송 최종 실패 (${MAX_TRIES}회)`);
  return false;
}

module.exports = { sendTelegram, tryTelegramSend };

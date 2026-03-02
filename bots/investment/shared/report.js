'use strict';

/**
 * shared/report.js — 루나팀 텔레그램 리포터 (Phase 3-A)
 *
 * bots/invest/lib/telegram.js 패턴 재사용 + 3시장 포매터 통합
 */

const https = require('https');
const { loadSecrets } = require('./secrets');

const SECRETS       = loadSecrets();
const BOT_TOKEN     = SECRETS.telegram_bot_token;
const DEFAULT_CHAT  = SECRETS.telegram_chat_id;
const TEAM_NAME     = '루나팀 v3';
const PREFIX        = `📈 ${TEAM_NAME}`;

// ─── 기본 발송 ───────────────────────────────────────────────────────

function tryTelegramSend(message, chatId = DEFAULT_CHAT) {
  if (!BOT_TOKEN) {
    console.log(`[텔레그램 토큰 없음] ${message.slice(0, 80)}`);
    return Promise.resolve(false);
  }
  if (process.env.TELEGRAM_ENABLED === '0') return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      const text = `${PREFIX}\n\n${message}`;
      const body = Buffer.from(JSON.stringify({ chat_id: chatId, text }));
      const req  = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${BOT_TOKEN}/sendMessage`,
        method:   'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(raw);
            if (!r.ok) console.warn(`⚠️ 텔레그램 API 오류: ${r.description || raw.slice(0, 60)}`);
            resolve(r.ok === true);
          } catch { resolve(false); }
        });
      });
      req.on('error', (e) => { console.warn(`⚠️ 텔레그램: ${e.message}`); resolve(false); });
      req.setTimeout(10000, () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    } catch (e) { console.warn(`⚠️ 텔레그램 예외: ${e.message}`); resolve(false); }
  });
}

async function sendTelegram(message, chatId = DEFAULT_CHAT) {
  if (process.env.TELEGRAM_ENABLED === '0') {
    console.log(`[텔레그램 비활성] ${message.slice(0, 60)}`);
    return true;
  }
  for (let i = 1; i <= 3; i++) {
    if (await tryTelegramSend(message, chatId)) {
      console.log(`📱 [텔레그램] 발송${i > 1 ? `(${i}회)` : ''}: ${message.slice(0, 50)}`);
      return true;
    }
    if (i < 3) await new Promise(r => setTimeout(r, i * 2000));
  }
  console.error('❌ 텔레그램 최종 실패');
  return false;
}

// ─── 신호 포매터 ─────────────────────────────────────────────────────

/** 암호화폐 신호 알림 */
function notifySignal({ symbol, action, amountUsdt, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sendTelegram(msg);
}

/** 암호화폐 체결 알림 */
function notifyTrade({ symbol, side, amount, price, totalUsdt, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = side === 'buy' ? '✅ 매수' : '✅ 매도';
  const msg   = [
    `${tag}${emoji} 체결 — ${symbol}`,
    `수량: ${amount?.toFixed(6)} / 가격: $${price?.toLocaleString()}`,
    `총액: $${totalUsdt?.toFixed(2)}`,
  ].join('\n');
  return sendTelegram(msg);
}

/** 국내주식(KIS) 신호 알림 */
function notifyKisSignal({ symbol, action, amountKrw, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [국내주식] ${action} 신호 — ${symbol}`,
    `금액: ${amountKrw?.toLocaleString()}원`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sendTelegram(msg);
}

/** 미국주식(KIS 해외) 신호 알림 */
function notifyKisOverseasSignal({ symbol, action, amountUsdt, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [미국주식] ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sendTelegram(msg);
}

/** 리스크 거부 알림 */
function notifyRiskRejection({ symbol, action, reason }) {
  const msg = `🚫 [리스크 거부] ${action} ${symbol}\n사유: ${reason}`;
  return sendTelegram(msg);
}

/** 오류 알림 */
function notifyError(context, error) {
  const msg = `❌ [오류] ${context}\n${error?.message || error}`;
  return sendTelegram(msg);
}

/** 사이클 요약 알림 */
function notifyCycleSummary({ cycle, symbols, results, paperMode, durationMs }) {
  const tag    = paperMode ? '[PAPER] ' : '';
  const lines  = [
    `${tag}🔄 ${cycle} 사이클 완료`,
    `심볼: ${symbols.join(', ')}`,
    `소요: ${(durationMs / 1000).toFixed(1)}s`,
  ];
  if (results.length > 0) {
    lines.push('');
    lines.push('신호:');
    results.forEach(r => {
      const emoji = r.action === 'BUY' ? '🟢' : r.action === 'SELL' ? '🔴' : '⚪';
      lines.push(`  ${emoji} ${r.symbol}: ${r.action} (${((r.confidence || 0) * 100).toFixed(0)}%)`);
    });
  } else {
    lines.push('신호: HOLD (모든 심볼)');
  }
  return sendTelegram(lines.join('\n'));
}

module.exports = {
  sendTelegram,
  notifySignal, notifyTrade,
  notifyKisSignal, notifyKisOverseasSignal,
  notifyRiskRejection, notifyError,
  notifyCycleSummary,
};

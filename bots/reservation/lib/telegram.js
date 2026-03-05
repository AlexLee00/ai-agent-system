/**
 * lib/telegram.js — Telegram Bot API 직접 발송 모듈
 *
 * openclaw agent --deliver를 사용하지 않고 Telegram Bot API를 직접 호출.
 * openclaw는 사용자 ↔ 스카 대화용, 단방향 알림은 Bot API 직접 사용.
 *
 * 알람 유실 방지 (pending queue):
 *   - 3회 재시도 후 최종 실패 시 pending-telegrams.jsonl 에 저장
 *   - 재시작 시 flushPendingTelegrams() 호출로 자동 재발송
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { loadSecrets } = require('./secrets');

// ── 팀 이름 (변경 시 이 상수만 수정)
const TEAM_NAME = '스카팀';
const { log } = require('./utils');

const SECRETS = loadSecrets();
const BOT_TOKEN = SECRETS.telegram_bot_token;
const DEFAULT_CHAT_ID = SECRETS.telegram_chat_id;

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const PENDING_FILE = path.join(WORKSPACE, 'pending-telegrams.jsonl');

/**
 * Telegram Bot API로 메시지 1회 전송 시도
 * @returns {Promise<boolean>} 성공 여부
 */
function tryTelegramSend(message, chatId = DEFAULT_CHAT_ID) {
  if (!BOT_TOKEN) return Promise.resolve(false); // 텔레그램 토큰 미설정 — 무음 스킵
  if (process.env.TELEGRAM_ENABLED === '0') return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      const text = `🔔 ${TEAM_NAME}\n\n${message}`;
      const body = Buffer.from(JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }));
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
 * 파일명 단독 메시지 감지 (BUG-006 방어)
 * BOOT 중 LLM이 읽은 파일명을 텔레그램으로 흘려보내는 현상 차단.
 * @param {string} message
 * @returns {boolean} true면 파일명 누출로 판단 → 전송 차단
 */
function isFilenameLeak(message) {
  const trimmed = message.trim();
  const FILE_PATTERN = /^[\w\-. ]+\.(md|js|json|txt|sh|py|plist|log|db)$/i;

  // 단일 줄 파일명
  if (!trimmed.includes('\n') && FILE_PATTERN.test(trimmed)) return true;

  // 여러 줄이지만 전부 파일명
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 1 && lines.every(l => FILE_PATTERN.test(l))) return true;

  return false;
}

/**
 * 텔레그램 메시지 발송 — 3회 재시도
 * @param {string} message  발송할 메시지 본문
 * @param {string} [chatId] 수신자 chat_id (기본: secrets.telegram_chat_id)
 * @returns {Promise<boolean>}
 */
async function sendTelegram(message, chatId = DEFAULT_CHAT_ID) {
  if (!BOT_TOKEN) {
    log(`[텔레그램 비활성화] 토큰 미설정 — 스킵: ${message.slice(0, 60)}`);
    return false;
  }
  if (process.env.TELEGRAM_ENABLED === '0') {
    log(`[텔레그램 비활성화] ${message.slice(0, 60)}`);
    return true;
  }

  // BUG-006 방어: 파일명 단독 메시지 차단
  if (isFilenameLeak(message)) {
    log(`🚫 [텔레그램 차단] 파일명 누출 감지: "${message.trim().slice(0, 60)}"`);
    return false;
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
  log(`❌ 텔레그램 발송 최종 실패 (${MAX_TRIES}회) — 대기큐 저장`);
  savePending(message, chatId);
  return false;
}

/**
 * 대기큐에 메시지 저장 (JSONL 한 줄 append)
 */
function savePending(message, chatId) {
  try {
    if (!fs.existsSync(WORKSPACE)) return;
    const entry = JSON.stringify({ message, chatId, savedAt: new Date().toISOString() });
    fs.appendFileSync(PENDING_FILE, entry + '\n', 'utf-8');
    log(`📥 대기큐 저장: ${message.slice(0, 50)}`);
  } catch (e) {
    log(`⚠️ 대기큐 저장 실패: ${e.message}`);
  }
}

/**
 * 대기큐 메시지 재발송 (재시작 시 호출)
 * 성공한 항목은 큐에서 제거, 실패한 항목은 유지
 */
async function flushPendingTelegrams() {
  if (!fs.existsSync(PENDING_FILE)) return;

  let lines;
  try {
    lines = fs.readFileSync(PENDING_FILE, 'utf-8').split('\n').filter(l => l.trim());
  } catch (e) {
    log(`⚠️ 대기큐 읽기 실패: ${e.message}`);
    return;
  }

  if (lines.length === 0) return;
  log(`📤 대기큐 재발송 시작: ${lines.length}건`);

  // Telegram 최대 길이: 4096자 (프리픽스 "🔔 스카팀\n\n" ~12자 포함)
  const TG_MAX = 4096 - 20;

  const remaining = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // 손상된 줄 제거

    // 영구 실패 조건: 메시지가 Telegram 허용 한도 초과 → 재시도 불필요, 폐기
    if (entry.message && entry.message.length > TG_MAX) {
      log(`🗑️ 대기큐 폐기 (메시지 너무 김 ${entry.message.length}자): ${entry.message.slice(0, 50)}`);
      continue;
    }

    const ok = await tryTelegramSend(entry.message, entry.chatId || DEFAULT_CHAT_ID);
    if (ok) {
      log(`✅ 대기큐 재발송 성공: ${entry.message.slice(0, 50)}`);
    } else {
      log(`⚠️ 대기큐 재발송 실패 (재보관): ${entry.message.slice(0, 50)}`);
      remaining.push(line);
    }
  }

  try {
    if (remaining.length === 0) {
      fs.unlinkSync(PENDING_FILE);
    } else {
      fs.writeFileSync(PENDING_FILE, remaining.join('\n') + '\n', 'utf-8');
    }
  } catch (e) {
    log(`⚠️ 대기큐 정리 실패: ${e.message}`);
  }
}

module.exports = { sendTelegram, tryTelegramSend, flushPendingTelegrams };

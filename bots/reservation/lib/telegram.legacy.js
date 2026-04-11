/**
 * lib/telegram.js — 스카 알림 호환 래퍼
 *
 * 2026-04-11 기준 스카 예약 알림은 OpenClaw hook → topic 경로만 사용한다.
 * 과거 Bot API 직접 발송은 개인 채팅 유출의 원인이 되어 더 이상 사용하지 않는다.
 */

const fs = require('fs');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

// ── 팀 이름 (변경 시 이 상수만 수정)
const TEAM_NAME = '스카팀';
const { log } = require('./utils');

const SECRETS = loadSecrets();
const BOT_TOKEN = SECRETS.telegram_bot_token;
const DEFAULT_CHAT_ID = SECRETS.telegram_chat_id;

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');

/**
 * @deprecated 개인 채팅 유출 방지를 위해 비활성화됨.
 * 하위 호환용으로만 남기며 항상 false를 반환한다.
 */
function tryTelegramSend(message, chatId = DEFAULT_CHAT_ID) {
  void message;
  void chatId;
  log('ℹ️ tryTelegramSend 호출 무시: 스카 알림은 topic-only 정책');
  return Promise.resolve(false);
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
 * 스카팀 메시지 발송 — OpenClaw topic 경유
 * @param {string} message  발송할 메시지 본문
 * @param {string} [chatId] 하위 호환용 인자. 더 이상 사용하지 않음.
 * @returns {Promise<boolean>}
 */
async function sendTelegram(message, chatId = DEFAULT_CHAT_ID) {
  void chatId;
  if (!BOT_TOKEN) {
    log(`[텔레그램 비활성화] 토큰 미설정 — 스킵: ${message.slice(0, 60)}`);
    return false;
  }
  if (process.env.TELEGRAM_ENABLED === '0') {
    log(`[텔레그램 비활성화] ${message.slice(0, 60)}`);
    return true;
  }

  // BUG-006 방어: 파일명 단독 메시지 차단 (sender에도 있지만 로그용 중복 유지)
  if (isFilenameLeak(message)) {
    log(`🚫 [텔레그램 차단] 파일명 누출 감지: "${message.trim().slice(0, 60)}"`);
    return false;
  }

  try {
    const result = await postAlarm({
      message,
      team: 'ska',
      alertLevel: 2,
      fromBot: 'ska',
    });
    if (result.ok) {
      log(`📱 [스카 topic] 발송 성공: ${message.slice(0, 50)}`);
      return true;
    }

    log(`⚠️ [스카 topic] postAlarm 실패: ${JSON.stringify(result).slice(0, 120)}`);
    return false;
  } catch (err) {
    log(`⚠️ [스카 topic] postAlarm 예외: ${err.message}`);
    return false;
  }
}

/**
 * 과거 pending queue 재발송 훅. topic-only 정책에서는 noop 유지.
 */
async function flushPendingTelegrams() {
  if (fs.existsSync(WORKSPACE)) return false;
  return false;
}

module.exports = { sendTelegram, tryTelegramSend, flushPendingTelegrams }; // deprecated compatibility export

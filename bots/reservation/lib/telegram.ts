import fs from 'fs';
import { publishReservationAlert } from './alert-client';
import { log } from './utils';
const { loadSecrets } = require('./secrets');
const { getReservationRuntimeDir } = require('./runtime-paths');

const TEAM_NAME = '스카팀';
const SECRETS = loadSecrets();
const BOT_TOKEN = SECRETS.telegram_bot_token;
const DEFAULT_CHAT_ID = SECRETS.telegram_chat_id;
const WORKSPACE = getReservationRuntimeDir();

export function tryTelegramSend(message: string, chatId = DEFAULT_CHAT_ID): Promise<boolean> {
  void message;
  void chatId;
  log('ℹ️ tryTelegramSend 호출 무시: 스카 알림은 topic-only 정책');
  return Promise.resolve(false);
}

function isFilenameLeak(message: string): boolean {
  const trimmed = String(message || '').trim();
  const filePattern = /^[\w\-. ]+\.(md|js|json|txt|sh|py|plist|log|db)$/i;

  if (!trimmed.includes('\n') && filePattern.test(trimmed)) return true;

  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 1 && lines.every((line) => filePattern.test(line))) return true;

  return false;
}

export async function sendTelegram(message: string, chatId = DEFAULT_CHAT_ID): Promise<boolean> {
  void chatId;
  if (!BOT_TOKEN) {
    log(`[텔레그램 비활성화] 토큰 미설정 — 스킵: ${message.slice(0, 60)}`);
    return false;
  }
  if (process.env.TELEGRAM_ENABLED === '0') {
    log(`[텔레그램 비활성화] ${message.slice(0, 60)}`);
    return true;
  }

  if (isFilenameLeak(message)) {
    log(`🚫 [${TEAM_NAME} 차단] 파일명 누출 감지: "${message.trim().slice(0, 60)}"`);
    return false;
  }

  try {
    const result = await publishReservationAlert({
      message,
      team: 'ska',
      alert_level: 2,
      from_bot: 'ska',
      event_type: 'ska_telegram_send',
    });
    if (result) {
      log(`📱 [스카 topic] 발송 성공: ${message.slice(0, 50)}`);
      return true;
    }

    log('⚠️ [스카 topic] publishReservationAlert 실패');
    return false;
  } catch (err) {
    const error = err as Error;
    log(`⚠️ [스카 topic] publishReservationAlert 예외: ${error.message}`);
    return false;
  }
}

export async function flushPendingTelegrams(): Promise<boolean> {
  if (fs.existsSync(WORKSPACE)) return false;
  return false;
}

'use strict';

/**
 * packages/core/lib/openclaw-client.js — OpenClaw webhook 클라이언트
 *
 * 모든 봇 알람을 POST /hooks/agent로 전달한다.
 * hooks_token은 Hub secrets-store 경유 로딩을 우선한다.
 */

const fs = require('fs');
const path = require('path');
const env = require('./env');
const { fetchHubSecrets } = require('./hub-client');

const HOOK_URL = 'http://127.0.0.1:18789/hooks/agent';
const TIMEOUT_MS = 30_000;
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

const TEAM_TOPIC = {
  general: 'general',
  reservation: 'ska',
  ska: 'ska',
  investment: 'luna',
  luna: 'luna',
  claude: 'claude_lead',
  'claude-lead': 'claude_lead',
  blog: 'blog',
  worker: 'worker',
  video: 'video',
  darwin: 'darwin',
  justin: 'justin',
  sigma: 'sigma',
  meeting: 'meeting',
  emergency: 'emergency',
};

let _token = null;
let _groupId = null;
let _topicIds = null;
let _telegramBotToken = null;
let _darwinTelegramBotToken = null;

function _readStoreToken() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.openclaw?.hooks_token || '';
  } catch {
    return '';
  }
}

function _readStoreTopicInfo() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      groupId: store?.telegram?.group_id || '',
      topicIds: store?.telegram?.topic_ids || {},
    };
  } catch {
    return { groupId: '', topicIds: {} };
  }
}

async function _getToken() {
  if (_token) return _token;

  const hubData = await fetchHubSecrets('openclaw');
  _token = hubData?.hooks_token
    || process.env.OPENCLAW_HOOKS_TOKEN
    || _readStoreToken()
    || '';
  return _token;
}

async function _getTopicInfo() {
  if (_groupId && _topicIds) {
    return { groupId: _groupId, topicIds: _topicIds };
  }

  const hubData = await fetchHubSecrets('telegram');
  const storeData = _readStoreTopicInfo();

  _groupId = hubData?.group_id
    || process.env.TELEGRAM_GROUP_ID
    || storeData.groupId
    || '';
  _topicIds = hubData?.topic_ids
    || storeData.topicIds
    || {};

  return { groupId: _groupId, topicIds: _topicIds };
}

async function _getTelegramBotToken() {
  if (_telegramBotToken) return _telegramBotToken;

  const telegramData = await fetchHubSecrets('telegram');
  const reservationData = await fetchHubSecrets('reservation-shared');

  _telegramBotToken = telegramData?.bot_token
    || reservationData?.telegram_bot_token
    || '';
  return _telegramBotToken;
}

async function _getDarwinTelegramBotToken() {
  if (_darwinTelegramBotToken) return _darwinTelegramBotToken;

  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    _darwinTelegramBotToken = store?.darwin?.telegram_bot_token
      || store?.telegram?.darwin_bot_token
      || process.env.DARWIN_TELEGRAM_BOT_TOKEN
      || '';
  } catch {
    _darwinTelegramBotToken = process.env.DARWIN_TELEGRAM_BOT_TOKEN || '';
  }

  return _darwinTelegramBotToken;
}

async function _sendInlineTelegram({ message, team, fromBot, topicId, groupId, inlineKeyboard }) {
  const botToken = team === 'darwin'
    ? (await _getDarwinTelegramBotToken()) || (await _getTelegramBotToken())
    : await _getTelegramBotToken();
  if (!botToken || !groupId) {
    console.warn('[openclaw-client] inline telegram 발송 실패: bot token/group id 미설정');
    return { ok: false, error: 'no_telegram_token_or_group' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: groupId,
        text: `[${fromBot}→${team}] ${message}`,
        message_thread_id: topicId || undefined,
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    return { ok: res.ok && body?.ok === true, status: res.status, body };
  } catch (e) {
    console.warn(`[openclaw-client] inline telegram 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function postAlarm({
  message,
  team = 'general',
  alertLevel = 2,
  fromBot = 'unknown',
  sessionKey,
  inlineKeyboard = null,
}) {
  const token = await _getToken();
  if (!token) {
    console.warn('[openclaw-client] hooks_token 미설정');
    return { ok: false, error: 'no_token' };
  }

  const normalizedTeam = TEAM_TOPIC[team] || 'general';
  const key = sessionKey || `hook:${normalizedTeam}:${fromBot}`;
  const prefix = alertLevel >= 3 ? `🚨 [긴급 alert_level=${alertLevel}] ` : '';
  const { groupId, topicIds } = await _getTopicInfo();
  const topicId = topicIds?.[normalizedTeam] || topicIds?.general || null;
  const to = groupId
    ? (topicId ? `${groupId}:topic:${topicId}` : groupId)
    : undefined;

  if (Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0) {
    return _sendInlineTelegram({
      message: `${prefix}${message}`,
      team,
      fromBot,
      topicId,
      groupId,
      inlineKeyboard,
    });
  }

  try {
    const res = await fetch(HOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: `${prefix}[${fromBot}→${team}] ${message}`,
        name: fromBot,
        agentId: 'main',
        sessionKey: key,
        deliver: true,
        channel: 'telegram',
        to,
        wakeMode: 'now',
        timeoutSeconds: TIMEOUT_MS / 1000,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.warn(`[openclaw-client] webhook 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { postAlarm };

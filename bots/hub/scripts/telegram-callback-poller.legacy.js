'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const OFFSET_FILE = '/tmp/telegram-callback-offset.json';
const HUB_BASE = `http://127.0.0.1:${env.HUB_PORT || 7788}`;
const POLL_TIMEOUT_SEC = 30;
const REQUEST_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 5_000;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function _getBotToken() {
  const store = _readSecrets();
  return store?.darwin?.telegram_bot_token
    || store?.telegram?.darwin_bot_token
    || process.env.DARWIN_TELEGRAM_BOT_TOKEN
    || store?.telegram?.bot_token
    || store?.reservation?.telegram_bot_token
    || process.env.TELEGRAM_BOT_TOKEN
    || '';
}

function _getHubToken() {
  return String(process.env.HUB_AUTH_TOKEN || '').trim();
}

function _readOffset() {
  try {
    const data = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8'));
    return Number(data.offset || 0);
  } catch {
    return 0;
  }
}

function _saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({
    offset: Number(offset || 0),
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
}

async function _getWebhookInfo(botToken) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`getWebhookInfo HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getWebhookInfo API error: ${data.description || 'unknown'}`);
  return data.result || {};
}

async function _deleteWebhook(botToken) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`deleteWebhook HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`deleteWebhook API error: ${data.description || 'unknown'}`);
  return data.result;
}

async function _ensurePollingAvailable(botToken) {
  const webhook = await _getWebhookInfo(botToken);
  if (!webhook.url) return;

  const shouldDelete = String(process.env.TELEGRAM_CALLBACK_POLLER_DELETE_WEBHOOK || '') === '1';
  if (shouldDelete) {
    console.warn(`[poller] 기존 webhook 감지 -> 삭제 진행: ${webhook.url}`);
    await _deleteWebhook(botToken);
    return;
  }

  throw new Error(`webhook active: ${webhook.url} (set TELEGRAM_CALLBACK_POLLER_DELETE_WEBHOOK=1 to deleteWebhook)`);
}

async function _getUpdates(botToken, offset) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: POLL_TIMEOUT_SEC,
      allowed_updates: ['callback_query'],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getUpdates API error: ${data.description || 'unknown'}`);
  return Array.isArray(data.result) ? data.result : [];
}

async function _forwardToDarwinCallback(callbackQuery) {
  const callbackData = String(callbackQuery?.data || '');
  if (!callbackData.startsWith('darwin_')) {
    console.log(`[poller] 스킵 (darwin_ 아님): ${callbackData}`);
    return { skipped: true };
  }

  const headers = { 'Content-Type': 'application/json' };
  const hubToken = _getHubToken();
  if (hubToken) {
    headers.Authorization = `Bearer ${hubToken}`;
  }

  console.log(`[poller] 콜백 전달: ${callbackData}`);
  const res = await fetch(`${HUB_BASE}/hub/darwin/callback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      callback_data: callbackData,
      callback_query_id: callbackQuery.id,
      from: callbackQuery.from,
      message: callbackQuery.message,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  console.log(`[poller] 결과: ${JSON.stringify(body || { status: res.status })}`);
  if (!res.ok) {
    throw new Error(`Hub callback HTTP ${res.status}`);
  }
  return body;
}

async function pollLoop() {
  const botToken = _getBotToken();
  if (!botToken) {
    throw new Error('telegram bot token missing');
  }

  await _ensurePollingAvailable(botToken);

  let offset = _readOffset();
  console.log(`[poller] 시작 (offset=${offset})`);

  while (true) {
    try {
      const updates = await _getUpdates(botToken, offset);
      for (const update of updates) {
        if (update.callback_query) {
          await _forwardToDarwinCallback(update.callback_query);
        }
        offset = Number(update.update_id || 0) + 1;
        _saveOffset(offset);
      }
    } catch (error) {
      console.error(`[poller] 에러: ${error.message}`);
      await _sleep(RETRY_DELAY_MS);
    }
  }
}

pollLoop().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

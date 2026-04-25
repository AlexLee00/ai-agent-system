import fs from 'node:fs';
import path from 'node:path';
import env from '../../../packages/core/lib/env.legacy.js';
import { resolveHubCallbackTarget } from '../lib/telegram/callback-router';

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const OFFSET_FILE = '/tmp/telegram-callback-offset.json';
const HUB_BASE = `http://127.0.0.1:${env.HUB_PORT || 7788}`;
const POLL_TIMEOUT_SEC = 30;
const REQUEST_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 5_000;

type CallbackQuery = {
  id: string;
  data?: string;
  from?: unknown;
  message?: unknown;
};

type TelegramUpdate = {
  update_id?: number;
  callback_query?: CallbackQuery;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSecrets(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function getBotToken(): string {
  const store = readSecrets();
  return (
    store?.darwin?.telegram_bot_token ||
    store?.telegram?.darwin_bot_token ||
    process.env.DARWIN_TELEGRAM_BOT_TOKEN ||
    store?.telegram?.bot_token ||
    store?.reservation?.telegram_bot_token ||
    process.env.TELEGRAM_BOT_TOKEN ||
    ''
  );
}

function getHubToken(): string {
  return String(process.env.HUB_AUTH_TOKEN || '').trim();
}

function getControlCallbackSecret(): string {
  return String(process.env.HUB_CONTROL_CALLBACK_SECRET || '').trim();
}

function readOffset(): number {
  try {
    const data = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')) as { offset?: number };
    return Number(data.offset || 0);
  } catch {
    return 0;
  }
}

function saveOffset(offset: number): void {
  fs.writeFileSync(
    OFFSET_FILE,
    JSON.stringify(
      {
        offset: Number(offset || 0),
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function getWebhookInfo(botToken: string): Promise<{ url?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`getWebhookInfo HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: { url?: string } };
  if (!data.ok) throw new Error(`getWebhookInfo API error: ${data.description || 'unknown'}`);
  return data.result || {};
}

async function deleteWebhook(botToken: string): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`deleteWebhook HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: unknown };
  if (!data.ok) throw new Error(`deleteWebhook API error: ${data.description || 'unknown'}`);
  return data.result;
}

async function ensurePollingAvailable(botToken: string): Promise<void> {
  const webhook = await getWebhookInfo(botToken);
  if (!webhook.url) return;

  const shouldDelete = String(process.env.TELEGRAM_CALLBACK_POLLER_DELETE_WEBHOOK || '') === '1';
  if (shouldDelete) {
    console.warn(`[poller] 기존 webhook 감지 -> 삭제 진행: ${webhook.url}`);
    await deleteWebhook(botToken);
    return;
  }

  throw new Error(`webhook active: ${webhook.url} (set TELEGRAM_CALLBACK_POLLER_DELETE_WEBHOOK=1 to deleteWebhook)`);
}

async function getUpdates(botToken: string, offset: number): Promise<TelegramUpdate[]> {
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
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: TelegramUpdate[] };
  if (!data.ok) throw new Error(`getUpdates API error: ${data.description || 'unknown'}`);
  return Array.isArray(data.result) ? data.result : [];
}

async function forwardCallback(callbackQuery: CallbackQuery): Promise<unknown> {
  const callbackData = String(callbackQuery?.data || '');
  const target = resolveHubCallbackTarget(callbackData);
  if (!target) {
    console.log(`[poller] 스킵 (미지원 callback): ${callbackData}`);
    return { skipped: true };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const hubToken = getHubToken();
  if (hubToken) {
    headers.Authorization = `Bearer ${hubToken}`;
  }
  const callbackSecret = getControlCallbackSecret();
  if (callbackSecret) {
    headers['x-hub-control-callback-secret'] = callbackSecret;
  }

  console.log(`[poller] 콜백 전달(${target.mode}): ${callbackData}`);
  const res = await fetch(`${HUB_BASE}${target.route}`, {
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

async function pollLoop(): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) {
    throw new Error('telegram bot token missing');
  }

  await ensurePollingAvailable(botToken);

  let offset = readOffset();
  console.log(`[poller] 시작 (offset=${offset})`);

  while (true) {
    try {
      const updates = await getUpdates(botToken, offset);
      for (const update of updates) {
        if (update.callback_query) {
          await forwardCallback(update.callback_query);
        }
        offset = Number(update.update_id || 0) + 1;
        saveOffset(offset);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[poller] 에러: ${err.message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

pollLoop().catch((error) => {
  const err = error as Error;
  console.error(err.stack || err.message);
  process.exit(1);
});

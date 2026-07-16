import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUB_PORT, PROJECT_ROOT } from '../../../packages/core/lib/env.ts';

const { resolveHubCallbackTarget } = require('../lib/telegram/callback-router.ts') as {
  resolveHubCallbackTarget: (callbackData: unknown) => { route: string; mode: string } | null;
};

const STORE_PATH = path.join(PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const OFFSET_FILE = process.env.HUB_TELEGRAM_CALLBACK_OFFSET_FILE
  || path.join(process.env.HUB_RUNTIME_DIR || path.join(os.homedir(), '.ai-agent-system', 'hub'), 'telegram', 'callback-offset.json');
const HUB_BASE = `http://127.0.0.1:${HUB_PORT || 7788}`;
const POLL_TIMEOUT_SEC = 30;
const REQUEST_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 5_000;
const POLL_HEARTBEAT_MS = 5 * 60_000;

type CallbackQuery = {
  id: string;
  data?: string;
  from?: unknown;
  message?: unknown;
};

type TelegramMessage = {
  message_id?: number;
  message_thread_id?: number;
  date?: number;
  text?: string;
  chat?: { id?: number | string };
  from?: unknown;
};

type TelegramUpdate = {
  update_id?: number;
  callback_query?: CallbackQuery;
  message?: TelegramMessage;
};

type BotTarget = {
  key: string;
  token: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logInfo(message: string): void {
  console.log(`[poller] ${new Date().toISOString()} ${message}`);
}

function logWarn(message: string): void {
  console.warn(`[poller] ${new Date().toISOString()} ${message}`);
}

function logError(message: string, error?: unknown): void {
  const err = error as Error & { cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code || err?.cause?.message;
  console.error(`[poller] ${new Date().toISOString()} ${message}${cause ? ` cause=${cause}` : ''}`);
}

function readSecrets(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function addBotTarget(targets: BotTarget[], seen: Set<string>, key: string, token: unknown): void {
  const normalized = String(token || '').trim();
  if (!normalized || seen.has(normalized)) return;
  targets.push({ key, token: normalized });
  seen.add(normalized);
}

function getBotTargets(): BotTarget[] {
  const store = readSecrets();
  const targets: BotTarget[] = [];
  const seen = new Set<string>();

  addBotTarget(
    targets,
    seen,
    'telegram',
    store?.telegram?.bot_token || store?.reservation?.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN,
  );
  addBotTarget(
    targets,
    seen,
    'darwin',
    store?.darwin?.telegram_bot_token || store?.telegram?.darwin_bot_token || process.env.DARWIN_TELEGRAM_BOT_TOKEN,
  );

  return targets;
}

function getHubToken(): string {
  return String(process.env.HUB_AUTH_TOKEN || '').trim();
}

function getControlCallbackSecret(): string {
  return String(process.env.HUB_CONTROL_CALLBACK_SECRET || '').trim();
}

function readOffset(targetKey: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')) as { offset?: number; offsets?: Record<string, number> };
    const scopedOffset = Number(data.offsets?.[targetKey] || 0);
    if (Number.isFinite(scopedOffset) && scopedOffset > 0) return scopedOffset;
    const legacyOffset = Number(data.offset || 0);
    return Number.isFinite(legacyOffset) && legacyOffset > 0 ? legacyOffset : 0;
  } catch {
    return 0;
  }
}

function readAllOffsets(): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')) as { offset?: number; offsets?: Record<string, number> };
    const offsets = data.offsets && typeof data.offsets === 'object' ? { ...data.offsets } : {};
    if (Object.keys(offsets).length === 0 && Number(data.offset || 0) > 0) {
      offsets.telegram = Number(data.offset || 0);
    }
    return offsets;
  } catch {
    return {};
  }
}

function saveOffset(targetKey: string, offset: number): void {
  fs.mkdirSync(path.dirname(OFFSET_FILE), { recursive: true });
  const offsets = readAllOffsets();
  offsets[targetKey] = Number(offset || 0);
  const payload = JSON.stringify(
    {
      offset: Math.max(0, ...Object.values(offsets).map((value) => Number(value || 0))),
      offsets,
      updated_at: new Date().toISOString(),
    },
    null,
    2,
  );
  const tmpFile = `${OFFSET_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, OFFSET_FILE);
  try {
    fs.chmodSync(OFFSET_FILE, 0o600);
  } catch {
    // Some filesystems do not support chmod; atomic rename is the important part.
  }
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
    logWarn(`기존 webhook 감지 -> 삭제 진행: ${webhook.url}`);
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
      allowed_updates: ['callback_query', 'message'],
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
    logInfo(`스킵 (미지원 callback): ${callbackData}`);
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

  logInfo(`콜백 전달(${target.mode}): ${callbackData}`);
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
  logInfo(`결과: ${JSON.stringify(body || { status: res.status })}`);
  if (!res.ok) {
    throw new Error(`Hub callback HTTP ${res.status}`);
  }
  return body;
}

function masterChatIds(): Set<string> {
  return new Set(
    String(process.env.MASTER_TELEGRAM_CHAT_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isMasterMessage(message: TelegramMessage): boolean {
  const chatId = String(message?.chat?.id || '').trim();
  if (!chatId) return false;

  const allowed = masterChatIds();
  return allowed.size > 0 && allowed.has(chatId);
}

async function forwardMasterMessage(message: TelegramMessage, botToken = ''): Promise<unknown> {
  if (!isMasterMessage(message)) {
    return { skipped: true, reason: 'non_master_chat' };
  }

  const text = String(message?.text || '').trim();
  if (!text) {
    return { skipped: true, reason: 'empty_message' };
  }

  if (/^\/jaenong(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    return forwardJaenongCommand(message, botToken);
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

  const chatId = String(message?.chat?.id || '').trim();
  logInfo(`마스터 메시지 전달(chat=${chatId}, message=${message.message_id || 'unknown'})`);
  const res = await fetch(`${HUB_BASE}/hub/v2/autonomy/intervention`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subtype: 'telegram',
      title: text.slice(0, 120),
      metadata: {
        full_text: text,
        chat_id: chatId,
        message_id: message.message_id || null,
        telegram_date: message.date || null,
        from: message.from || null,
        received_at: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  logInfo(`마스터 메시지 결과: ${JSON.stringify(body || { status: res.status })}`);
  if (!res.ok) {
    throw new Error(`Hub autonomy intervention HTTP ${res.status}`);
  }
  return body;
}

async function sendJaenongReply(message: TelegramMessage, reply: string, botToken: string): Promise<void> {
  if (!String(botToken || '').trim()) return;
  const payload: Record<string, unknown> = {
    chat_id: message.chat?.id,
    text: reply,
  };
  if (message.message_thread_id) payload.message_thread_id = message.message_thread_id;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) logWarn(`JAENONG 응답 전송 실패: HTTP ${res.status}`);
}

async function forwardJaenongCommand(message: TelegramMessage, botToken: string): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const hubToken = getHubToken();
  if (hubToken) headers.Authorization = `Bearer ${hubToken}`;
  const callbackSecret = getControlCallbackSecret();
  if (callbackSecret) headers['x-hub-control-callback-secret'] = callbackSecret;
  const res = await fetch(`${HUB_BASE}/hub/luna/jaenong-command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: String(message.text || '').trim(),
      chat_id: String(message.chat?.id || '').trim(),
      message_id: message.message_id || null,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
  await sendJaenongReply(message, body.message || `JAENONG error=${body.error || `HTTP ${res.status}`}`, botToken);
  if (!res.ok) throw new Error(`Hub JAENONG command HTTP ${res.status}`);
  return body;
}

async function pollLoop(): Promise<void> {
  const botTargets = getBotTargets();
  if (botTargets.length === 0) {
    throw new Error('telegram bot token missing');
  }

  for (const target of botTargets) {
    await ensurePollingAvailable(target.token);
  }

  const offsets = Object.fromEntries(botTargets.map((target) => [target.key, readOffset(target.key)]));
  logInfo(`시작 (bots=${botTargets.map((target) => target.key).join(',')}, offsets=${JSON.stringify(offsets)})`);
  const lastHeartbeatAt = Object.fromEntries(botTargets.map((target) => [target.key, 0]));

  while (true) {
    for (const target of botTargets) {
      try {
        let offset = offsets[target.key] || 0;
        const updates = await getUpdates(target.token, offset);
        const now = Date.now();
        if (updates.length > 0 || now - (lastHeartbeatAt[target.key] || 0) >= POLL_HEARTBEAT_MS) {
          logInfo(`poll ok bot=${target.key} (updates=${updates.length}, offset=${offset})`);
          lastHeartbeatAt[target.key] = now;
        }
        for (const update of updates) {
          try {
            if (update.callback_query) {
              await forwardCallback(update.callback_query);
            }
            if (update.message) {
              await forwardMasterMessage(update.message, target.token);
            }
          } catch (error) {
            const err = error as Error;
            logError(`update 처리 실패 bot=${target.key} update=${update.update_id || 'unknown'}: ${err.message}`, err);
          } finally {
            offset = Number(update.update_id || 0) + 1;
            offsets[target.key] = offset;
            saveOffset(target.key, offset);
          }
        }
      } catch (error) {
        const err = error as Error;
        logError(`에러 bot=${target.key}: ${err.message}`, err);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}

pollLoop().catch((error) => {
  const err = error as Error;
  logError(err.stack || err.message, err);
  process.exit(1);
});

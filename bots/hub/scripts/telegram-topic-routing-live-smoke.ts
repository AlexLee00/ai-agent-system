import fs from 'node:fs';
import path from 'node:path';

type SecretStore = {
  telegram?: {
    bot_token?: string;
    telegram_bot_token?: string;
    group_id?: string | number;
    telegram_group_id?: string | number;
    topic_ids?: Record<string, string | number | null | undefined>;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
  reservation?: {
    telegram_bot_token?: string;
    telegram_group_id?: string | number;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
};

type TopicResult = {
  key: string;
  thread_id: string | number;
  ok: boolean;
  error?: string;
};

const PLACEHOLDER_PATTERN = /^(__SET_|changeme|todo|placeholder|example)/i;

function loadJson(filePath: string): SecretStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SecretStore;
  } catch {
    return {};
  }
}

function isUsableSecret(value: unknown): value is string {
  const text = String(value || '').trim();
  return Boolean(text) && !PLACEHOLDER_PATTERN.test(text);
}

function normalizeTopics(raw: Record<string, string | number | null | undefined> | undefined) {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value == null || value === '') continue;
    out[key] = value;
  }
  return out;
}

async function telegramApi(token: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error || 'telegram_fetch_failed');
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause || '').trim();
  return causeMessage ? `${error.message}: ${causeMessage}` : error.message;
}

async function telegramApiWithRetry(token: string, method: string, payload: Record<string, unknown>) {
  let lastError: unknown = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await telegramApi(token, method, payload);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw new Error(describeFetchError(lastError));
}

async function validateTopic({
  token,
  chatId,
  key,
  threadId,
}: {
  token: string;
  chatId: string;
  key: string;
  threadId: string | number;
}): Promise<TopicResult> {
  const payload = {
    chat_id: chatId,
    message_thread_id: Number(threadId),
    action: 'typing',
  };

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await telegramApiWithRetry(token, 'sendChatAction', payload);
      if (result.body?.ok === true) {
        return { key, thread_id: threadId, ok: true };
      }
      lastError = String(result.body?.description || `telegram_http_${result.status}`);
    } catch (error: any) {
      lastError = describeFetchError(error);
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return { key, thread_id: threadId, ok: false, error: lastError || 'telegram_topic_check_failed' };
}

async function main() {
  if (process.env.HUB_TELEGRAM_TOPIC_SMOKE_SKIP === '1') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'HUB_TELEGRAM_TOPIC_SMOKE_SKIP' }));
    return;
  }

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const storePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');
  const store = loadJson(storePath);
  const telegram = store.telegram || {};
  const reservation = store.reservation || {};
  const token = process.env.TELEGRAM_BOT_TOKEN
    || telegram.bot_token
    || telegram.telegram_bot_token
    || reservation.telegram_bot_token
    || '';
  const chatId = String(
    process.env.TELEGRAM_GROUP_ID
    || telegram.group_id
    || telegram.telegram_group_id
    || reservation.telegram_group_id
    || process.env.TELEGRAM_CHAT_ID
    || '',
  );

  if (!isUsableSecret(token)) {
    throw new Error('telegram_bot_token_missing_or_placeholder');
  }
  if (!isUsableSecret(chatId)) {
    throw new Error('telegram_group_chat_id_missing_or_placeholder');
  }

  const chat = await telegramApiWithRetry(token, 'getChat', { chat_id: chatId });
  if (chat.body?.ok !== true) {
    throw new Error(`telegram_get_chat_failed: ${chat.body?.description || chat.status}`);
  }
  if (chat.body?.result?.type !== 'supergroup' || chat.body?.result?.is_forum !== true) {
    throw new Error('telegram_target_chat_is_not_forum_supergroup');
  }

  const topics = {
    ...normalizeTopics(reservation.telegram_topic_ids),
    ...normalizeTopics(telegram.topic_ids || telegram.telegram_topic_ids),
  };

  const results: TopicResult[] = [];
  for (const [key, threadId] of Object.entries(topics)) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    results.push(await validateTopic({ token, chatId, key, threadId }));
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      checked: results.length,
      failed,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    checked: results.length,
    valid_topic_keys: results.map((result) => result.key).sort(),
  }));
}

main().catch((error) => {
  console.error('[telegram-topic-routing-live-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});

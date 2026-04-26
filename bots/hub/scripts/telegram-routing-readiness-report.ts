#!/usr/bin/env tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SecretStore = {
  telegram?: {
    bot_token?: string;
    telegram_bot_token?: string;
    group_id?: string | number;
    telegram_group_id?: string | number;
    chat_id?: string | number;
    telegram_chat_id?: string | number;
    topic_ids?: Record<string, string | number | null | undefined>;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
  reservation?: {
    telegram_bot_token?: string;
    telegram_group_id?: string | number;
    telegram_chat_id?: string | number;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
};

type TopicRecord = {
  key: string;
  threadId: string | number;
  source: 'reservation' | 'telegram';
};

type TopicResult = {
  key: string;
  source: string;
  ok: boolean;
  error?: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hubRoot = path.join(repoRoot, 'bots', 'hub');
const PLACEHOLDER_PATTERN = /^(__SET_|changeme|todo|placeholder|example|replace_me)/i;

function loadJson(filePath: string): SecretStore {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SecretStore;
  } catch {
    return {};
  }
}

function isUsableSecret(value: unknown): value is string {
  const text = String(value || '').trim();
  return Boolean(text) && !PLACEHOLDER_PATTERN.test(text);
}

function normalizeTopicRecords(
  raw: Record<string, string | number | null | undefined> | undefined,
  source: TopicRecord['source'],
): TopicRecord[] {
  return Object.entries(raw || {})
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => ({ key, threadId: value as string | number, source }));
}

function mergeTopicRecords(reservationTopics: TopicRecord[], telegramTopics: TopicRecord[]): TopicRecord[] {
  const topics = new Map<string, TopicRecord>();
  for (const topic of reservationTopics) topics.set(topic.key, topic);
  for (const topic of telegramTopics) topics.set(topic.key, topic);
  return [...topics.values()].sort((a, b) => a.key.localeCompare(b.key));
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

async function telegramApiWithRetry(token: string, method: string, payload: Record<string, unknown>) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await telegramApi(token, method, payload);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'telegram_fetch_failed'));
}

async function validateTopic({
  token,
  chatId,
  topic,
}: {
  token: string;
  chatId: string;
  topic: TopicRecord;
}): Promise<TopicResult> {
  const payload = {
    chat_id: chatId,
    message_thread_id: Number(topic.threadId),
    action: 'typing',
  };

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await telegramApiWithRetry(token, 'sendChatAction', payload);
      if (result.body?.ok === true) {
        return { key: topic.key, source: topic.source, ok: true };
      }
      lastError = String(result.body?.description || `telegram_http_${result.status}`);
    } catch (error: any) {
      lastError = String(error?.message || error || 'telegram_fetch_failed');
    }

    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return {
    key: topic.key,
    source: topic.source,
    ok: false,
    error: lastError || 'telegram_topic_check_failed',
  };
}

function lineCount(filePath: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function pendingQueueSummary() {
  const runtimeRoot = process.env.HUB_RUNTIME_DIR
    || process.env.JAY_RUNTIME_DIR
    || path.join(os.homedir(), '.ai-agent-system', 'hub');
  const workspace = path.join(runtimeRoot, 'telegram');
  const activePending = path.join(workspace, 'pending-telegrams.jsonl');
  const legacyWorkspace = String(process.env.OPENCLAW_WORKSPACE || '').trim();
  const legacyPending = legacyWorkspace ? path.join(legacyWorkspace, 'pending-telegrams.jsonl') : '';
  const quarantineFiles = fs.existsSync(workspace)
    ? fs.readdirSync(workspace)
      .filter((name) => name.startsWith('pending-telegrams.quarantine-') && name.endsWith('.jsonl'))
      .sort()
    : [];

  return {
    runtime_workspace: workspace,
    active_pending_exists: fs.existsSync(activePending),
    active_pending_lines: lineCount(activePending),
    legacy_pending_exists: Boolean(legacyPending && fs.existsSync(legacyPending)),
    legacy_pending_lines: legacyPending ? lineCount(legacyPending) : 0,
    quarantine_files: quarantineFiles.length,
    quarantine_lines: quarantineFiles.reduce(
      (sum, name) => sum + lineCount(path.join(workspace, name)),
      0,
    ),
  };
}

async function main() {
  if (process.env.HUB_TELEGRAM_ROUTING_READINESS_SKIP === '1') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'HUB_TELEGRAM_ROUTING_READINESS_SKIP' }));
    return;
  }

  const storePath = path.join(hubRoot, 'secrets-store.json');
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
    || telegram.chat_id
    || telegram.telegram_chat_id
    || reservation.telegram_chat_id
    || '',
  );

  const reservationTopics = normalizeTopicRecords(reservation.telegram_topic_ids, 'reservation');
  const telegramTopics = normalizeTopicRecords(telegram.topic_ids || telegram.telegram_topic_ids, 'telegram');
  const mergedTopics = mergeTopicRecords(reservationTopics, telegramTopics);
  const duplicateKeys = reservationTopics
    .filter((topic) => telegramTopics.some((telegramTopic) => telegramTopic.key === topic.key))
    .map((topic) => topic.key)
    .sort();
  const pendingQueue = pendingQueueSummary();

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

  const results: TopicResult[] = [];
  for (const topic of mergedTopics) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    results.push(await validateTopic({ token, chatId, topic }));
  }

  const failed = results.filter((result) => !result.ok);
  const queueHasBacklog = pendingQueue.active_pending_lines > 0 || pendingQueue.legacy_pending_lines > 0;
  const status = failed.length > 0 ? 'fail' : queueHasBacklog ? 'warn' : 'pass';
  const payload = {
    ok: failed.length === 0,
    status,
    generated_at: new Date().toISOString(),
    telegram: {
      has_bot_token: isUsableSecret(token),
      has_group_chat_id: isUsableSecret(chatId),
      chat_type: chat.body?.result?.type || null,
      is_forum: chat.body?.result?.is_forum === true,
    },
    topic_sources: {
      reservation_count: reservationTopics.length,
      telegram_count: telegramTopics.length,
      effective_count: mergedTopics.length,
      duplicate_keys_overridden_by_telegram: duplicateKeys,
      effective_topic_keys: mergedTopics.map((topic) => topic.key),
    },
    validation: {
      checked: results.length,
      valid: results.filter((result) => result.ok).length,
      failed,
    },
    pending_queue: pendingQueue,
    notes: [
      'This report uses Telegram sendChatAction only; it does not send user-visible messages.',
      'Secrets and chat ids are intentionally redacted from this output.',
    ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[telegram-routing-readiness-report] failed:', error?.message || error);
  process.exitCode = 1;
});

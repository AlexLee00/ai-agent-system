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
  source: 'reservation' | 'telegram' | 'env';
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
const REQUIRED_CLASS_TOPICS = ['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'];
const LEGACY_TOPIC_KEYS = [
  'general',
  'reservation',
  'ska',
  'investment',
  'luna',
  'claude',
  'claude_lead',
  'blog',
  'worker',
  'video',
  'darwin',
  'justin',
  'sigma',
  'meeting',
  'emergency',
  'legal',
];
const ENV_TOPIC_KEYS: Record<string, string> = {
  TELEGRAM_TOPIC_GENERAL: 'general',
  TELEGRAM_TOPIC_SKA: 'ska',
  TELEGRAM_TOPIC_LUNA: 'luna',
  TELEGRAM_TOPIC_CLAUDE_LEAD: 'claude_lead',
  TELEGRAM_TOPIC_BLOG: 'blog',
  TELEGRAM_TOPIC_LEGAL: 'legal',
  TELEGRAM_TOPIC_WORKER: 'worker',
  TELEGRAM_TOPIC_VIDEO: 'video',
  TELEGRAM_TOPIC_DARWIN: 'darwin',
  TELEGRAM_TOPIC_SIGMA: 'sigma',
  TELEGRAM_TOPIC_MEETING: 'meeting',
  TELEGRAM_TOPIC_EMERGENCY: 'emergency',
  TELEGRAM_TOPIC_OPS_WORK: 'ops_work',
  TELEGRAM_TOPIC_OPS_REPORTS: 'ops_reports',
  TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: 'ops_error_resolution',
  TELEGRAM_TOPIC_OPS_EMERGENCY: 'ops_emergency',
};

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

function classTopicModeEnabled(store: SecretStore): boolean {
  const raw = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return (store.telegram as Record<string, unknown> | undefined)?.topic_alias_mode === 'class_topics';
}

function filterActiveTopicsForMode(records: TopicRecord[], classTopicsEnabled: boolean): TopicRecord[] {
  if (!classTopicsEnabled) return records;
  return records.filter((record) => REQUIRED_CLASS_TOPICS.includes(record.key));
}

function envTopicRecords(classTopicsEnabled: boolean): TopicRecord[] {
  return Object.entries(ENV_TOPIC_KEYS)
    .filter(([envKey]) => isUsableSecret(process.env[envKey]))
    .filter(([, key]) => !classTopicsEnabled || REQUIRED_CLASS_TOPICS.includes(key))
    .map(([envKey, key]) => ({ key, threadId: String(process.env[envKey]), source: 'env' as const }));
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
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(describeFetchError(lastError));
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
      lastError = describeFetchError(error);
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
  const legacyWorkspace = String(process.env.HUB_TELEGRAM_LEGACY_PENDING_WORKSPACE || '').trim();
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

  const classTopicsEnabled = classTopicModeEnabled(store);
  const rawReservationTopics = normalizeTopicRecords(reservation.telegram_topic_ids, 'reservation');
  const rawTelegramTopics = normalizeTopicRecords(telegram.topic_ids || telegram.telegram_topic_ids, 'telegram');
  const rawEnvTopics = Object.entries(ENV_TOPIC_KEYS)
    .filter(([envKey]) => isUsableSecret(process.env[envKey]))
    .map(([envKey, key]) => ({ key, threadId: String(process.env[envKey]), source: 'env' as const }));
  const legacyTopicKeysPresent = [...rawReservationTopics, ...rawTelegramTopics, ...rawEnvTopics]
    .map((topic) => topic.key)
    .filter((key) => LEGACY_TOPIC_KEYS.includes(key))
    .sort();
  const reservationTopics = filterActiveTopicsForMode(rawReservationTopics, classTopicsEnabled);
  const telegramTopics = filterActiveTopicsForMode(rawTelegramTopics, classTopicsEnabled);
  const envTopics = envTopicRecords(classTopicsEnabled);
  const mergedTopics = mergeTopicRecords(
    mergeTopicRecords(reservationTopics, telegramTopics),
    envTopics,
  );
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
  const effectiveKeys = new Set(mergedTopics.map((topic) => topic.key));
  const missingClassTopics = REQUIRED_CLASS_TOPICS.filter((key) => !effectiveKeys.has(key));
  const queueHasBacklog = pendingQueue.active_pending_lines > 0 || pendingQueue.legacy_pending_lines > 0;
  const classTopicFailure = classTopicsEnabled && missingClassTopics.length > 0;
  const legacyActiveFailure = classTopicsEnabled && legacyTopicKeysPresent.length > 0;
  const status = failed.length > 0 || classTopicFailure || legacyActiveFailure ? 'fail' : queueHasBacklog ? 'warn' : 'pass';
  const payload = {
    ok: failed.length === 0 && !classTopicFailure && !legacyActiveFailure,
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
      raw_reservation_count: rawReservationTopics.length,
      raw_telegram_count: rawTelegramTopics.length,
      env_count: envTopics.length,
      effective_count: mergedTopics.length,
      duplicate_keys_overridden_by_telegram: duplicateKeys,
      effective_topic_keys: mergedTopics.map((topic) => topic.key),
      legacy_topic_keys_present: [...new Set(legacyTopicKeysPresent)],
    },
    class_topics: {
      enabled: classTopicsEnabled,
      required_keys: REQUIRED_CLASS_TOPICS,
      missing_keys: missingClassTopics,
      ready: !classTopicFailure,
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
  process.exitCode = failed.length > 0 || classTopicFailure || legacyActiveFailure ? 1 : 0;
}

main().catch((error) => {
  console.error('[telegram-routing-readiness-report] failed:', error?.message || error);
  process.exitCode = 1;
});

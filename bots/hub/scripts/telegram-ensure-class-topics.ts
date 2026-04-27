#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const storePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');

const CLASS_TOPICS = [
  { key: 'ops_work', name: '실무 알림', icon_color: 0x6FB9F0 },
  { key: 'ops_reports', name: '레포트 알림', icon_color: 0xFFD67E },
  { key: 'ops_error_resolution', name: '오류 해결', icon_color: 0xCB86DB },
  { key: 'ops_emergency', name: '긴급 알림', icon_color: 0xFB6F5F },
];

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readStore(): Record<string, any> {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

function writeStore(store: Record<string, any>) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function sanitizeTelegramError(value: unknown): string {
  return String(value || '')
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/-100[0-9]{6,}/g, '[chat]')
    .replace(/[0-9]{5,}/g, '[id]')
    .slice(0, 180);
}

function readCredentials(store: Record<string, any>) {
  const telegram = store.telegram || {};
  return {
    token: telegram.bot_token || telegram.telegram_bot_token || '',
    chatId: telegram.group_id || telegram.telegram_group_id || '',
  };
}

async function telegramApi(token: string, method: string, payload: Record<string, unknown>) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError || 'fetch_failed');
  throw new Error(`telegram_api_${method}_failed: ${message}`);
}

async function validateTopic({
  token,
  chatId,
  threadId,
}: {
  token: string;
  chatId: string | number;
  threadId: string | number;
}) {
  if (!threadId) return { ok: false, reason: 'missing_thread_id' };
  const result = await telegramApi(token, 'sendChatAction', {
    chat_id: chatId,
    message_thread_id: Number(threadId),
    action: 'typing',
  });
  if (result.body?.ok === true) return { ok: true, reason: null };
  return {
    ok: false,
    reason: sanitizeTelegramError(result.body?.description || `telegram_http_${result.status}`),
  };
}

async function createTopic({
  token,
  chatId,
  name,
  iconColor,
}: {
  token: string;
  chatId: string | number;
  name: string;
  iconColor: number;
}) {
  const result = await telegramApi(token, 'createForumTopic', {
    chat_id: chatId,
    name,
    icon_color: iconColor,
  });
  const threadId = result.body?.result?.message_thread_id;
  if (result.body?.ok === true && threadId) return { ok: true, threadId: String(threadId), error: null };
  return {
    ok: false,
    threadId: null,
    error: sanitizeTelegramError(result.body?.description || `telegram_http_${result.status}`),
  };
}

async function reopenTopic({
  token,
  chatId,
  threadId,
}: {
  token: string;
  chatId: string | number;
  threadId: string | number;
}) {
  const result = await telegramApi(token, 'reopenForumTopic', {
    chat_id: chatId,
    message_thread_id: Number(threadId),
  });
  const description = String(result.body?.description || '');
  return {
    ok: result.body?.ok === true || /TOPIC_NOT_MODIFIED|topic.*not.*closed/i.test(description),
    error: result.body?.ok === true ? null : sanitizeTelegramError(description || `telegram_http_${result.status}`),
  };
}

async function sendWakeMessage({
  token,
  chatId,
  threadId,
  text,
}: {
  token: string;
  chatId: string | number;
  threadId: string | number;
  text: string;
}) {
  const payload = {
    chat_id: chatId,
    message_thread_id: Number(threadId),
    text,
    disable_notification: true,
  };
  let result = await telegramApi(token, 'sendMessage', payload);
  const firstDescription = String(result.body?.description || '');
  if (result.body?.ok === true) return { ok: true, reopened: false, error: null };
  if (/TOPIC_CLOSED|topic is closed/i.test(firstDescription)) {
    const reopened = await reopenTopic({ token, chatId, threadId });
    if (!reopened.ok) return { ok: false, reopened: false, error: reopened.error || 'topic_reopen_failed' };
    result = await telegramApi(token, 'sendMessage', payload);
    if (result.body?.ok === true) return { ok: true, reopened: true, error: null };
  }
  return {
    ok: false,
    reopened: false,
    error: sanitizeTelegramError(result.body?.description || `telegram_http_${result.status}`),
  };
}

function wakeMessageFor(topicKey: string): string {
  const labelByKey: Record<string, string> = {
    ops_work: '실무 알림',
    ops_reports: '레포트 알림',
    ops_error_resolution: '오류 해결',
    ops_emergency: '긴급 알림',
  };
  return `[Hub] ${labelByKey[topicKey] || topicKey} 토픽 라우팅 확인 메시지입니다.`;
}

function isMissingThreadError(reason: string): boolean {
  return /message thread not found|thread not found|TOPIC_ID_INVALID/i.test(String(reason || ''));
}

export async function ensureTelegramClassTopics({
  apply = false,
  announce = false,
}: {
  apply?: boolean;
  announce?: boolean;
} = {}) {
  const store = readStore();
  const { token, chatId } = readCredentials(store);
  if (!token || !chatId) throw new Error('telegram_credentials_missing');

  const topicIds = store.telegram?.topic_ids || store.telegram?.telegram_topic_ids || {};
  const nextTopicIds: Record<string, string> = {};
  const kept: string[] = [];
  const created: string[] = [];
  const wouldCreate: string[] = [];
  const announced: string[] = [];
  const reopened: string[] = [];
  const recreated: string[] = [];
  const failed: Array<{ key: string; reason: string }> = [];

  for (const topic of CLASS_TOPICS) {
    const currentThreadId = topicIds[topic.key];
    const validation = await validateTopic({ token, chatId, threadId: currentThreadId });
    if (validation.ok) {
      nextTopicIds[topic.key] = String(currentThreadId);
      kept.push(topic.key);
      continue;
    }

    if (!apply) {
      wouldCreate.push(topic.key);
      continue;
    }

    const creation = await createTopic({
      token,
      chatId,
      name: topic.name,
      iconColor: topic.icon_color,
    });
    if (!creation.ok || !creation.threadId) {
      failed.push({ key: topic.key, reason: creation.error || 'create_topic_failed' });
      continue;
    }
    nextTopicIds[topic.key] = creation.threadId;
    created.push(topic.key);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  if (apply && failed.length === 0) {
    store.telegram = store.telegram || {};
    store.telegram.topic_alias_mode = 'class_topics';
    store.telegram.topic_ids = nextTopicIds;
    delete store.telegram.telegram_topic_ids;
    store.reservation = store.reservation || {};
    store.reservation.telegram_topic_ids = {};
    writeStore(store);
  }

  if (announce && failed.length === 0) {
    for (const topic of CLASS_TOPICS) {
      const threadId = nextTopicIds[topic.key];
      if (!threadId) {
        failed.push({ key: topic.key, reason: 'missing_thread_id_after_ensure' });
        continue;
      }
      const sent = await sendWakeMessage({
        token,
        chatId,
        threadId,
        text: wakeMessageFor(topic.key),
      });
      if (!sent.ok) {
        if (apply && isMissingThreadError(sent.error || '')) {
          const creation = await createTopic({
            token,
            chatId,
            name: topic.name,
            iconColor: topic.icon_color,
          });
          if (!creation.ok || !creation.threadId) {
            failed.push({ key: topic.key, reason: creation.error || 'recreate_topic_failed' });
            continue;
          }
          nextTopicIds[topic.key] = creation.threadId;
          created.push(topic.key);
          recreated.push(topic.key);
          await new Promise((resolve) => setTimeout(resolve, 600));
          const retrySent = await sendWakeMessage({
            token,
            chatId,
            threadId: creation.threadId,
            text: wakeMessageFor(topic.key),
          });
          if (!retrySent.ok) {
            failed.push({ key: topic.key, reason: retrySent.error || 'wake_message_after_recreate_failed' });
            continue;
          }
          announced.push(topic.key);
          if (retrySent.reopened) reopened.push(topic.key);
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        failed.push({ key: topic.key, reason: sent.error || 'wake_message_failed' });
        continue;
      }
      announced.push(topic.key);
      if (sent.reopened) reopened.push(topic.key);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (apply && failed.length === 0 && recreated.length > 0) {
      store.telegram = store.telegram || {};
      store.telegram.topic_alias_mode = 'class_topics';
      store.telegram.topic_ids = nextTopicIds;
      delete store.telegram.telegram_topic_ids;
      store.reservation = store.reservation || {};
      store.reservation.telegram_topic_ids = {};
      writeStore(store);
    }
  }

  return {
    ok: failed.length === 0 && (apply || wouldCreate.length === 0),
    apply,
    announce,
    required: CLASS_TOPICS.map((topic) => topic.key),
    kept,
    created,
    recreated,
    would_create: wouldCreate,
    announced,
    reopened,
    failed,
    updated_store: apply && failed.length === 0,
    note: 'Secrets, chat ids, and thread ids are intentionally omitted.',
  };
}

async function main() {
  const result = await ensureTelegramClassTopics({
    apply: hasFlag('apply'),
    announce: hasFlag('announce'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[telegram-ensure-class-topics] failed:', sanitizeTelegramError(error?.message || error));
    process.exit(1);
  });
}

module.exports = {
  ensureTelegramClassTopics,
};

#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const storePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');
const OPS_TOPIC_NAME_BY_KEY: Record<string, string> = {
  ops_work: '실무 알림',
  ops_reports: '레포트 알림',
  ops_error_resolution: '오류 해결',
  ops_emergency: '긴급 알림',
};
const LEGACY_TOPIC_NAME_PATTERNS = [
  /^(일반|스카|루나|클로드|팀장|회의록|회의|예약)$/i,
  /^(general|ska|luna|investment|claude|claude_lead|blog|worker|video|darwin|justin|sigma|meeting|emergency|legal)$/i,
];

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readStore(): Record<string, any> {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

function sanitizeTelegramError(value: unknown): string {
  return String(value || '')
    .replace(/[0-9]{4,}/g, '[id]')
    .slice(0, 140);
}

function normalizeThreadId(value: unknown): string {
  return String(value || '').trim();
}

function isLegacyTopicName(name: string): boolean {
  return LEGACY_TOPIC_NAME_PATTERNS.some((pattern) => pattern.test(String(name || '').trim()));
}

async function readTopicEventsFromTelegram({
  token,
  chatId,
}: {
  token: string;
  chatId: string | number;
}): Promise<Array<{ threadId: string; name: string; kind: string }>> {
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeout: 0,
          limit: 100,
          allowed_updates: ['message'],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      break;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  if (!response) return [];
  const body = await response.json().catch(() => ({}));
  if (body?.ok !== true || !Array.isArray(body?.result)) return [];
  const rows = [];
  for (const update of body.result) {
    const message = update?.message || {};
    if (normalizeThreadId(message?.chat?.id) !== normalizeThreadId(chatId)) continue;
    const created = message?.forum_topic_created?.name;
    if (!created) continue;
    const threadId = normalizeThreadId(message?.message_thread_id);
    if (!threadId) continue;
    rows.push({ threadId, name: String(created), kind: 'created' });
  }
  return rows;
}

async function closeTopic({
  token,
  chatId,
  threadId,
}: {
  token: string;
  chatId: string | number;
  threadId: string | number;
}) {
  let response;
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/closeForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: Number(threadId) }),
        signal: AbortSignal.timeout(15_000),
      });
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  if (!response) {
    return {
      ok: false,
      closed_now: false,
      already_closed: false,
      retry_after: 0,
      error: sanitizeTelegramError(lastError?.message || 'telegram_fetch_failed'),
    };
  }
  const body = await response.json().catch(() => ({}));
  const description = String(body?.description || '');
  const alreadyClosed = /TOPIC_NOT_MODIFIED|TOPIC_CLOSED/i.test(description);
  const notFound = /not found|message thread not found|thread not found|TOPIC_ID_INVALID/i.test(description);
  return {
    ok: body?.ok === true || alreadyClosed || notFound,
    closed_now: body?.ok === true,
    already_closed: alreadyClosed || notFound,
    retry_after: Number(body?.parameters?.retry_after || 0) || 0,
    error: body?.ok === true || alreadyClosed || notFound ? null : sanitizeTelegramError(description || `telegram_http_${response.status}`),
  };
}

async function deleteTopic({
  token,
  chatId,
  threadId,
}: {
  token: string;
  chatId: string | number;
  threadId: string | number;
}) {
  let response;
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: Number(threadId) }),
        signal: AbortSignal.timeout(15_000),
      });
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  if (!response) {
    return {
      ok: false,
      deleted_now: false,
      already_deleted: false,
      retry_after: 0,
      error: sanitizeTelegramError(lastError?.message || 'telegram_fetch_failed'),
    };
  }
  const body = await response.json().catch(() => ({}));
  const description = String(body?.description || '');
  const alreadyDeleted = /not found|message thread not found|thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(description);
  return {
    ok: body?.ok === true || alreadyDeleted,
    deleted_now: body?.ok === true,
    already_deleted: alreadyDeleted,
    retry_after: Number(body?.parameters?.retry_after || 0) || 0,
    error: body?.ok === true || alreadyDeleted ? null : sanitizeTelegramError(description || `telegram_http_${response.status}`),
  };
}

export async function closeRetiredTelegramTopics({
  dryRun = true,
  includeUpdateEvents = true,
  deleteMode = false,
}: {
  dryRun?: boolean;
  includeUpdateEvents?: boolean;
  deleteMode?: boolean;
} = {}) {
  const store = readStore();
  const token = store.telegram?.bot_token || store.telegram?.telegram_bot_token || '';
  const chatId = store.telegram?.group_id || store.telegram?.telegram_group_id || '';
  if (!token || !chatId) throw new Error('telegram_credentials_missing');

  const retired = store.telegram?.retired_topic_ids || {};
  const topicIds = store.telegram?.topic_ids || store.telegram?.telegram_topic_ids || {};
  const currentOpsThreadIds = new Set(
    Object.keys(OPS_TOPIC_NAME_BY_KEY)
      .map((key) => normalizeThreadId(topicIds[key]))
      .filter(Boolean),
  );
  const unique = new Map<string, { aliases: string[]; threadId: string }>();
  for (const [alias, threadId] of Object.entries(retired)) {
    const key = normalizeThreadId(threadId);
    if (!key) continue;
    if (currentOpsThreadIds.has(key)) continue;
    const row = unique.get(key) || { aliases: [], threadId: key };
    row.aliases.push(String(alias));
    unique.set(key, row);
  }
  let updateEventCandidates = 0;
  if (includeUpdateEvents) {
    const opsKeyByName = new Map(Object.entries(OPS_TOPIC_NAME_BY_KEY).map(([key, name]) => [name, key]));
    for (const event of await readTopicEventsFromTelegram({ token, chatId })) {
      const opsKey = opsKeyByName.get(event.name);
      const shouldCloseClassDuplicate = Boolean(opsKey) && !currentOpsThreadIds.has(event.threadId);
      const shouldCloseLegacyTopic = isLegacyTopicName(event.name);
      if (!shouldCloseClassDuplicate && !shouldCloseLegacyTopic) continue;
      if (currentOpsThreadIds.has(event.threadId)) continue;
      const row = unique.get(event.threadId) || { aliases: [], threadId: event.threadId };
      const alias = shouldCloseClassDuplicate
        ? `duplicate.${opsKey}`
        : `legacy_event.${event.name}`;
      if (!row.aliases.includes(alias)) row.aliases.push(alias);
      unique.set(event.threadId, row);
      updateEventCandidates += 1;
    }
  }

  const rows = [...unique.values()];
  const results = [];
  for (const row of rows) {
    if (dryRun) {
      results.push({ aliases: row.aliases, ok: true, dry_run: true, action: deleteMode ? 'delete' : 'close' });
      continue;
    }
    let result = deleteMode
      ? await deleteTopic({ token, chatId, threadId: row.threadId })
      : await closeTopic({ token, chatId, threadId: row.threadId });
    if (!result.ok && result.retry_after > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60, result.retry_after) * 1000));
      result = deleteMode
        ? await deleteTopic({ token, chatId, threadId: row.threadId })
        : await closeTopic({ token, chatId, threadId: row.threadId });
    }
    results.push({
      aliases: row.aliases,
      ok: result.ok,
      action: deleteMode ? 'delete' : 'close',
      closed_now: result.closed_now,
      already_closed: result.already_closed,
      deleted_now: result.deleted_now,
      already_deleted: result.already_deleted,
      error: result.error,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    ok: results.every((row) => row.ok),
    dry_run: dryRun,
    action: deleteMode ? 'delete' : 'close',
    attempted: rows.length,
    update_event_candidates: updateEventCandidates,
    closed_now: results.filter((row) => row.closed_now).length,
    already_closed: results.filter((row) => row.already_closed).length,
    deleted_now: results.filter((row) => row.deleted_now).length,
    already_deleted: results.filter((row) => row.already_deleted).length,
    failed: results.filter((row) => !row.ok),
  };
}

async function main() {
  const result = await closeRetiredTelegramTopics({
    dryRun: !hasFlag('apply'),
    deleteMode: hasFlag('delete'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[telegram-retired-topic-janitor] failed:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  closeRetiredTelegramTopics,
};

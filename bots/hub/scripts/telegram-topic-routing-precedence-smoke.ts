import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENDER_TS = require.resolve('../../../packages/core/lib/telegram-sender.ts');
const ENV_TS = require.resolve('../../../packages/core/lib/env.ts');

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID,
  TELEGRAM_TOPIC_OPS_WORK: process.env.TELEGRAM_TOPIC_OPS_WORK,
  TELEGRAM_TOPIC_OPS_REPORTS: process.env.TELEGRAM_TOPIC_OPS_REPORTS,
  TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION,
  TELEGRAM_TOPIC_OPS_EMERGENCY: process.env.TELEGRAM_TOPIC_OPS_EMERGENCY,
  HUB_ALARM_USE_CLASS_TOPICS: process.env.HUB_ALARM_USE_CLASS_TOPICS,
  TELEGRAM_ALERTS_DISABLED: process.env.TELEGRAM_ALERTS_DISABLED,
};
const originalFetch = globalThis.fetch;

function resetModules() {
  delete require.cache[SENDER_TS];
  delete require.cache[ENV_TS];
}

async function runCase({
  tempRoot,
  envGroupId,
  expectedChatId,
}: {
  tempRoot: string;
  envGroupId?: string;
  expectedChatId: string;
}) {
  const calls: Array<{ body: any }> = [];
  process.env.PROJECT_ROOT = tempRoot;
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = '123456789';
  if (envGroupId) process.env.TELEGRAM_GROUP_ID = envGroupId;
  else delete process.env.TELEGRAM_GROUP_ID;
  delete process.env.TELEGRAM_TOPIC_OPS_WORK;
  delete process.env.TELEGRAM_TOPIC_OPS_REPORTS;
  delete process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION;
  delete process.env.TELEGRAM_TOPIC_OPS_EMERGENCY;
  delete process.env.HUB_ALARM_USE_CLASS_TOPICS;
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  resetModules();
  const sender = require('../../../packages/core/lib/telegram-sender.ts');
  const delivered = await sender.sendFromHubAlarm('luna', 'topic routing precedence smoke');
  assert.equal(delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, expectedChatId);
  assert.equal(calls[0].body.message_thread_id, 42);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-telegram-precedence-'));
  const storePath = path.join(tempRoot, 'bots', 'hub', 'secrets-store.json');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify({
    telegram: {
      ['bot_' + 'token']: 'topic-routing-bot-token-fixture',
      group_id: '-1001234567890',
      chat_id: '123456789',
      topic_ids: {
        luna: 42,
        general: 1,
      },
    },
  })}\n`, 'utf8');

  try {
    await runCase({
      tempRoot,
      expectedChatId: '-1001234567890',
    });
    await runCase({
      tempRoot,
      envGroupId: '-1009999999999',
      expectedChatId: '-1009999999999',
    });

    process.env.PROJECT_ROOT = tempRoot;
    process.env.TELEGRAM_CHAT_ID = '123456789';
    process.env.TELEGRAM_GROUP_ID = '-1009999999999';
    process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';
    process.env.TELEGRAM_TOPIC_OPS_WORK = '77';
    process.env.TELEGRAM_TOPIC_OPS_REPORTS = '78';
    process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION = '79';
    process.env.TELEGRAM_TOPIC_OPS_EMERGENCY = '80';
    process.env.TELEGRAM_ALERTS_DISABLED = 'false';
    const calls: Array<{ body: any }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      calls.push({ body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    resetModules();
    const sender = require('../../../packages/core/lib/telegram-sender.ts');
    const delivered = await sender.sendFromHubAlarm('luna', 'ops topic env routing smoke');
    assert.equal(delivered, true);
    assert.equal(calls[0].body.message_thread_id, '77');
    assert.equal(sender._testOnly_resolveDeliveryTeam('luna', 'task completed'), 'ops-work');
    assert.equal(sender._testOnly_resolveDeliveryTeam('luna', 'daily report summary'), 'ops-reports');
    assert.equal(sender._testOnly_resolveDeliveryTeam('luna', 'provider_cooldown error'), 'ops-error-resolution');
    assert.equal(sender._testOnly_resolveDeliveryTeam('luna', 'CRITICAL emergency'), 'ops-emergency');

    console.log(JSON.stringify({
      ok: true,
      topic_routing_chat_precedence: ['TELEGRAM_GROUP_ID', 'hub.telegram.group_id', 'TELEGRAM_CHAT_ID'],
      class_topic_override: ['ops-work', 'ops-reports', 'ops-error-resolution', 'ops-emergency'],
    }));
  } finally {
    resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[telegram-topic-routing-precedence-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

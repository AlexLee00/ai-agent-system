#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENDER_TS = require.resolve('../../../packages/core/lib/telegram-sender.ts');
const ENV_TS = require.resolve('../../../packages/core/lib/env.ts');
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function resetModules() {
  delete require.cache[SENDER_TS];
  delete require.cache[ENV_TS];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-telegram-personal-fallback-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  const storePath = path.join(tempRoot, 'bots', 'hub', 'secrets-store.json');
  const telegramBotTokenKey = ['bot', 'token'].join('_');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify({
    telegram: {
      [telegramBotTokenKey]: 'hub-telegram-personal-fallback-placeholder',
      chat_id: '123456789',
      topic_ids: { luna: 15 },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  process.env.HUB_RUNTIME_DIR = runtimeDir;
  process.env.TELEGRAM_CHAT_ID = '123456789';
  delete process.env.TELEGRAM_GROUP_ID;
  delete process.env.TELEGRAM_ALLOW_PERSONAL_FALLBACK;
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';

  const calls: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), body: String(init?.body || '') });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    resetModules();
    const sender = require('../../../packages/core/lib/telegram-sender.ts');
    const delivered = await sender.sendFromHubAlarm('luna', 'personal fallback guard smoke');
    assert.equal(delivered, false, 'Hub alarm must not deliver to TELEGRAM_CHAT_ID without TELEGRAM_ALLOW_PERSONAL_FALLBACK');
    assert.equal(calls.length, 0, 'Telegram API must not be called with personal chat fallback');
    assert.equal(sender.getLastTelegramSendError(), 'telegram_credentials_missing');

    const pending = path.join(runtimeDir, 'telegram', 'pending-telegrams.jsonl');
    assert.ok(fs.existsSync(pending), 'failed personal fallback guard send should be queued');

    console.log(JSON.stringify({
      ok: true,
      personal_chat_fallback_blocked: true,
      pending_preserved: true,
    }));
  } finally {
    resetModules();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[telegram-personal-fallback-guard-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});

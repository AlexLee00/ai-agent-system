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
  TELEGRAM_ALERTS_DISABLED: process.env.TELEGRAM_ALERTS_DISABLED,
};
const originalFetch = globalThis.fetch;

function resetModules() {
  delete require.cache[SENDER_TS];
  delete require.cache[ENV_TS];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-telegram-secrets-'));
  const storePath = path.join(tempRoot, 'bots', 'hub', 'secrets-store.json');
  const botCredentialFixture = 'hub-telegram-credential-fixture';
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify({
    telegram: {
      ['bot_' + 'token']: botCredentialFixture,
      group_id: '-1001234567890',
      topic_ids: {
        luna: 15,
      },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';

  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url, body });

    assert(url.includes(`/bot${botCredentialFixture}/sendMessage`), 'expected Hub telegram credential in API URL');
    assert.equal(body.chat_id, '-1001234567890');
    assert(String(body.text || '').includes('hub telegram secrets smoke'));

    if (calls.length === 1) {
      assert.equal(body.message_thread_id, 15);
      return new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message thread not found',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    assert.equal(body.message_thread_id, undefined);

    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    resetModules();
    const sender = require('../../../packages/core/lib/telegram-sender.ts');
    const delivered = await sender.sendFromHubAlarm('luna', 'hub telegram secrets smoke');
    assert.equal(delivered, true);
    assert.equal(calls.length, 2);

    console.log(JSON.stringify({
      ok: true,
      secret_source: 'hub_secrets_store',
      delivered,
    }));
  } finally {
    resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[telegram-hub-secrets-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

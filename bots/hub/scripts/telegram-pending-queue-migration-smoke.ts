import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TELEGRAM_SENDER_TS = require.resolve('../../../packages/core/lib/telegram-sender.ts');
const ENV_TS = require.resolve('../../../packages/core/lib/env.ts');
const originalFetch = globalThis.fetch;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function resetSenderModule() {
  delete require.cache[TELEGRAM_SENDER_TS];
  delete require.cache[ENV_TS];
}

function withEnvPatch(patch: Record<string, string | null>, fn: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tg-migrate-'));
  const runtimeDir = path.join(tempDir, 'runtime');
  const legacyWorkspace = path.join(tempDir, 'legacy-workspace');
  const legacyPending = path.join(legacyWorkspace, 'pending-telegrams.jsonl');
  const storePath = path.join(tempDir, 'bots', 'hub', 'secrets-store.json');

  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify({
    telegram: {
      ['bot_' + 'token']: 'pending-topic-rebind-bot-token-fixture',
      group_id: '-1001234567890',
      topic_ids: {
        luna: 4242,
        general: 1,
      },
    },
  })}\n`, 'utf8');
  fs.writeFileSync(legacyPending, `${JSON.stringify({
    team: 'luna',
    message: 'legacy pending queue smoke',
    savedAt: new Date().toISOString(),
    retries: 0,
    threadId: 15,
  })}\n`, 'utf8');
  const calls: Array<{ body: any }> = [];

  try {
    await withEnvPatch({
      HUB_RUNTIME_DIR: runtimeDir,
      HUB_TELEGRAM_LEGACY_PENDING_WORKSPACE: legacyWorkspace,
      PROJECT_ROOT: tempDir,
      MODE: 'dev',
      HUB_ALARM_USE_CLASS_TOPICS: null,
      TELEGRAM_BOT_TOKEN: null,
      TELEGRAM_CHAT_ID: null,
      TELEGRAM_TOPIC_OPS_WORK: null,
      TELEGRAM_TOPIC_OPS_REPORTS: null,
      TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: null,
      TELEGRAM_TOPIC_OPS_EMERGENCY: null,
    }, async () => {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        calls.push({ body });
        return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      resetSenderModule();
      const sender = require('../../../packages/core/lib/telegram-sender.ts');
      const paths = sender._testOnly_getPendingQueuePaths();

      assert(
        String(paths.pendingFile || '').startsWith(path.join(runtimeDir, 'telegram')),
        `expected runtime pending path under HUB_RUNTIME_DIR, got: ${paths.pendingFile}`,
      );
      assert(fs.existsSync(legacyPending), 'expected legacy pending queue to exist before flush');

      await sender.flushPending();

      assert(!fs.existsSync(legacyPending), 'expected legacy pending queue to be migrated');
      assert(!fs.existsSync(paths.pendingFile), 'expected delivered migrated queue to be removed');
      assert(calls.length === 1, 'expected one Telegram send attempt for migrated pending queue');
      assert(
        calls[0].body.message_thread_id === 4242,
        `expected migrated pending queue to rebind current topic id, got: ${calls[0].body.message_thread_id}`,
      );
    });

    console.log('telegram_pending_queue_migration_smoke_ok');
  } finally {
    resetSenderModule();
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[telegram-pending-queue-migration-smoke] failed:', error?.message || error);
  process.exit(1);
});

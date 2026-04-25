import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TELEGRAM_SENDER_TS = require.resolve('../../../packages/core/lib/telegram-sender.ts');
const ENV_TS = require.resolve('../../../packages/core/lib/env.ts');

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

  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(legacyPending, `${JSON.stringify({
    team: 'general',
    message: 'legacy pending queue smoke',
    savedAt: new Date().toISOString(),
    retries: 0,
  })}\n`, 'utf8');

  try {
    await withEnvPatch({
      HUB_RUNTIME_DIR: runtimeDir,
      OPENCLAW_WORKSPACE: legacyWorkspace,
      PROJECT_ROOT: tempDir,
      MODE: 'dev',
      TELEGRAM_BOT_TOKEN: null,
      TELEGRAM_CHAT_ID: null,
    }, async () => {
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
      assert(fs.existsSync(paths.pendingFile), 'expected runtime pending queue file after migration');

      const migratedContent = fs.readFileSync(paths.pendingFile, 'utf8');
      assert(
        migratedContent.includes('legacy pending queue smoke'),
        'expected migrated runtime queue to keep legacy message',
      );
    });

    console.log('telegram_pending_queue_migration_smoke_ok');
  } finally {
    resetSenderModule();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[telegram-pending-queue-migration-smoke] failed:', error?.message || error);
  process.exit(1);
});

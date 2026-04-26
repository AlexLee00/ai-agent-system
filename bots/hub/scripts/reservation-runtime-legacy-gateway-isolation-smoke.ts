const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RETIRED_GATEWAY_PATTERN = new RegExp('open' + 'claw', 'i');

const STRICT_LEGACY_FREE_FILES = [
  'bots/reservation/lib/runtime-paths.ts',
  'bots/reservation/src/ska.ts',
  'bots/reservation/src/inspect-naver.ts',
  'bots/reservation/src/init-naver-booking-session.ts',
  'bots/reservation/scripts/pickko-revenue-backfill.ts',
  'bots/reservation/scripts/backup-db.ts',
  'bots/reservation/src/bug-report.ts',
  'bots/reservation/lib/telegram.ts',
  'bots/reservation/lib/ska-team.ts',
  'bots/reservation/manual/reservation/pickko-query.ts',
  'bots/reservation/auto/monitors/naver-monitor.ts',
  'bots/reservation/auto/monitors/pickko-kiosk-monitor.ts',
];

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoRetiredGatewayDefault(relPath) {
  const content = readRepoFile(relPath);
  const match = content.match(RETIRED_GATEWAY_PATTERN);
  assert(!match, `${relPath} must not contain retired gateway runtime defaults`);
}

function assertContains(relPath, needle) {
  const content = readRepoFile(relPath);
  assert(content.includes(needle), `${relPath} must contain ${needle}`);
}

function assertRuntimePathsHubNativeOnly() {
  const relPath = 'bots/reservation/lib/runtime-paths.ts';
  const content = readRepoFile(relPath);

  assert(!RETIRED_GATEWAY_PATTERN.test(content), `${relPath} must not keep retired gateway legacy read fallback`);

  assertContains(relPath, 'getReservationRuntimeDir');
  assertContains(relPath, 'getReadableReservationRuntimeFile');
}

function main() {
  for (const relPath of STRICT_LEGACY_FREE_FILES) {
    assertNoRetiredGatewayDefault(relPath);
  }

  assertRuntimePathsHubNativeOnly();

  console.log(JSON.stringify({
    ok: true,
    strict_legacy_free_files: STRICT_LEGACY_FREE_FILES,
    runtime_paths_hub_native_only: true,
  }, null, 2));
}

main();

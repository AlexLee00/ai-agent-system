const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const STRICT_OPENCLAW_FREE_FILES = [
  'bots/investment/shared/cost-tracker.ts',
  'bots/investment/scripts/pre-market-screen.ts',
  'bots/investment/scripts/health-report.ts',
  'bots/investment/markets/crypto.ts',
  'bots/investment/markets/domestic.ts',
  'bots/investment/markets/overseas.ts',
];

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoOpenClawDefault(relPath) {
  const content = readRepoFile(relPath);
  const match = content.match(/openclaw/i);
  assert(!match, `${relPath} must not contain OpenClaw runtime defaults`);
}

function assertContains(relPath, needle) {
  const content = readRepoFile(relPath);
  assert(content.includes(needle), `${relPath} must contain ${needle}`);
}

function assertCommanderLegacyOnly() {
  const relPath = 'bots/investment/luna-commander.cjs';
  const lines = readRepoFile(relPath).split('\n');
  const unexpected = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /openclaw/i.test(line) && !line.includes('LEGACY_INVESTMENT_'));

  assert(
    unexpected.length === 0,
    [
      `${relPath} must only mention OpenClaw in explicit legacy read-compat constants`,
      ...unexpected.map(({ line, number }) => `${number}: ${line}`),
    ].join('\n'),
  );

  assertContains(relPath, 'AI_AGENT_HOME');
  assertContains(relPath, 'INVESTMENT_RUNTIME_DIR');
  assertContains(relPath, 'LEGACY_INVESTMENT_RUNTIME_DIR');
  assertContains(relPath, 'LEGACY_INVESTMENT_STATE_DIR');
}

function main() {
  for (const relPath of STRICT_OPENCLAW_FREE_FILES) {
    assertNoOpenClawDefault(relPath);
  }

  assertContains('bots/investment/shared/cost-tracker.ts', 'getInvestmentStateFile');
  assertContains('bots/investment/scripts/pre-market-screen.ts', 'getInvestmentStateFile');
  assertContains('bots/investment/scripts/health-report.ts', 'INVESTMENT_RUNTIME_DIR');
  assertCommanderLegacyOnly();

  console.log(JSON.stringify({
    ok: true,
    strict_openclaw_free_files: STRICT_OPENCLAW_FREE_FILES,
    commander_legacy_read_compat_only: true,
  }, null, 2));
}

main();

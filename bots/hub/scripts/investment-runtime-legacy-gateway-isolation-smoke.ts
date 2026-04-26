const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RETIRED_GATEWAY_PATTERN = new RegExp('open' + 'claw', 'i');

const STRICT_LEGACY_FREE_FILES = [
  'bots/investment/luna-commander.cjs',
  'bots/investment/launchd/ai.investment.commander.plist',
  'bots/investment/shared/market-cycle-support.ts',
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

function assertNoRetiredGatewayDefault(relPath) {
  const content = readRepoFile(relPath);
  const match = content.match(RETIRED_GATEWAY_PATTERN);
  assert(!match, `${relPath} must not contain retired gateway runtime defaults`);
}

function assertContains(relPath, needle) {
  const content = readRepoFile(relPath);
  assert(content.includes(needle), `${relPath} must contain ${needle}`);
}

function main() {
  for (const relPath of STRICT_LEGACY_FREE_FILES) {
    assertNoRetiredGatewayDefault(relPath);
  }

  assertContains('bots/investment/shared/cost-tracker.ts', 'getInvestmentStateFile');
  assertContains('bots/investment/scripts/pre-market-screen.ts', 'getInvestmentStateFile');
  assertContains('bots/investment/scripts/health-report.ts', 'INVESTMENT_RUNTIME_DIR');
  assertContains('bots/investment/luna-commander.cjs', 'AI_AGENT_HOME');
  assertContains('bots/investment/luna-commander.cjs', 'INVESTMENT_RUNTIME_DIR');

  console.log(JSON.stringify({
    ok: true,
    strict_legacy_free_files: STRICT_LEGACY_FREE_FILES,
    commander_hub_native_only: true,
  }, null, 2));
}

main();

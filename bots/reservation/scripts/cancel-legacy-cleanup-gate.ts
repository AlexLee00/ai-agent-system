// @ts-nocheck
'use strict';

const {
  evaluateCancelLegacyCleanupGate,
  readCancelShadowHistory,
} = require('../lib/cancel-shadow-history');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: argv.includes('--json'),
    days: 3,
    historyLimit: 100,
  };
  for (const arg of argv) {
    if (arg.startsWith('--days=')) args.days = Number(arg.slice('--days='.length));
    if (arg.startsWith('--history-limit=')) args.historyLimit = Number(arg.slice('--history-limit='.length));
  }
  return args;
}

function buildCancelLegacyCleanupGate(args = {}) {
  const history = readCancelShadowHistory({ limit: args.historyLimit || 100 });
  return evaluateCancelLegacyCleanupGate({ history, days: args.days || 3 });
}

async function main() {
  const args = parseArgs();
  const result = buildCancelLegacyCleanupGate(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`cancel-legacy-cleanup-gate ${result.ready ? 'ready' : 'blocked'} ${JSON.stringify(result.blockers)}`);
  }
  process.exit(result.ready ? 0 : 1);
}

module.exports = {
  parseArgs,
  buildCancelLegacyCleanupGate,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

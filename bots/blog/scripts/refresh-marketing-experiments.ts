#!/usr/bin/env node
'use strict';

const {
  syncRecentExperimentRuns,
  buildExperimentPlaybook,
  PLAYBOOK_PATH,
} = require('../lib/experiment-os.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sync = await syncRecentExperimentRuns(30);
  const playbook = await buildExperimentPlaybook({ days: 30, persist: !args.dryRun });
  const payload = {
    dryRun: args.dryRun,
    sync,
    playbookPath: PLAYBOOK_PATH,
    playbook,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[marketing experiments] dryRun=${args.dryRun} sample=${playbook.sampleCount} top=${playbook.topWinner?.dimension || 'none'}:${playbook.topWinner?.variant || 'none'}`);
}

main().catch((error) => {
  console.error('[marketing experiments] 실패:', error?.message || error);
  process.exit(1);
});

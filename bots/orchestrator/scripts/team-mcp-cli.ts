// @ts-nocheck
'use strict';

const { parseArgs } = require('../../reservation/lib/args');
const mcp = require('../../../packages/core/lib/mcp');

async function main() {
  const args = parseArgs(process.argv);
  const team = String(args.team || '').toLowerCase();
  const task = String(args.task || 'general');

  if (!team) {
    console.log(JSON.stringify({
      success: false,
      message: 'usage: --team darwin|justin|sigma --task research|citation|quality',
    }));
    process.exitCode = 1;
    return;
  }

  const recommended = mcp.recommendMcps(team, task);
  const plan = mcp.buildMcpPlan(team, task);

  console.log(JSON.stringify({
    success: true,
    team,
    task,
    recommended,
    plan,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

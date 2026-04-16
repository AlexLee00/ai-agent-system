// @ts-nocheck
'use strict';

const fs = require('fs');
const { parseArgs } = require('../../reservation/lib/args');
const pipeline = require('../../../packages/core/lib/team-skill-mcp-pipeline');

function loadInput(args) {
  if (args.file) {
    return JSON.parse(fs.readFileSync(args.file, 'utf8'));
  }
  if (args.input) {
    return JSON.parse(args.input);
  }
  return {};
}

async function main() {
  const args = parseArgs(process.argv);
  const team = args.team;
  const task = args.task;

  if (!team || !task) {
    console.log(JSON.stringify({
      success: false,
      message: 'usage: --team darwin|justin|sigma --task research|citation|quality [--file path | --input json]',
    }));
    process.exitCode = 1;
    return;
  }

  const payload = loadInput(args);
  const result = pipeline.buildTeamPipeline({
    team,
    task,
    payload,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});


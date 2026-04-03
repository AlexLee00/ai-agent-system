#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseArgs } = require('../../reservation/lib/args');
const workflows = require('../../../packages/core/lib/workflows');

const MAP = {
  review: workflows.reviewWorkflow,
  qa: workflows.qaWorkflow,
  ship: workflows.shipWorkflow,
  retro: workflows.retroWorkflow,
};

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
  const workflowName = String(process.argv[2] || args.workflow || '').toLowerCase();
  const runner = MAP[workflowName];

  if (!runner) {
    console.log(JSON.stringify({
      success: false,
      message: 'usage: workflow-cli.js review|qa|ship|retro [--file path | --input json]',
    }));
    process.exitCode = 1;
    return;
  }

  const input = loadInput(args);
  const result = runner.run(input);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

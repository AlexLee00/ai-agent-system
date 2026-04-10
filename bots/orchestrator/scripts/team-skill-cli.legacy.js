#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseArgs } = require('../../reservation/lib/args');
const darwin = require('../../../packages/core/lib/skills/darwin/source-ranking');
const justin = require('../../../packages/core/lib/skills/justin/citation-audit');
const sigma = require('../../../packages/core/lib/skills/sigma/data-quality-guard');

const SKILL_MAP = {
  'darwin/source-ranking': (input) => darwin.rankSources(input.items || []),
  'justin/citation-audit': (input) => justin.auditCitations(input.citations || []),
  'sigma/data-quality-guard': (input) => sigma.evaluateDataset(input || {}),
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
  const skill = args.skill;
  const runner = SKILL_MAP[skill];

  if (!runner) {
    console.log(JSON.stringify({
      success: false,
      message: 'usage: --skill darwin/source-ranking|justin/citation-audit|sigma/data-quality-guard [--file path | --input json]',
    }));
    process.exitCode = 1;
    return;
  }

  const payload = loadInput(args);
  const result = runner(payload);

  console.log(JSON.stringify({
    success: true,
    skill,
    result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

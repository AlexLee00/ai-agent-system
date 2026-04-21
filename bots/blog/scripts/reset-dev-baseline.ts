#!/usr/bin/env node
'use strict';

const { writeDevelopmentBaseline } = require('../lib/dev-baseline.ts');

function parseArgs(argv = []) {
  const noteArg = argv.find((item) => item.startsWith('--note='));
  const json = argv.includes('--json');
  return {
    json,
    note: noteArg ? noteArg.slice('--note='.length).trim() : '',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = writeDevelopmentBaseline({
    source: 'dev-test-reset',
    note: args.note || 'development and test baseline reset',
  });

  const payload = {
    ok: true,
    baseline: {
      startedAt: baseline.startedAtIso,
      source: baseline.source,
      note: baseline.note,
      path: baseline.path,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[blog dev baseline] reset complete');
  console.log(`- startedAt: ${baseline.startedAtIso}`);
  console.log(`- source: ${baseline.source}`);
  if (baseline.note) console.log(`- note: ${baseline.note}`);
  console.log(`- path: ${baseline.path}`);
}

main();

#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const aggregatorPath = path.join(repoRoot, 'bots/orchestrator/lib/write/report-aggregator.ts');
const source = fs.readFileSync(aggregatorPath, 'utf8');
const aggregator = require(aggregatorPath) as {
  buildLocalNodeArgs: (args: string[]) => string[];
};

assert.equal(
  source.includes('execSync(`/opt/homebrew/bin/tsx'),
  false,
  'report aggregator must not shell out through direct tsx; it leaks Node 26 DEP0205 warnings to orchestrator-error.log',
);
assert.match(source, /--disable-warning=DEP0205/, 'report aggregator child node runner must suppress Node 26 tsx DEP0205 warnings');

const args = aggregator.buildLocalNodeArgs(['bots/investment/scripts/health-report.ts', '--json']);
assert.deepEqual(args.slice(0, 3), ['--disable-warning=DEP0205', '--import', 'tsx']);
assert.deepEqual(args.slice(3), ['bots/investment/scripts/health-report.ts', '--json']);

console.log('report_aggregator_node_runner_smoke_ok');

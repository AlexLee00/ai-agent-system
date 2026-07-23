#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const ownership = JSON.parse(read('packages/core/config/service-ownership.json'));
const retired = ownership.find((entry: any) => entry.label === 'ai.orchestrator');
assert.equal(retired?.retired, true, 'ai.orchestrator must remain retired in the ownership SSOT');

assert.equal(
  fs.existsSync(path.join(repoRoot, 'bots/orchestrator/launchd/ai.orchestrator.plist')),
  false,
  'retired ai.orchestrator must not remain in the active launchd directory',
);
assert.equal(
  fs.existsSync(path.join(repoRoot, 'bots/orchestrator/launchd/retired/ai.orchestrator.plist')),
  true,
  'retired launchd definition must remain available as audit evidence',
);

const packageJson = JSON.parse(read('bots/orchestrator/package.json'));
assert.match(packageJson.scripts.start, /jay-runtime\.ts/, 'orchestrator package start must target the canonical Jay runtime');

const buildSource = read('scripts/build-daemons.mjs');
assert.doesNotMatch(buildSource, /label:\s*'ai\.orchestrator'/, 'retired daemon must not be built');

const card = JSON.parse(read('bots/orchestrator/a2a/orchestrator-card.json'));
assert.equal(card.url, 'local://launchd/ai.jay.runtime');
assert.match(card.documentationUrl, /bots\/orchestrator\/CLAUDE\.md$/);

console.log('jay_runtime_ownership_smoke_ok');

#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const AGENTS = ['stock_flow', 'sweeper', 'aria', 'sentinel', 'argos'];

export async function runSmoke() {
  const files = AGENTS.map((name) => new URL(`../elixir/lib/luna/v2/agents/${name}.ex`, import.meta.url));
  for (const file of files) {
    assert.equal(existsSync(file), true, `${file.pathname} exists`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /shadow: true/);
  }
  return { ok: true, total: files.length, agents: AGENTS };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ elixir-shadow-agents-smoke agents=${result.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ elixir-shadow-agents-smoke 실패:' });
}

#!/usr/bin/env node
// @ts-nocheck

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const execFileAsync = promisify(execFile);

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const json = process.argv.includes('--json');
  if (maybeSkipForMemory('luna.ppo-retrain', { json })) return;
  const train = process.argv.includes('--train');
  const confirm = argValue('confirm', '') || '';
  const defaultPython = existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3';
  const pythonBin = process.env.LUNA_PYTHON_BIN || defaultPython;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(projectRoot, 'bots/investment/python/rl/weekly-retrain.py');
  const args = [
    scriptPath,
    '--json',
    '--episodes',
    String(Math.max(1, Number(argValue('episodes', '100')) || 100)),
    '--timesteps',
    String(Math.max(1, Number(argValue('timesteps', '2000')) || 2000)),
  ];
  if (train) args.push('--train');
  if (confirm) args.push('--confirm', confirm);
  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: projectRoot,
    timeout: 30 * 60 * 1000,
  });
  const result = JSON.parse(stdout || '{}');
  if (stderr && !json) console.warn(stderr);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-ppo] status=${result.status || 'check'} trainingStarted=${result.training_started}`);
  if (result.ok === false) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});

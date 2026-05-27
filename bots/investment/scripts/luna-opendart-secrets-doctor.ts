#!/usr/bin/env node
// @ts-nocheck

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveOpenDartCredentials, resolveOpenDartCredentialStatus } from '../lib/korea-data/opendart-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runLunaOpenDartSecretsDoctor(options = {}) {
  const status = await resolveOpenDartCredentialStatus({ timeoutMs: Number(options.timeoutMs || 3000) });
  const credentials = await resolveOpenDartCredentials({ timeoutMs: Number(options.timeoutMs || 3000) });
  const python = spawnSync('python3', [
    resolve(INVESTMENT_ROOT, 'python/korea-data/opendart_client.py'),
    '--doctor',
    '--json',
  ], {
    cwd: INVESTMENT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENDART_API_KEY: credentials.apiKey || process.env.OPENDART_API_KEY || '',
      OPENDART_BASE_URL: credentials.baseUrl || process.env.OPENDART_BASE_URL || '',
    },
  });
  let pythonDoctor = null;
  try {
    pythonDoctor = JSON.parse(python.stdout || '{}');
  } catch {
    pythonDoctor = { ok: false, error: 'python_doctor_parse_failed' };
  }
  const ready = Boolean(status.configured);
  return {
    ok: true,
    ready,
    status: ready ? 'opendart_secrets_ready' : 'opendart_secrets_missing',
    valuesRedacted: true,
    required: [
      {
        field: 'opendart.api_key',
        present: Boolean(status.configured),
        source: status.apiKeySource,
        valueRedacted: true,
      },
      {
        field: 'opendart.base_url',
        present: Boolean(status.baseUrl),
        source: status.baseUrl === 'https://opendart.fss.or.kr/api' ? 'default' : 'configured',
        valueRedacted: false,
      },
    ],
    acceptedFallbacks: [
      'OPENDART_API_KEY',
      'OPEN_DART_API_KEY',
      'DART_API_KEY',
      'hub:opendart.api_key',
      'hub:config.opendart.api_key',
      'hub:config.news.dart_api_key',
      'hub:news.dart_api_key',
    ],
    template: options.template ? {
      opendart: {
        api_key: '<OPENDART_API_KEY>',
        base_url: 'https://opendart.fss.or.kr/api',
      },
    } : undefined,
    pythonDoctor,
    nextCommands: [
      'npm --prefix bots/investment run -s secrets-doctor:luna-opendart -- --template',
      'npm --prefix bots/investment run -s runtime:luna-opendart-disclosure-refresh -- --json --fixture',
      'npm --prefix bots/investment run -s runtime:luna-opendart-financial-refresh -- --json --fixture',
      'npm --prefix bots/investment run -s runtime:luna-opendart-financial-batch-refresh -- --json --fixture --limit=2 --no-write',
    ],
  };
}

async function main() {
  const result = await runLunaOpenDartSecretsDoctor({
    template: hasFlag('template'),
    timeoutMs: Number(argValue('timeout-ms', 3000)),
  });
  if (hasFlag('strict') && !result.ready) process.exitCode = 1;
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-opendart-secrets-doctor] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-opendart-secrets-doctor error:' });
}

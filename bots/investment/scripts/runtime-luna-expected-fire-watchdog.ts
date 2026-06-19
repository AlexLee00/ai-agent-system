#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM,
  runExpectedFireWatchdog,
} from '../shared/luna-expected-fire-watchdog.ts';

function hasFlag(argv: string[], name: string) {
  return argv.includes(`--${name}`);
}

function argValue(argv: string[], name: string, fallback: any = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) return next;
  }
  return fallback;
}

export function parseExpectedFireWatchdogCliArgs(argv: string[] = process.argv.slice(2)) {
  const apply = hasFlag(argv, 'apply');
  return {
    apply,
    dryRun: hasFlag(argv, 'dry-run') || !apply,
    confirm: argValue(argv, 'confirm', null),
    limit: Number(argValue(argv, 'limit', 100)),
    lookbackHours: Number(argValue(argv, 'lookback-hours', 24)),
    matchWindowMinutes: Number(argValue(argv, 'match-window-minutes', 30)),
    retentionDays: Number(argValue(argv, 'retention-days', 30)),
  };
}

export async function runRuntimeLunaExpectedFireWatchdog(options: any = {}) {
  const cli = Array.isArray(options.cliArgs)
    ? parseExpectedFireWatchdogCliArgs(options.cliArgs)
    : options.cliArgs || parseExpectedFireWatchdogCliArgs(process.argv.slice(2));
  return runExpectedFireWatchdog({ ...cli, ...options }, options.deps || {});
}

function summarize(result: any = {}) {
  return [
    'Luna expected-fire watchdog 완료',
    `- ok: ${result.ok === true}`,
    `- dry_run: ${result.dryRun === true}`,
    `- scanned: ${result.scanned || 0}`,
    `- silent_misses: ${result.silentMisses || 0}`,
    `- matched: ${result.matched || 0}`,
    `- written: ${result.written || 0}`,
    `- pruned: ${result.pruned || 0}`,
    `- live_mutation: ${result.liveMutation === true}`,
    `- errors: ${result.errors?.length || 0}`,
  ].join('\n');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runRuntimeLunaExpectedFireWatchdog(),
    onSuccess: async (result) => {
      const json = hasFlag(process.argv.slice(2), 'json');
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${summarize(result)}\n`);
      if (result?.blocked) process.exitCode = 2;
    },
    errorPrefix: '❌ luna-expected-fire-watchdog 실패:',
  });
}

export default {
  LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM,
  parseExpectedFireWatchdogCliArgs,
  runRuntimeLunaExpectedFireWatchdog,
};

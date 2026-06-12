#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';
import {
  isValidMeetingChair,
  isValidMeetingType,
  VALID_MEETING_CHAIRS,
  VALID_MEETING_TYPES,
} from '../services/meeting-room/config/meeting.config.ts';
import { regenerateMeetingMinutesMarkdown } from '../services/meeting-room/server/minutes.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValueFromArgv(argv: string[], name: string, fallback: any = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const flagIndex = argv.indexOf(`--${name}`);
  if (flagIndex >= 0) {
    const next = argv[flagIndex + 1];
    if (next && !next.startsWith('--')) return next;
    return fallback;
  }
  return fallback;
}

function assertValidCliType(type: string) {
  if (!isValidMeetingType(type)) {
    throw new Error(`invalid meeting --type=${type}; expected one of ${VALID_MEETING_TYPES.join(',')}`);
  }
  return type;
}

function assertValidCliChair(chair: string) {
  if (!isValidMeetingChair(chair)) {
    throw new Error(`invalid meeting --chair=${chair}; expected one of ${VALID_MEETING_CHAIRS.join(',')}`);
  }
  return chair;
}

export function parseMeetingRoomCliArgs(argv: string[] = process.argv) {
  const type = assertValidCliType(argValueFromArgv(argv, 'type', 'morning'));
  const chair = assertValidCliChair(argValueFromArgv(argv, 'chair', 'luna'));
  const regenerate = argValueFromArgv(argv, 'regenerate', null);
  return {
    type,
    chair,
    dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
    apply: argv.includes('--apply'),
    noLlm: argv.includes('--no-llm'),
    outputPath: argValueFromArgv(argv, 'output', null),
    regenerate,
    forceInsufficientGrill: argv.includes('--force-insufficient-grill'),
  };
}

export function summarizeMeetingRoomResult(result: any) {
  const telegram = result.telegram || {};
  return [
    `Luna Meeting Room ${result.type || 'morning'} 완료`,
    `- dry_run: ${result.dryRun === true}`,
    `- shadow_only: ${result.shadowOnly === true}`,
    `- session: ${result.session?.id || 'dry-run'}`,
    `- minutes: ${result.minutes?.length || 0}`,
    `- decisions: ${result.decisions?.length || 0}`,
    `- telegram: attempted=${telegram.attempted === true} ok=${telegram.ok === true} sent=${telegram.sentCount || 0} pending=${telegram.pendingCount || 0}${telegram.error ? ` error=${telegram.error}` : ''}`,
    `- llm_calls: ${result.llmCalls || 0}`,
    `- skipped_llm_calls: ${result.skippedLlmCalls || 0}`,
    `- markdown: ${result.markdownPath || 'n/a'}`,
  ].join('\n');
}

function writeStdout(text: string) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runRuntimeLunaMeetingRoom(options: any = {}) {
  const cli = options.cliArgs || parseMeetingRoomCliArgs(process.argv);
  const regenerate = options.regenerate ?? options.regenerateSessionId ?? cli.regenerate;
  if (regenerate != null) {
    return regenerateMeetingMinutesMarkdown(regenerate, {
      queryFn: options.queryFn || options.deps?.queryFn,
      outputPath: options.outputPath || cli.outputPath,
      outputDir: options.outputDir,
      preserveExisting: false,
    });
  }
  return runMeetingSession({
    type: options.type || cli.type,
    chair: options.chair || cli.chair,
    dryRun: options.dryRun ?? cli.dryRun,
    apply: options.apply ?? cli.apply,
    noLlm: options.noLlm ?? cli.noLlm,
    outputPath: options.outputPath || cli.outputPath,
    forceInsufficientGrill: options.forceInsufficientGrill ?? cli.forceInsufficientGrill,
  }, options.deps || {});
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runRuntimeLunaMeetingRoom(),
    onSuccess: async (result) => {
      if (hasFlag('json')) await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
      else await writeStdout(`${summarizeMeetingRoomResult(result)}\n`);
    },
    errorPrefix: '❌ luna-meeting-room 실패:',
  });
}

export default {
  parseMeetingRoomCliArgs,
  runRuntimeLunaMeetingRoom,
  summarizeMeetingRoomResult,
};

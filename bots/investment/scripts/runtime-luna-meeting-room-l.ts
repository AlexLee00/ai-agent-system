#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_MEETING_ROOM_L_CONFIRM,
  runMeetingRoomLOps,
} from '../services/meeting-room/server/meeting-room-l-ops.ts';

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

export function parseMeetingRoomLOpsCliArgs(argv: string[] = process.argv.slice(2)) {
  const apply = hasFlag(argv, 'apply');
  return {
    apply,
    dryRun: hasFlag(argv, 'dry-run') || !apply,
    confirm: argValue(argv, 'confirm', null),
    noLlm: hasFlag(argv, 'no-llm'),
    skipDebrief: hasFlag(argv, 'skip-debrief'),
    skipAdr: hasFlag(argv, 'skip-adr'),
    skipCircuit: hasFlag(argv, 'skip-circuit'),
    skipRegime: hasFlag(argv, 'skip-regime'),
    skipDisclosure: hasFlag(argv, 'skip-disclosure'),
    skipDailyLoss: hasFlag(argv, 'skip-daily-loss'),
    skipRisk: hasFlag(argv, 'skip-risk'),
    limit: Number(argValue(argv, 'limit', 20)),
    circuitLookbackHours: Number(argValue(argv, 'circuit-lookback-hours', 24)),
    eventLookbackHours: Number(argValue(argv, 'event-lookback-hours', 24)),
    outputDir: argValue(argv, 'output-dir', null),
    outputPath: argValue(argv, 'output', null),
  };
}

export async function runRuntimeLunaMeetingRoomL(options: any = {}) {
  const cli = Array.isArray(options.cliArgs)
    ? parseMeetingRoomLOpsCliArgs(options.cliArgs)
    : options.cliArgs || parseMeetingRoomLOpsCliArgs(process.argv.slice(2));
  return runMeetingRoomLOps({
    ...cli,
    ...options,
  }, options.deps || {});
}

function summarize(result: any = {}) {
  return [
    'Luna Meeting Room L 완료',
    `- ok: ${result.ok === true}`,
    `- dry_run: ${result.dryRun === true}`,
    `- shadow_only: ${result.shadowOnly === true}`,
    `- debrief: candidates=${result.debrief?.candidates?.length || 0} generated=${result.debrief?.generated || 0}`,
    `- adr: overdue=${result.adr?.overdue?.length || 0} reappeared=${result.adr?.reappeared || 0}`,
    `- circuit: candidates=${result.circuit?.candidates?.length || 0} triggered=${result.circuit?.triggered || 0}`,
    `- regime: candidates=${result.regime?.candidates?.length || 0} triggered=${result.regime?.triggered || 0}`,
    `- disclosure: candidates=${result.disclosure?.candidates?.length || 0} triggered=${result.disclosure?.triggered || 0}`,
    `- daily_loss: candidates=${result.dailyLoss?.candidates?.length || 0} triggered=${result.dailyLoss?.triggered || 0}`,
    `- risk: candidates=${result.risk?.candidates?.length || 0} triggered=${result.risk?.triggered || 0}`,
    `- event_meeting: candidates=${result.eventMeeting?.candidates || 0} triggered=${result.eventMeeting?.triggered || 0}`,
    `- errors: ${result.errors?.length || 0}`,
  ].join('\n');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runRuntimeLunaMeetingRoomL(),
    onSuccess: async (result) => {
      const json = hasFlag(process.argv.slice(2), 'json');
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${summarize(result)}\n`);
      if (result?.blocked) process.exitCode = 2;
    },
    errorPrefix: '❌ luna-meeting-room-l 실패:',
  });
}

export default {
  LUNA_MEETING_ROOM_L_CONFIRM,
  parseMeetingRoomLOpsCliArgs,
  runRuntimeLunaMeetingRoomL,
};

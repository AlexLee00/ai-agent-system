#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: any = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function summarize(result: any) {
  return [
    `Luna Meeting Room ${result.type || 'morning'} 완료`,
    `- dry_run: ${result.dryRun === true}`,
    `- shadow_only: ${result.shadowOnly === true}`,
    `- session: ${result.session?.id || 'dry-run'}`,
    `- minutes: ${result.minutes?.length || 0}`,
    `- decisions: ${result.decisions?.length || 0}`,
    `- llm_calls: ${result.llmCalls || 0}`,
    `- skipped_llm_calls: ${result.skippedLlmCalls || 0}`,
    `- markdown: ${result.markdownPath || 'n/a'}`,
  ].join('\n');
}

export async function runRuntimeLunaMeetingRoom(options: any = {}) {
  return runMeetingSession({
    type: options.type || argValue('type', 'morning'),
    chair: options.chair || argValue('chair', 'luna'),
    dryRun: options.dryRun ?? (hasFlag('dry-run') || !hasFlag('apply')),
    apply: options.apply ?? hasFlag('apply'),
    noLlm: options.noLlm ?? hasFlag('no-llm'),
    outputPath: options.outputPath || argValue('output', null),
    forceInsufficientGrill: options.forceInsufficientGrill ?? hasFlag('force-insufficient-grill'),
  }, options.deps || {});
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runRuntimeLunaMeetingRoom(),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else console.log(summarize(result));
    },
    errorPrefix: '❌ luna-meeting-room 실패:',
  });
}

export default {
  runRuntimeLunaMeetingRoom,
};

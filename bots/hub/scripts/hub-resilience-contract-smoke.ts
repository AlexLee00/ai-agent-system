#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertIncludes(source: string, needle: string, label: string): void {
  assert(source.includes(needle), `${label} missing required contract: ${needle}`);
}

const admission = read('bots/hub/lib/llm/admission-control.ts');
assertIncludes(admission, "parseEnvNumber('HUB_LLM_MAX_IN_FLIGHT'", 'LLM admission');
assertIncludes(admission, "parseEnvNumber('HUB_LLM_MAX_QUEUE'", 'LLM admission');
assertIncludes(admission, "'queue_full'", 'LLM admission');
assertIncludes(admission, "'queue_timeout'", 'LLM admission');
assertIncludes(admission, "'client_disconnected'", 'LLM admission');
assertIncludes(admission, "res.set('Retry-After'", 'LLM admission');
assertIncludes(admission, "res.on('finish', releaseOnce)", 'LLM admission');
assertIncludes(admission, "res.on('close', releaseOnce)", 'LLM admission');

const alarmRoute = read('bots/hub/lib/routes/alarm.ts');
assertIncludes(alarmRoute, 'FOR UPDATE SKIP LOCKED', 'digest claim lease');
assertIncludes(alarmRoute, 'digest_claim_id', 'digest claim lease');
assertIncludes(alarmRoute, 'if (dryRun)', 'digest dry-run');
assertIncludes(alarmRoute, "metadata->>'digest_delivered'", 'digest delivery idempotency');
assertIncludes(alarmRoute, 'findRecentClusterDuplicate', 'alarm cluster dedupe');

const digestWorker = read('bots/hub/scripts/alarm-digest-worker.ts');
assertIncludes(digestWorker, 'while (true)', 'digest worker loop');
assertIncludes(digestWorker, 'catch (error)', 'digest worker error isolation');
assertIncludes(digestWorker, 'await sleep(intervalMinutes * 60 * 1000)', 'digest worker backoff loop');

const controlTools = read('bots/hub/lib/control/tool-registry.ts');
assertIncludes(controlTools, "name: 'launchd.restart'", 'mutating tool registry');
assertIncludes(controlTools, 'executeEnabled: false', 'mutating tool registry');
assertIncludes(controlTools, "name: 'repo.command.run'", 'mutating tool registry');

console.log(JSON.stringify({
  ok: true,
  llm_admission_backpressure: true,
  digest_claim_lease: true,
  digest_worker_error_isolation: true,
  mutating_tools_disabled_by_default: true,
}));

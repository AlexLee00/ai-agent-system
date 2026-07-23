#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTransitionScanOptions } from '../bots/sigma/vault/inbox-processor.ts';
import {
  buildSessionSnapshot,
  collectServiceHealth,
  sessionSnapshotOk,
  summarizeLaunchdList,
  writeSnapshot,
} from './runtime-session-snapshot.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assertDirectTsxPlist(rel, script) {
  const text = read(rel);
  assert(!text.includes('/opt/homebrew/bin/npm'), `${rel} must not call npm`);
  assert(text.includes('/opt/homebrew/bin/node'), `${rel} must call node directly`);
  assert(text.includes('<string>--import</string>'), `${rel} must use tsx import`);
  assert(text.includes(`<string>${script}</string>`), `${rel} must point at absolute script`);
  assert(text.includes('<key>PATH</key>'), `${rel} must define PATH`);
}

async function main() {
  assertDirectTsxPlist(
    'bots/sigma/launchd/ai.sigma.llm-wiki-weekly.plist',
    '/Users/alexlee/projects/ai-agent-system/bots/sigma/scripts/llm-wiki-compile.ts',
  );
  assertDirectTsxPlist(
    'bots/hub/launchd/ai.hub.selector-timeout-tuner-weekly.plist',
    '/Users/alexlee/projects/ai-agent-system/bots/hub/scripts/selector-timeout-tuner.ts',
  );
  assertDirectTsxPlist(
    'scripts/launchd/ai.jay.session-snapshot.plist',
    '/Users/alexlee/projects/ai-agent-system/scripts/runtime-session-snapshot.ts',
  );

  const off = buildTransitionScanOptions({}, {});
  assert.equal(off.dryRun, true);
  assert.equal(off.apply, false);
  assert.equal(off.applyLimit, 20);

  const on = buildTransitionScanOptions({ transitionApplyLimit: 7, transitionLimit: 99 }, { SIGMA_TRANSITION_ENABLED: 'true' });
  assert.equal(on.dryRun, false);
  assert.equal(on.apply, true);
  assert.equal(on.applyLimit, 7);
  assert.equal(on.limit, 99);

  const launchd = summarizeLaunchdList([
    'PID\tStatus\tLabel',
    '-\t127\tai.sigma.llm-wiki-weekly',
    '123\t0\tai.hub.ops-mcp',
    '456\t-9\tai.hub.resource-api',
  ].join('\n'));
  assert.equal(launchd.failedCount, 1);
  assert.equal(launchd.failed[0].label, 'ai.sigma.llm-wiki-weekly');
  assert.equal(launchd.runningWithLastExitCount, 1);
  assert.equal(launchd.runningWithLastExit[0].label, 'ai.hub.resource-api');
  assert.equal(sessionSnapshotOk({
    health: { failed: 0 },
    launchd: { ok: false, failedCount: 0 },
    opsConsoleServe: 'ok',
  }), false, 'launchctl collection failure must fail the snapshot');

  const requestedHealthUrls = [];
  const defaultHealth = await collectServiceHealth({
    fetchImpl: async (url) => {
      requestedHealthUrls.push(String(url));
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  });
  assert.equal(defaultHealth.ok, true);
  assert(requestedHealthUrls.includes('http://127.0.0.1:11434/v1/models'));
  assert.equal(requestedHealthUrls.some((url) => url.endsWith('/api/tags')), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-bundle2-'));
  const snapshot = await buildSessionSnapshot({
    workspace: tmp,
    skipLaunchctl: true,
    services: [{ key: 'fixture_service', url: 'http://fixture.local/health' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    }),
    queryReadonly: async () => [],
  });
  assert.equal(snapshot.health.checked, 1);
  assert(snapshot.markdown.includes('Team Jay Session Snapshot'));
  const paths = writeSnapshot(snapshot, {
    paths: {
      markdown: path.join(tmp, 'session-snapshot.md'),
      jsonl: path.join(tmp, 'session-snapshot.jsonl'),
    },
  });
  assert(fs.existsSync(paths.markdown));
  assert(fs.existsSync(paths.jsonl));

  console.log(JSON.stringify({
    ok: true,
    smoke: 'infra-bundle2',
    checks: {
      directTsxPlists: 3,
      transitionEnvBranch: true,
      launchdSummary: true,
      sessionSnapshot: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});

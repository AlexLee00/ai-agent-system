#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import path from 'node:path';

const fileGuard = require('../../../packages/core/lib/file-guard.ts');

function main(): void {
  const retiredDir = `.open${'claw'}`;
  const blockedState = path.join('/tmp', 'ai-agent-system-smoke', retiredDir, 'workspace-state.json');
  const blockedLog = path.join('/tmp', 'ai-agent-system-smoke', retiredDir, 'runtime.log');

  assert.equal(
    fileGuard.canWrite(blockedState, 'hub-smoke'),
    false,
    'retired workspace state writes must be blocked',
  );
  assert.equal(
    fileGuard.canWrite(blockedLog, 'hub-smoke'),
    false,
    'retired workspace log writes must be blocked even when .log is normally allowed',
  );
  assert.equal(
    fileGuard.canWrite('/tmp/ai-agent-system-smoke/workspace/runtime.log', 'hub-smoke'),
    true,
    'ordinary workspace log writes should remain allowed',
  );
  assert.equal(
    fileGuard.canWrite('/tmp/ai-agent-system-smoke/output/report.txt', 'hub-smoke'),
    true,
    'ordinary output writes should remain allowed',
  );

  console.log(JSON.stringify({ ok: true, retired_workspace_writes_blocked: true }));
}

main();

#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function main() {
  const preCommit = read('scripts/pre-commit');
  const checklist = read('scripts/migration/mac-mini-checklist.sh');
  const legacySmoke = read('bots/hub/scripts/legacy-gateway-independence-smoke.ts');
  const completionGate = read('bots/hub/scripts/hub-transition-completion-gate.ts');

  for (const marker of ['openclaw-gateway', 'OPENCLAW_BIN', '18789', 'execFile[^\\n]*openclaw', 'spawn[^\\n]*openclaw']) {
    assert(preCommit.includes(marker), `pre-commit must scan retired gateway marker: ${marker}`);
  }
  assert(preCommit.includes('bots/hub/scripts/.*(legacy-gateway|hub-transition|retired-gateway-marker|runtime-env-policy)'), 'pre-commit must allow Hub self-check scripts');
  assert(preCommit.includes('^(docs/'), 'pre-commit must keep docs allowlisted for architecture notes');

  assert(checklist.includes('${HUB_PORT:-7788}/hub/health'), 'migration checklist must verify native Hub port');
  assert(!checklist.includes('nc -z 127.0.0.1 18789'), 'migration checklist must not accept retired gateway port as Hub health');

  assert(legacySmoke.includes('RETIRED_GATEWAY_BIN_ENV'), 'legacy smoke must guard OPENCLAW_BIN');
  assert(legacySmoke.includes('execFile\\\\([^\\\\n]*'), 'legacy smoke must guard execFile openclaw reintroduction');
  assert(completionGate.includes('RETIRED_GATEWAY_SOURCE_PATTERN'), 'transition completion gate must use expanded retired gateway pattern');

  console.log(JSON.stringify({
    ok: true,
    pre_commit_retired_gateway_scan: true,
    migration_checklist_hub_native_port: true,
    hub_self_check_allowlist: true,
  }));
}

main();

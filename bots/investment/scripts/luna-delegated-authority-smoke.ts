#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_DELEGATED_AUTHORITY_TOKEN,
  buildLunaDelegatedAuthorityDecision,
  getLunaDelegatedAuthorityPolicy,
} from '../shared/luna-delegated-authority.ts';

function delegatedEnv(extra = {}) {
  return {
    LUNA_DELEGATED_AUTHORITY_ENABLED: 'true',
    LUNA_MASTER_REPORT_ONLY: 'true',
    LUNA_MAX_TRADE_USDT: '50',
    LUNA_LIVE_FIRE_MAX_DAILY: '200',
    LUNA_LIVE_FIRE_MAX_OPEN: '2',
    ...extra,
  };
}

export function runLunaDelegatedAuthoritySmoke() {
  const disabled = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: {},
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 50, maxDailyUsdt: 200, maxOpen: 2 },
  });
  assert.equal(disabled.canSelfApprove, false);
  assert.ok(disabled.blockers.includes('delegated_authority_disabled'));

  const approved = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 50, maxDailyUsdt: 200, maxOpen: 2 },
  });
  assert.equal(approved.canSelfApprove, true);
  assert.equal(approved.approvalToken, LUNA_DELEGATED_AUTHORITY_TOKEN);
  assert.equal(approved.masterRole, 'report_only');

  const runtimeConfigApproved = buildLunaDelegatedAuthorityDecision({
    action: 'runtime_config_apply',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
  });
  assert.equal(runtimeConfigApproved.canSelfApprove, true);

  const safeMaintenanceApproved = buildLunaDelegatedAuthorityDecision({
    action: 'safe_maintenance_apply',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
  });
  assert.equal(safeMaintenanceApproved.canSelfApprove, true);

  const unknownBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'unregistered_apply',
    env: delegatedEnv(),
  });
  assert.equal(unknownBlocked.canSelfApprove, false);
  assert.ok(unknownBlocked.blockers.includes('delegated_action_not_registered:unregistered_apply'));

  const capBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 51, maxDailyUsdt: 200, maxOpen: 2 },
  });
  assert.equal(capBlocked.canSelfApprove, false);
  assert.ok(capBlocked.blockers.some((item) => item.startsWith('trade_cap_exceeded')));

  const gateBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv(),
    finalGate: { ok: false, blockers: ['manual_reconcile_tasks:1'] },
    caps: { maxUsdt: 50, maxDailyUsdt: 200, maxOpen: 2 },
  });
  assert.equal(gateBlocked.canSelfApprove, false);
  assert.ok(gateBlocked.blockers.includes('manual_reconcile_tasks:1'));

  const ackBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'reconcile_ack',
    env: delegatedEnv(),
    reconcileEvidence: { evidenceHash: null, verifiedNotFound: false },
  });
  assert.equal(ackBlocked.canSelfApprove, false);
  assert.ok(ackBlocked.blockers.includes('delegated_reconcile_ack_disabled'));
  assert.ok(ackBlocked.blockers.includes('reconcile_evidence_hash_required'));

  const ackApproved = buildLunaDelegatedAuthorityDecision({
    action: 'reconcile_ack',
    env: delegatedEnv({ LUNA_DELEGATED_RECONCILE_ACK_ENABLED: 'true' }),
    reconcileEvidence: { evidenceHash: 'sha256:abc', verifiedNotFound: true },
  });
  assert.equal(ackApproved.canSelfApprove, true);

  const policy = getLunaDelegatedAuthorityPolicy(delegatedEnv());
  assert.equal(policy.delegated, true);
  assert.equal(policy.reportOnly, true);

  return {
    ok: true,
    status: 'luna_delegated_authority_smoke_passed',
    approved: approved.approvalSource,
    blockedExamples: {
      cap: capBlocked.blockers,
      gate: gateBlocked.blockers,
      ack: ackBlocked.blockers,
    },
  };
}

async function main() {
  const result = runLunaDelegatedAuthoritySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.status);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna delegated authority smoke 실패:',
  });
}

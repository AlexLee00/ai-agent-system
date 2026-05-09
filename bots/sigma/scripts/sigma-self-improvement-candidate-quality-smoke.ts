import assert from 'node:assert/strict';
import { buildSelfImprovementPlan } from '../ts/lib/self-improvement-pipeline.js';
import {
  buildSelfImprovementSignalsFromRecords,
  type LibraryRecord,
} from '../ts/lib/library-data-source.js';

function record(input: Partial<LibraryRecord> & Pick<LibraryRecord, 'sourceKind' | 'text' | 'payload'>): LibraryRecord {
  return {
    team: 'sigma',
    agent: 'sigma',
    sourceId: `fixture:${input.sourceKind}:${input.text}`,
    createdAt: '2026-05-09T00:00:00.000Z',
    piiRedactedText: input.text,
    redactions: [],
    contentHash: `hash:${input.text}`,
    constitutionAllowed: true,
    constitutionCritiques: [],
    ...input,
  };
}

const routineRecords = [
  record({
    sourceKind: 'sigma_directive',
    text: 'signal_sent general_review observed reflection_unavailable',
    payload: { outcome: 'signal_sent', action: { kind: 'general_review' } },
  }),
  record({
    sourceKind: 'mcp_usage',
    text: 'unauthorized smoke request observed during runtime validation',
    payload: { endpoint: '/mcp/sigma/tools', success: false, status: 401, metadata: { reason: 'mcp_disabled_or_auth_failed' } },
  }),
];
const routineSignals = buildSelfImprovementSignalsFromRecords(routineRecords);
assert.equal(routineSignals.length, 0, 'routine events must not generate self-improvement signals');

const failureRecords = Array.from({ length: 3 }, (_, index) => record({
  sourceKind: 'hub_alarm',
  sourceId: `failure:${index}`,
  text: 'critical repair_failed unresolved needs_human in sigma library graph',
  payload: { severity: 'critical', alarmType: 'error', status: 'unresolved' },
}));
const failureSignals = buildSelfImprovementSignalsFromRecords(failureRecords);
const failurePlan = buildSelfImprovementPlan(failureSignals, { dryRun: true });
assert.equal(failureSignals.length, 3);
assert.equal(failurePlan.skillCandidates.length, 1);
assert.equal(failurePlan.skillCandidates[0]?.kind, 'AVOID');

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_self_improvement_candidate_quality_smoke_passed',
  routineSignals: routineSignals.length,
  failureSignals: failureSignals.length,
  avoidCandidates: failurePlan.skillCandidates.length,
}, null, 2));

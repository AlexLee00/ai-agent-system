'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const storePath = path.join(__dirname, '../lib/proposal-store.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

function writeProposal(dir: string, data: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${data.id}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-proposal-state-'));
  const proposalDir = path.join(tmpRoot, 'docs/research/proposals');
  fs.mkdirSync(proposalDir, { recursive: true });

  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../../../packages/core/lib/env') {
      return { PROJECT_ROOT: tmpRoot };
    }
    if (request === './sigma-findings-hook.ts') {
      return {
        contributeSigmaFinding: async () => ({ ok: true, skipped: true, reason: 'mocked' }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[storePath];
    const store = require(storePath);

    assert.strictEqual(store.normalizeProposalState('rejected'), 'archived');
    assert.strictEqual(store.normalizeProposalState('verifying'), 'implementing');
    assert.match(store.buildProposalId({ title: 'A Study: Safety (v2) / 100%' }), /^A_Study_Safety_v2_100_\d+$/);
    assert.throws(() => store.loadProposal('../escape'), /invalid_proposal_id/);
    assert.throws(() => store.saveProposal({ id: '../escape', status: 'proposed' }), /invalid_proposal_id/);

    writeProposal(proposalDir, {
      id: 'proposal-ok',
      status: 'pending_approval',
      created_at: '2026-07-01T00:00:00.000Z',
      successPredicate: {
        assertions: [
          { name: 'a', command: 'true', expect: { exitCode: 0 } },
          { name: 'b', command: 'true', expect: { exitCode: 0 } },
          { name: 'c', command: 'true', expect: { exitCode: 0 } },
        ],
        targetMetric: {
          description: 'state-machine fixture',
          source: 'smoke',
        },
        budget: {
          maxWallMs: 300000,
          maxLlmCalls: 20,
        },
      },
    });
    assert.strictEqual(store.loadProposal('proposal'), null, 'proposal mutation lookup must require an exact id');
    assert.throws(
      () => store.updateStatus('proposal-ok', 'archived', { reason: 'legacy_bypass' }),
      /proposal_lifecycle_transition_requires_transitionProposal/,
    );

    const implementing = store.transitionProposal('proposal-ok', 'implementing', {
      reason: 'implementation_started',
      branch: 'darwin/proposal-ok',
    });
    assert.strictEqual(implementing.status, 'implementing');
    assert.strictEqual(implementing.branch, 'darwin/proposal-ok');
    assert.strictEqual(implementing.state_transitions.length, 1);

    assert.throws(
      () => store.transitionProposal('proposal-ok', 'adopted', { reason: 'skip_measured' }),
      /invalid_proposal_transition/,
    );

    assert.throws(
      () => store.transitionProposal('proposal-ok', 'measured', {
        reason: 'verification_passed',
        predicate_results: [],
        metrics_evidence: [],
      }),
      /proposal_transition_evidence_invalid/,
    );
    assert.throws(
      () => store.transitionProposal('proposal-ok', 'measured', {
        reason: 'verification_passed',
        predicate_results: [
          { name: 'x', ok: true },
          { name: 'y', ok: true },
          { name: 'z', ok: true },
        ],
        metrics_evidence: [],
      }),
      /proposal_transition_evidence_invalid/,
    );
    const measured = store.transitionProposal('proposal-ok', 'measured', {
      reason: 'verification_passed',
      predicate_results: [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
        { name: 'c', ok: true },
      ],
      metrics_evidence: [],
    });
    assert.strictEqual(measured.status, 'measured');
    assert.strictEqual(measured.measurement.pending_d3_predicate, false);

    writeProposal(proposalDir, {
      id: 'duplicate-active-old',
      arxiv_id: '2607.99999',
      status: 'pending_approval',
      created_at: '2026-07-28T00:00:00.000Z',
    });
    writeProposal(proposalDir, {
      id: 'duplicate-active-new',
      arxiv_id: '2607.99999',
      status: 'approved',
      created_at: '2026-07-29T00:00:00.000Z',
    });
    writeProposal(proposalDir, {
      id: 'duplicate-archived',
      arxiv_id: '2607.99999',
      status: 'archived',
      created_at: '2026-07-30T00:00:00.000Z',
    });
    const activeDuplicate = store.findActiveProposalForPaper({ arxiv_id: '2607.99999' });
    assert.strictEqual(activeDuplicate.id, 'duplicate-active-new');

    writeProposal(proposalDir, {
      id: 'impl-no-branch',
      status: 'implementing',
      implementation_started_at: '2026-07-28T00:00:00.000Z',
    });
    const consistency = store.auditProposalConsistency({ now: '2026-07-30T00:00:00.000Z' });
    assert.ok(consistency.activeDuplicatePapers.some((item: { paperKey: string }) => item.paperKey === 'arxiv:2607.99999'));
    assert.ok(consistency.implementingWithoutBranch.some((item: { id: string }) => item.id === 'impl-no-branch'));
    assert.ok(consistency.staleImplementations.some((item: { id: string }) => item.id === 'impl-no-branch'));

    const now = new Date('2026-07-30T00:00:00.000Z');
    writeProposal(proposalDir, {
      id: 'impl-old',
      status: 'implementing',
      implementation_started_at: '2026-07-15T23:59:59.000Z',
    });
    writeProposal(proposalDir, {
      id: 'impl-boundary',
      status: 'implementing',
      implementation_started_at: '2026-07-16T00:00:00.000Z',
    });
    writeProposal(proposalDir, {
      id: 'proposed-old',
      status: 'pending_approval',
      created_at: '2026-07-08T23:59:59.000Z',
    });
    writeProposal(proposalDir, {
      id: 'proposed-boundary',
      status: 'pending_approval',
      created_at: '2026-07-09T00:00:00.000Z',
    });

    const planned = store.planProposalTriage({ now });
    assert.deepStrictEqual(
      planned.map((item: { id: string; reason: string }) => `${item.id}:${item.reason}`).sort(),
      ['impl-old:triage_stale', 'proposed-old:triage_unstarted'],
    );

    const dryRun = store.runProposalTriage({ dryRun: true, now });
    assert.strictEqual(dryRun.actions.length, 2);
    assert.strictEqual(store.loadProposal('impl-old').status, 'implementing');

    const applied = store.runProposalTriage({ dryRun: false, now });
    assert.strictEqual(applied.archived, 2);
    assert.strictEqual(store.loadProposal('impl-old').status, 'archived');
    assert.strictEqual(store.loadProposal('impl-old').archive_reason, 'triage_stale');
    assert.strictEqual(store.loadProposal('proposed-old').archive_reason, 'triage_unstarted');

    console.log('✅ darwin proposal state machine smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[storePath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

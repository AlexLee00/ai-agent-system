'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const adoptPath = path.join(__dirname, '../lib/adopt-pipeline.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

function measuredProposal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Proposal ${id}`,
    status: 'measured',
    branch: `darwin/${id}`,
    korean_summary: '요약',
    changed_files: ['bots/darwin/experimental/demo.js'],
    successPredicate: {
      targetMetric: { description: 'metric', source: 'fixture' },
    },
    measurement: {
      predicate_results: [{ name: 'a', ok: true }],
      budget: { withinWallBudget: true, withinLlmBudget: true },
    },
    syntax_passed: true,
    syntax_checks: [{ path: 'bots/darwin/experimental/demo.js', ok: true }],
    verification_report: {
      syntax: { pass: true },
      style: { pass: true },
      security: { pass: true },
      diff: { pass: true },
    },
    ...overrides,
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-adopt-pipeline-'));
  const labPath = path.join(tmp, 'lab');
  fs.mkdirSync(labPath, { recursive: true });
  const calls: string[] = [];
  let pushed = false;
  let prCreated = false;
  const transitions: Array<{ id: string; to: string; evidence: Record<string, unknown> }> = [];

  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === './worktree-lab.ts') {
      return {
        createLab: (branchName: string) => ({ branchName, path: labPath }),
        removeLab: () => ({ removed: true, pruned: true }),
      };
    }
    if (request === '../../claude/lib/git-ops.ts') {
      return {
        pushHeadToBranch: () => { pushed = true; },
        createPR: () => { prCreated = true; return { ok: true, number: 1, url: 'https://example.invalid/pr/1' }; },
        runGh: () => '',
      };
    }
    if (request === './proposal-store.ts') {
      return {
        normalizeProposalState: (status: string) => status,
        listProposals: () => [],
        transitionProposal: (id: string, to: string, evidence: Record<string, unknown>) => {
          transitions.push({ id, to, evidence });
          return { id, status: to, ...evidence };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[adoptPath];
    const adopt = require(adoptPath);
    assert.strictEqual(adopt.matchesPattern('bots/investment/shared/a.ts', 'bots/investment/**'), true);
    assert.strictEqual(adopt.matchesPattern('bots/darwin/launchd/a.plist', '**/launchd/**'), true);
    assert.strictEqual(adopt.matchesPattern('bots/darwin/a.plist', '*.plist'), true);

    const safe = measuredProposal('safe');
    const protectedOne = measuredProposal('protected', { changed_files: ['bots/investment/shared/live.ts'] });
    const proposed = measuredProposal('not-measured', { status: 'pending_approval' });
    const selected = adopt.selectAdoptCandidates({ cap: 1, proposals: [safe, protectedOne, proposed] });
    assert.strictEqual(selected.candidates.length, 1);
    assert.strictEqual(selected.candidates[0].proposal.id, 'safe');
    assert.ok(selected.blocked.some((item: any) => item.blockedReason === 'denylist_match'));
    assert.ok(selected.blocked.some((item: any) => item.blockedReason === 'not_measured'));

    const spec = adopt.buildPrSpec(selected.candidates[0], 'darwin-adopt/safe');
    assert.ok(spec.title.includes('darwin: adopt'));
    assert.ok(spec.body.includes('Darwin Findings'));
    assert.ok(spec.body.includes('bots/darwin/experimental/demo.js'));
    const qualityInput = adopt.buildClaudeQualityGateInput(selected.candidates[0], { number: 1 });
    assert.strictEqual(qualityInput.builder.ok, true);
    assert.strictEqual(qualityInput.reviewer.ok, true);
    assert.strictEqual(qualityInput.guardian.ok, true);
    assert.strictEqual(adopt.isClaudeQualityGateApproved({ ok: true, pass: true, status: 'promotion_ready', verdict: 'approve_candidate' }), true);
    assert.strictEqual(adopt.isClaudeQualityGateApproved({ ok: true, pass: false, status: 'promotion_blocked', verdict: 'blocked' }), false);
    assert.strictEqual(
      adopt.validateActualAdoptDiff(selected.candidates[0], ['bots/darwin/experimental/demo.js']).ok,
      true,
    );
    assert.strictEqual(
      adopt.validateActualAdoptDiff(selected.candidates[0], ['bots/hub/src/hidden.ts']).reason,
      'actual_diff_denylist_match',
    );
    assert.strictEqual(
      adopt.validateActualAdoptDiff(selected.candidates[0], ['bots/darwin/experimental/other.js']).reason,
      'actual_diff_metadata_mismatch',
    );

    const blockedDry = await adopt.runAdoptForCandidate(selected.blocked.find((item: any) => item.blockedReason === 'denylist_match'), {
      dryRun: false,
      enabled: true,
      runGit: (args: string[]) => {
        calls.push(args.join(' '));
        return '';
      },
    });
    assert.strictEqual(blockedDry.ok, false);
    assert.strictEqual(blockedDry.blocked, true);
    assert.strictEqual(blockedDry.blockedReason, 'denylist_match');

    calls.length = 0;
    const dry = await adopt.runAdoptForCandidate(selected.candidates[0], {
      dryRun: true,
      enabled: false,
      runGit: (args: string[]) => {
        calls.push(args.join(' '));
        return args[0] === 'diff' ? 'bots/darwin/experimental/demo.js' : '';
      },
    });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(pushed, false);
    assert.strictEqual(prCreated, false);
    assert.ok(calls.some((call) => call === 'cherry-pick darwin/safe'));

    transitions.length = 0;
    const blockedScoring = await adopt.runAdoptForCandidate(selected.candidates[0], {
      dryRun: false,
      enabled: true,
      runGit: (args: string[]) => args[0] === 'diff' ? 'bots/darwin/experimental/demo.js' : '',
      pushHeadToBranch: () => ({ ok: true }),
      createPR: () => ({ ok: true, number: 2, url: 'https://example.invalid/pr/2' }),
      qualityGate: async () => ({ ok: true, pass: false, status: 'promotion_blocked', verdict: 'blocked' }),
    });
    assert.strictEqual(blockedScoring.ok, true);
    assert.strictEqual(blockedScoring.adopted, false);
    assert.strictEqual(transitions.length, 0, 'blocked Claude score must keep proposal measured');

    const approvedScoring = await adopt.runAdoptForCandidate(selected.candidates[0], {
      dryRun: false,
      enabled: true,
      runGit: (args: string[]) => args[0] === 'diff' ? 'bots/darwin/experimental/demo.js' : '',
      pushHeadToBranch: () => ({ ok: true }),
      createPR: () => ({ ok: true, number: 3, url: 'https://example.invalid/pr/3' }),
      qualityGate: async () => ({ ok: true, pass: true, status: 'promotion_ready', verdict: 'approve_candidate' }),
    });
    assert.strictEqual(approvedScoring.adopted, true);
    assert.ok(transitions.some((item) => item.id === 'safe' && item.to === 'adopted'));

    console.log('✅ darwin adopt pipeline smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[adoptPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

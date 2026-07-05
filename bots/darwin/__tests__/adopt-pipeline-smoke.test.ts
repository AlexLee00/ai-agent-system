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
        return '';
      },
    });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(pushed, false);
    assert.strictEqual(prCreated, false);
    assert.ok(calls.some((call) => call === 'cherry-pick darwin/safe'));

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');

const { createLab, removeLab } = require('../lib/worktree-lab.ts');

const repoRoot = path.resolve(__dirname, '../../..');
const verifierPath = path.join(__dirname, '../lib/verifier.ts');
const adoptPath = path.join(__dirname, '../lib/adopt-pipeline.ts');

function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
}

function recordRoot(label: string, rootBranches: string[]) {
  const branch = git(['branch', '--show-current']);
  rootBranches.push(`${label}:${branch}`);
  assert.strictEqual(branch, 'main', `OPS root branch drift at ${label}: ${branch}`);
}

async function main() {
  const rootBranches: string[] = [];
  const stamp = Date.now();
  const proposalId = `d3d4-hard-${stamp}`;
  const implementationBranch = `darwin/${proposalId}`;
  const proposalPath = path.join(repoRoot, 'docs/research/proposals', `${proposalId}.json`);
  const relPath = `bots/darwin/experimental/${proposalId}.js`;
  const originalLoad = Module._load;
  let implementationLab: { path: string } | null = null;

  recordRoot('start', rootBranches);
  try {
    const createdLab = createLab(implementationBranch);
    implementationLab = createdLab;
    const labPath = createdLab.path;
    const fullPath = path.join(labPath, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'module.exports = { ok: true };\n', 'utf8');
    git(['add', relPath], labPath);
    git([
      '-c',
      'user.name=Darwin D3D4 Hard Smoke',
      '-c',
      'user.email=darwin-d3d4-hard-smoke@example.invalid',
      'commit',
      '-m',
      `test(darwin): d3d4 hard smoke ${stamp}`,
    ], labPath);
    removeLab(labPath);
    implementationLab = null;
    recordRoot('after-implementation-branch', rootBranches);

    fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
    fs.writeFileSync(proposalPath, JSON.stringify({
      id: proposalId,
      status: 'implementing',
      title: 'D3D4 hard smoke',
      korean_summary: '하드 스모크용 복제 제안',
      branch: implementationBranch,
      changed_files: [relPath],
      successPredicate: {
        assertions: [
          { name: 'file exists', command: `test -f ${relPath}`, expect: { exitCode: 0 } },
          { name: 'node check', command: `node --check ${relPath}`, expect: { exitCode: 0 } },
          { name: 'echo', command: 'printf ok', expect: { stdoutIncludes: 'ok' } },
        ],
        targetMetric: { description: 'hard smoke predicate', source: 'fixture' },
        budget: { maxWallMs: 300000, maxLlmCalls: 20 },
      },
    }, null, 2), 'utf8');

    Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === '../../../packages/core/lib/hub-client') return { callHubLlm: async () => ({ text: 'unused' }) };
      if (request === '../../../packages/core/lib/hub-alarm-client') return { postAlarm: async () => ({ ok: true }) };
      if (request === '../../../packages/core/lib/event-lake') return { record: async () => null };
      if (request === '../../../packages/core/lib/rag') return { storeExperience: async () => null };
      if (request === '../../../packages/core/lib/failure-trajectory') {
        return {
          recordExecutionTrajectory: async () => null,
          recordFailureTrajectory: async () => null,
          searchFailureHints: async () => [],
        };
      }
      if (request === './autonomy-level') {
        return {
          requiresApproval: () => true,
          recordVerifiedSuccess: () => null,
          recordMergeSuccess: () => null,
          recordMergeFailure: () => null,
          recordError: () => null,
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[verifierPath];
    const verifier = require(verifierPath);
    const verification = await verifier.triggerVerification(proposalId, implementationBranch);
    assert.strictEqual(verification.passed, true);
    const measured = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
    assert.strictEqual(measured.status, 'measured');
    assert.strictEqual(measured.measurement.pending_d3_predicate, false);
    assert.strictEqual(measured.measurement.predicate_results.length, 3);
    recordRoot('after-d3-verify', rootBranches);

    delete require.cache[adoptPath];
    const adopt = require(adoptPath);
    const selected = adopt.selectAdoptCandidates({ cap: 1, proposals: [measured] });
    assert.strictEqual(selected.candidates.length, 1);
    const dryRun = await adopt.runAdoptForCandidate(selected.candidates[0], { dryRun: true, enabled: false });
    assert.strictEqual(dryRun.ok, true);
    assert.strictEqual(dryRun.dryRun, true);
    assert.ok(dryRun.prSpec.title.includes('darwin: adopt'));
    assert.ok(dryRun.prSpec.body.includes('Darwin Findings'));
    recordRoot('after-d4-dry-run', rootBranches);

    console.log(JSON.stringify({
      ok: true,
      proposalId,
      rootBranches,
      measured: true,
      dryRunPrSpec: {
        title: dryRun.prSpec.title,
        head: dryRun.prSpec.head,
        base: dryRun.prSpec.base,
      },
    }, null, 2));
  } finally {
    Module._load = originalLoad;
    delete require.cache[verifierPath];
    delete require.cache[adoptPath];
    if (implementationLab) {
      try { removeLab(implementationLab.path); } catch {}
    }
    try { fs.unlinkSync(proposalPath); } catch {}
    try { git(['branch', '-D', implementationBranch]); } catch {}
    try { git(['branch', '-D', `darwin-adopt/${proposalId}`]); } catch {}
    recordRoot('after-cleanup', rootBranches);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

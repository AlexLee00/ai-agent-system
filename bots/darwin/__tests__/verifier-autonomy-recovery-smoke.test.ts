'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const verifierPath = path.join(__dirname, '../lib/verifier.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-verifier-recovery-'));
  fs.mkdirSync(path.join(tmpRoot, 'bots/darwin'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, '.git'), 'gitdir: fixture\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'bots/darwin/fixture.ts'), 'export const fixture = true;\n', 'utf8');

  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const gitCommands: string[] = [];
  const updates: Array<{ id: string; status: string; extra?: Record<string, unknown> }> = [];
  const autonomyCalls: string[] = [];
  let verificationOverall = true;
  let llmText = '종합 판정: PASS\n1. 문법 정확성: PASS';
  const passPredicate = {
    assertions: [
      { name: 'one', command: 'true', expect: { exitCode: 0 } },
      { name: 'two', command: 'true', expect: { exitCode: 0 } },
      { name: 'three', command: 'true', expect: { exitCode: 0 } },
    ],
    targetMetric: { description: 'fixture', source: 'smoke' },
    budget: { maxWallMs: 300000, maxLlmCalls: 20 },
  };
  const failPredicate = {
    ...passPredicate,
    assertions: [
      { name: 'fail', command: 'false', expect: { exitCode: 0 } },
      ...passPredicate.assertions.slice(1),
    ],
  };
  let proposal = {
    status: 'implementing',
    branch: 'feature/recovery',
    title: 'Recovery fixture',
    changed_files: ['bots/darwin/fixture.ts'],
    successPredicate: passPredicate,
  };

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === 'child_process') {
      return {
        execFileSync: (binOrCommand: string, argsOrOptions: string[] | Record<string, unknown>) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          const command = Array.isArray(argsOrOptions) ? [binOrCommand, ...args].join(' ') : binOrCommand;
          gitCommands.push(command);
          if (command === 'false') {
            const error = new Error('predicate failed');
            (error as any).status = 1;
            throw error;
          }
          if (command === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (command === 'branch --show-current') return 'main\n';
          if (args[0] === 'merge' && args[1] === '--no-ff' && args[2] === 'conflict-branch') {
            const error = new Error('Automatic merge failed; fix conflicts');
            (error as any).stderr = 'CONFLICT fixture\nAutomatic merge failed; fix conflicts';
            throw error;
          }
          return '';
        },
      };
    }
    if (request === '../../../packages/core/lib/env' || String(request).endsWith('packages/core/lib/env')) {
      return { PROJECT_ROOT: tmpRoot };
    }
    if (request === '../../../packages/core/lib/hub-client') {
      return { callHubLlm: async () => ({ text: llmText }) };
    }
    if (request === '../../../packages/core/lib/central-logger') {
      return { createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => ({ ok: true }) };
    }
    if (request === '../../../packages/core/lib/event-lake') {
      return { record: async () => null };
    }
    if (request === '../../../packages/core/lib/rag') {
      return { storeExperience: async () => null };
    }
    if (request === '../../../packages/core/lib/failure-trajectory') {
      return {
        recordExecutionTrajectory: async () => null,
        recordFailureTrajectory: async () => null,
        searchFailureHints: async () => [],
      };
    }
    if (request === '../../../packages/core/lib/skills/verify-loop') {
      return {
        runFullVerification: () => ({
          overall: verificationOverall,
          summary: verificationOverall ? 'verification ok' : 'verification failed',
          report: { fixture: true },
        }),
      };
    }
    if (request === './proposal-store') {
      return {
        loadProposal: () => proposal,
        normalizeProposalState: (status: string) => status,
        updateStatus: (id: string, status: string, extra?: Record<string, unknown>) => {
          updates.push({ id, status, extra });
          return { ...proposal, status, ...extra };
        },
      };
    }
    if (request === './worktree-lab') {
      return {
        createLab: (branchName: string) => ({ branchName, path: tmpRoot }),
        removeLab: () => ({ removed: true, pruned: true }),
        isInsideLab: () => true,
      };
    }
    if (request === './autonomy-level') {
      return {
        recordVerifiedSuccess: () => autonomyCalls.push('recordVerifiedSuccess'),
        recordMergeSuccess: () => autonomyCalls.push('recordMergeSuccess'),
        recordMergeFailure: () => autonomyCalls.push('recordMergeFailure'),
        recordError: () => autonomyCalls.push('recordError'),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[verifierPath];
    const verifier = require(verifierPath);

    await verifier.triggerVerification('proposal-pass', 'feature/recovery');
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordVerifiedSuccess').length, 1);
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, 0);
    assert.ok(updates.some((item) => item.id === 'proposal-pass' && item.status === 'measured'));
    assert.ok(!updates.some((item) => item.status === 'verifying'));
    assert.ok(updates.some((item) => item.status === 'implementing' && item.extra?.verification_phase === 'running'));

    verificationOverall = false;
    llmText = '종합 판정: FAIL\n보안 문제: FAIL';
    proposal = { ...proposal, successPredicate: failPredicate };
    await verifier.triggerVerification('proposal-fail', 'feature/recovery');
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, 0);
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordMergeFailure').length, 1);
    assert.ok(updates.some((item) => item.id === 'proposal-fail' && item.status === 'implementing'));

    await assert.rejects(
      () => verifier.mergeVerifiedProposal('proposal-merge'),
      /direct_main_merge_retired/,
    );
    await assert.rejects(
      () => verifier.mergeBranch('conflict-branch', 'conflict-fixture'),
      /direct_main_merge_retired/,
    );
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordMergeSuccess').length, 0);
    assert.ok(!updates.some((item) => item.id === 'proposal-merge' && item.status === 'adopted'));
    assert.ok(!gitCommands.some((cmd) => cmd.startsWith('merge ')));

    verificationOverall = true;
    llmText = '종합 판정: PASS\n1. 문법 정확성: PASS';
    proposal = {
      ...proposal,
      branch: 'conflict-branch',
      successPredicate: passPredicate,
    };
    const mergeFailuresBefore = autonomyCalls.filter((item) => item === 'recordMergeFailure').length;
    const errorsBefore = autonomyCalls.filter((item) => item === 'recordError').length;
    await verifier.triggerVerification('proposal-auto-merge-conflict', 'conflict-branch');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      autonomyCalls.filter((item) => item === 'recordMergeFailure').length,
      mergeFailuresBefore,
    );
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, errorsBefore);

    proposal = { ...proposal, status: 'archived' };
    await assert.rejects(
      () => verifier.triggerVerification('proposal-archived', 'conflict-branch'),
      /proposal_not_implementing/,
    );

    console.log('✅ darwin verifier autonomy recovery smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[verifierPath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

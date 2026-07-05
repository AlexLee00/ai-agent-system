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
  fs.writeFileSync(path.join(tmpRoot, 'bots/darwin/fixture.ts'), 'export const fixture = true;\n', 'utf8');

  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const gitCommands: string[] = [];
  const updates: Array<{ id: string; status: string; extra?: Record<string, unknown> }> = [];
  const autonomyCalls: string[] = [];
  let verificationOverall = true;
  let requiresApproval = true;
  let llmText = '종합 판정: PASS\n1. 문법 정확성: PASS';
  let proposal = {
    branch: 'feature/recovery',
    title: 'Recovery fixture',
    changed_files: ['bots/darwin/fixture.ts'],
  };

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === 'child_process') {
      return {
        execFileSync: (_bin: string, args: string[]) => {
          gitCommands.push(args.join(' '));
          if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (args.join(' ') === 'branch --show-current') return 'main\n';
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
        updateStatus: (id: string, status: string, extra?: Record<string, unknown>) => {
          updates.push({ id, status, extra });
          return { ...proposal, status, ...extra };
        },
      };
    }
    if (request === './autonomy-level') {
      return {
        requiresApproval: () => requiresApproval,
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

    verificationOverall = false;
    llmText = '종합 판정: FAIL\n보안 문제: FAIL';
    await verifier.triggerVerification('proposal-fail', 'feature/recovery');
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, 1);
    assert.ok(updates.some((item) => item.id === 'proposal-fail' && item.status === 'archived'));

    await verifier.mergeVerifiedProposal('proposal-merge');
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordMergeSuccess').length, 1);
    assert.ok(updates.some((item) => item.id === 'proposal-merge' && item.status === 'adopted'));

    await assert.rejects(
      () => verifier.mergeBranch('conflict-branch', 'conflict-fixture'),
      /Automatic merge failed|CONFLICT/,
    );
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordMergeFailure').length, 1);
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, 1);
    assert.ok(gitCommands.some((cmd) => cmd === 'merge --abort'));

    verificationOverall = true;
    llmText = '종합 판정: PASS\n1. 문법 정확성: PASS';
    requiresApproval = false;
    proposal = {
      ...proposal,
      branch: 'conflict-branch',
    };
    const mergeFailuresBefore = autonomyCalls.filter((item) => item === 'recordMergeFailure').length;
    const errorsBefore = autonomyCalls.filter((item) => item === 'recordError').length;
    await verifier.triggerVerification('proposal-auto-merge-conflict', 'conflict-branch');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      autonomyCalls.filter((item) => item === 'recordMergeFailure').length,
      mergeFailuresBefore + 1,
    );
    assert.strictEqual(autonomyCalls.filter((item) => item === 'recordError').length, errorsBefore);

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

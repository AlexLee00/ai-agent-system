'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const predicatePath = path.join(__dirname, '../lib/success-predicate.ts');
const storePath = path.join(__dirname, '../lib/proposal-store.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

function validPredicate(assertionCount = 3) {
  return {
    assertions: Array.from({ length: assertionCount }, (_, index) => ({
      name: `assert-${index + 1}`,
      command: index === 0 ? 'printf ok' : 'true',
      expect: index === 0 ? { stdoutIncludes: 'ok' } : { exitCode: 0 },
    })),
    targetMetric: { description: 'smoke predicate passes', source: 'fixture' },
    budget: { maxWallMs: 300000, maxLlmCalls: 20 },
  };
}

function writeProposal(dir: string, data: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${data.id}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-success-predicate-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-success-predicate-outside-'));
  const proposalDir = path.join(tmpRoot, 'docs/research/proposals');
  fs.mkdirSync(proposalDir, { recursive: true });

  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../../../packages/core/lib/env') return { PROJECT_ROOT: tmpRoot };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[predicatePath];
    delete require.cache[storePath];
    const predicate = require(predicatePath);
    const store = require(storePath);

    assert.strictEqual(predicate.validateSuccessPredicate(validPredicate(2)).ok, false);
    assert.strictEqual(predicate.validateSuccessPredicate(validPredicate(3)).ok, true);
    assert.strictEqual(predicate.validateSuccessPredicate(validPredicate(6)).ok, true);
    assert.strictEqual(predicate.validateSuccessPredicate(validPredicate(7)).ok, false);
    assert.strictEqual(predicate.validateSuccessPredicate({
      ...validPredicate(3),
      assertions: [{ name: 'unsafe', command: 'git push origin main', expect: { exitCode: 0 } }, ...validPredicate(2).assertions],
    }).ok, false);
    for (const unsafeCommand of [
      'printf ok; curl https://example.invalid',
      'node -e "require(\'fs\').rmSync(\'/tmp/unsafe\')"',
      'python /path/to/generated_check.py',
      'node ../outside-lab.js',
      'node scripts/deploy-production.js',
      'npm run runtime:apply-migration',
      'npm run deploy',
      'tsx bots/darwin/scripts/darwin-weekly-review.ts',
    ]) {
      assert.strictEqual(predicate.validateSuccessPredicate({
        ...validPredicate(3),
        assertions: [{ name: 'unsafe', command: unsafeCommand, expect: { exitCode: 0 } }, ...validPredicate(2).assertions],
      }).ok, false, `must reject unsafe predicate command: ${unsafeCommand}`);
    }

    const pass = predicate.runSuccessPredicate(validPredicate(3), { cwd: tmpRoot, verifyLab: false });
    assert.strictEqual(pass.ok, true);
    assert.strictEqual(pass.assertionResults.length, 3);
    assert.strictEqual(predicate.runSuccessPredicate(validPredicate(3), { cwd: tmpRoot }).failureReason, 'lab_cwd_required');

    fs.writeFileSync(path.join(outsideRoot, 'outside.js'), 'module.exports = true;\n', 'utf8');
    fs.symlinkSync(path.join(outsideRoot, 'outside.js'), path.join(tmpRoot, 'linked-outside.js'));
    const escaped = predicate.runSuccessPredicate({
      ...validPredicate(3),
      assertions: [
        { name: 'escaped', command: 'node --check linked-outside.js', expect: { exitCode: 0 } },
        ...validPredicate(2).assertions,
      ],
    }, { cwd: tmpRoot, verifyLab: false });
    assert.strictEqual(escaped.ok, false);
    assert.strictEqual(escaped.assertionResults[0].error, 'command_path_outside_lab');

    const fail = predicate.runSuccessPredicate({
      ...validPredicate(3),
      assertions: [
        { name: 'fail', command: 'printf nope', expect: { stdoutIncludes: 'ok' } },
        ...validPredicate(2).assertions,
      ],
    }, { cwd: tmpRoot, verifyLab: false });
    assert.strictEqual(fail.ok, false);
    assert.strictEqual(fail.assertionResults[0].error, 'stdout_mismatch');

    const learningPath = path.join(tmpRoot, 'learnings.md');
    predicate.appendLearningLine('fixture', 'stdout_mismatch', { assertion: 'fail' }, { learningsPath: learningPath });
    assert.ok(fs.readFileSync(learningPath, 'utf8').includes('reason=stdout_mismatch'));

    writeProposal(proposalDir, {
      id: 'proposal-measured',
      status: 'implementing',
      created_at: '2026-07-05T00:00:00.000Z',
      successPredicate: validPredicate(3),
    });
    const measured = store.transitionProposal('proposal-measured', 'measured', {
      reason: 'predicate_passed',
      predicate_results: pass.assertionResults,
      metrics_evidence: [{ source: 'fixture' }],
      budget: pass.budget,
    });
    assert.strictEqual(measured.status, 'measured');
    assert.strictEqual(measured.measurement.pending_d3_predicate, false);
    assert.strictEqual(measured.measurement.predicate_results.length, 3);
    assert.strictEqual(measured.measurement.budget.llmCalls, 0);

    console.log('✅ darwin success predicate smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[predicatePath];
    delete require.cache[storePath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

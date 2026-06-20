const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const proposalStore = require('../lib/proposal-store');
const implementor = require('../lib/implementor');
const verifier = require('../lib/verifier');
const applicator = require('../lib/applicator');

function assertInsideRepo(label: string, targetPath: string) {
  const relative = path.relative(repoRoot, targetPath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} must stay inside repo: ${targetPath}`);
}

async function main() {
  assert.strictEqual(proposalStore.PROPOSALS_DIR, path.join(repoRoot, 'docs/research/proposals'));
  assert.strictEqual(proposalStore.SANDBOX_DIR, path.join(repoRoot, 'bots/darwin/sandbox/prototypes'));
  assert.strictEqual(implementor._testOnly_REPO_ROOT, repoRoot);
  assert.strictEqual(verifier._testOnly_REPO_ROOT, repoRoot);
  assertInsideRepo('proposal dir', proposalStore.PROPOSALS_DIR);
  assertInsideRepo('sandbox dir', proposalStore.SANDBOX_DIR);

  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: implementor._testOnly_REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.strictEqual(gitRoot, repoRoot);

  const files = implementor._extractFiles(
    '--- FILE: generated.js ---\nmodule.exports = function generated() { return true; }\n',
    'proposal-root-smoke',
    { proposal: '적용 대상 팀: 다윈' },
  );
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].path, 'bots/darwin/experimental/proposal-root-smoke/generated.js');
  assert.strictEqual(implementor._hasReasoningLeak('<think>hidden</think>적용 대상 팀: 다윈'), true);
  assert.strictEqual(implementor._hasReasoningLeak('적용 대상 팀: 다윈'), false);
  assert.strictEqual(
    applicator._testOnly_stripReasoningBlocks('<think>hidden</think>적용 대상 팀: 다윈'),
    '적용 대상 팀: 다윈',
  );
  const hintRows = [{
    metadata: {
      signature: 'abc123',
      root_cause: 'no files extracted',
      resolution_hint: 'use --- FILE: path --- blocks',
      test_result: 'implementation_failed',
      stderr_tail: 'no_files_extracted',
    },
  }];
  assert.match(implementor._formatFailureHints(hintRows), /signature=abc123/);
  assert.match(implementor._formatFailureHints(hintRows), /no files extracted/);
  assert.match(verifier._formatFailureHints(hintRows), /signature=abc123/);
  assert.match(verifier._formatFailureHints(hintRows), /use --- FILE/);
  assert.strictEqual(typeof implementor._recordImplementationSuccessTrajectory, 'function');
  assert.strictEqual(typeof verifier._recordVerificationSuccessTrajectory, 'function');
  assert.strictEqual(implementor._testOnly_DARWIN_IMPLEMENTOR_TIMEOUT_MS, 180_000);
  const implementorSource = fs.readFileSync(path.join(repoRoot, 'bots/darwin/lib/implementor.ts'), 'utf8');
  assert.match(implementorSource, /agent:\s*'implementor'/);
  assert.match(implementorSource, /selectorKey:\s*'darwin\.agent_policy'/);

  console.log('✅ darwin auto-apply root smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

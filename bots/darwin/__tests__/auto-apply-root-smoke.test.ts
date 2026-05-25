const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const proposalStore = require('../lib/proposal-store');
const implementor = require('../lib/implementor');
const verifier = require('../lib/verifier');

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

  console.log('✅ darwin auto-apply root smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

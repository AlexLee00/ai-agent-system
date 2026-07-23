'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worktreeLab = require('../lib/worktree-lab.ts');
const rootGuard = require('../lib/ops-root-guard.ts');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-worktree-lab-smoke-'));
  const originalTelemetryPath = process.env.DARWIN_TELEMETRY_PATH;
  process.env.DARWIN_TELEMETRY_PATH = path.join(tmp, 'telemetry.jsonl');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (originalTelemetryPath === undefined) delete process.env.DARWIN_TELEMETRY_PATH;
    else process.env.DARWIN_TELEMETRY_PATH = originalTelemetryPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.once('exit', cleanup);

  const repoRoot = path.join(tmp, 'repo');
  const labRoot = path.join(tmp, 'labs');
  fs.mkdirSync(repoRoot, { recursive: true });
  const commands: string[] = [];
  const runGit = (args: string[]) => {
    commands.push(args.join(' '));
    if (args.join(' ') === 'worktree list --porcelain') {
      return [
        `worktree ${repoRoot}`,
        'branch refs/heads/main',
        '',
        `worktree ${path.join(labRoot, 'darwin/test')}`,
        'branch refs/heads/darwin/test',
        '',
      ].join('\n');
    }
    return '';
  };

  const lab = worktreeLab.createLab('darwin/test', { repoRoot, labRoot, runGit });
  assert.ok(lab.path.startsWith(labRoot));
  assert.ok(commands.some((cmd) => cmd.includes('worktree add') && cmd.includes('-b darwin/test main')));
  assert.ok(!commands.some((cmd) => cmd.includes('checkout')));
  assert.strictEqual(worktreeLab.isInsideLab(lab.path, { labRoot }), true);

  const labs = worktreeLab.listLabs({ repoRoot, labRoot, runGit });
  assert.strictEqual(labs.length, 1);
  assert.strictEqual(labs[0].branchName, 'darwin/test');

  assert.throws(
    () => worktreeLab.removeLab(repoRoot, { repoRoot, labRoot, runGit }),
    /lab_remove_outside_root/,
  );
  assert.throws(
    () => worktreeLab.removeLab(labRoot, { repoRoot, labRoot, runGit }),
    /lab_remove_root_forbidden/,
  );
  assert.throws(
    () => worktreeLab.removeLab(path.join(labRoot, 'unregistered'), { repoRoot, labRoot, runGit }),
    /lab_remove_unregistered/,
  );

  worktreeLab.removeLab(lab.path, { repoRoot, labRoot, runGit });
  assert.ok(commands.some((cmd) => cmd.startsWith('worktree remove --force ')));
  assert.ok(commands.some((cmd) => cmd === 'worktree prune'));

  const mainCommands: string[] = [];
  const mainGuard = rootGuard.assertOpsRootOnMain({
    repoRoot,
    notify: false,
    context: 'main-fixture',
    runGit: (args: string[]) => {
      mainCommands.push(args.join(' '));
      return 'main';
    },
  });
  assert.strictEqual(mainGuard.ok, true);
  assert.ok(!mainCommands.some((cmd) => cmd.includes('checkout')));

  const darwinCommands: string[] = [];
  const darwinGuard = rootGuard.assertOpsRootOnMain({
    repoRoot,
    notify: false,
    context: 'darwin-fixture',
    runGit: (args: string[]) => {
      darwinCommands.push(args.join(' '));
      return args.join(' ') === 'branch --show-current' ? 'darwin/dirty' : '';
    },
  });
  assert.strictEqual(darwinGuard.ok, true);
  assert.strictEqual(darwinGuard.action, 'recovered_to_main');
  assert.ok(darwinCommands.some((cmd) => cmd === 'checkout main'));

  const otherCommands: string[] = [];
  const otherGuard = rootGuard.assertOpsRootOnMain({
    repoRoot,
    notify: false,
    context: 'other-fixture',
    runGit: (args: string[]) => {
      otherCommands.push(args.join(' '));
      return 'feature/operator';
    },
  });
  assert.strictEqual(otherGuard.ok, false);
  assert.strictEqual(otherGuard.action, 'warn_only');
  assert.ok(!otherCommands.some((cmd) => cmd.includes('checkout')));

  console.log('✅ darwin worktree lab smoke ok');
  cleanup();
  process.removeListener('exit', cleanup);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

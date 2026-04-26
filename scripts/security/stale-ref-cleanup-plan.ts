#!/usr/bin/env tsx
/*
 * Read-only cleanup planner for stale local refs after a secret-history rewrite.
 *
 * It identifies local branches/tags/worktrees that still retain secret-bearing
 * history and prints suggested commands. It never deletes refs by itself.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

type HistoryFinding = {
  rule: string;
  commit: string;
  file: string;
};

type ScanResult = {
  ok: boolean;
  findings: HistoryFinding[];
};

type Worktree = {
  path: string;
  branch?: string;
  locked?: string;
  prunable?: string;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const HISTORY_SCAN = path.join(REPO_ROOT, 'scripts', 'security', 'secret-history-scan.ts');
const PROTECTED_BRANCHES = new Set(['main']);

function run(command: string, args: string[], options: { env?: Record<string, string> } = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

function runGit(args: string[], allowFailure = false): string {
  const result = run('git', args);
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.status}`);
  }
  return (result.stdout || '').trim();
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseJsonOutput(stdout: string): ScanResult {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('history scan did not return JSON');
  return JSON.parse(stdout.slice(start));
}

function scanAllRefs(): ScanResult {
  const result = run(TSX_BIN, [HISTORY_SCAN], {
    env: { SECRET_HISTORY_SCAN_ALL_REFS: '1' },
  });
  if (result.error) throw result.error;
  return parseJsonOutput(result.stdout || '{}');
}

function refsContaining(commit: string): string[] {
  const fullCommit = runGit(['rev-parse', `${commit}^{commit}`], true);
  if (!fullCommit) return [];
  return runGit([
    'for-each-ref',
    '--contains',
    fullCommit,
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ], true)
    .split(/\r?\n/)
    .map((ref: string) => ref.trim())
    .filter(Boolean);
}

function parseWorktrees(): Worktree[] {
  const output = runGit(['worktree', 'list', '--porcelain'], true);
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
    else if (line.startsWith('locked')) current.locked = line.slice('locked'.length).trim() || 'true';
    else if (line.startsWith('prunable')) current.prunable = line.slice('prunable'.length).trim() || 'true';
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function collectStaleRefs(findings: HistoryFinding[]): string[] {
  return [...new Set(findings.flatMap((finding) => refsContaining(finding.commit)))].sort();
}

function classifyRefs(refs: string[], worktrees: Worktree[]) {
  const worktreeByBranch = new Map<string, Worktree>();
  for (const worktree of worktrees) {
    if (worktree.branch) worktreeByBranch.set(worktree.branch, worktree);
  }

  const localBranches: string[] = [];
  const worktreeBranches: Array<{ branch: string; worktree: Worktree }> = [];
  const tags: string[] = [];
  const remoteRefs: string[] = [];
  const unknownRefs: string[] = [];

  for (const ref of refs) {
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length);
      if (PROTECTED_BRANCHES.has(branch)) continue;
      const worktree = worktreeByBranch.get(branch);
      if (worktree) worktreeBranches.push({ branch, worktree });
      else localBranches.push(branch);
    } else if (ref.startsWith('refs/tags/')) {
      tags.push(ref.slice('refs/tags/'.length));
    } else if (ref.startsWith('refs/remotes/')) {
      remoteRefs.push(ref.slice('refs/remotes/'.length));
    } else {
      unknownRefs.push(ref);
    }
  }

  return {
    localBranches: [...new Set(localBranches)].sort(),
    worktreeBranches: worktreeBranches.sort((a, b) => a.branch.localeCompare(b.branch)),
    tags: [...new Set(tags)].sort(),
    remoteRefs: [...new Set(remoteRefs)].sort(),
    unknownRefs: [...new Set(unknownRefs)].sort(),
  };
}

function buildCommands(classified: ReturnType<typeof classifyRefs>, worktrees: Worktree[]) {
  const prunableWorktrees = worktrees.filter((worktree) => worktree.prunable);
  const commands = {
    pruneWorktrees: prunableWorktrees.map(() => 'git worktree prune'),
    removeWorktreeBranches: classified.worktreeBranches.map(({ branch, worktree }) => ({
      branch,
      worktree: worktree.path,
      locked: Boolean(worktree.locked),
      commands: [
        `git worktree remove ${shellQuote(worktree.path)}`,
        `git branch -D ${shellQuote(branch)}`,
      ],
      note: worktree.locked
        ? 'worktree is locked; review/stop the owning agent before removal'
        : 'remove worktree first, then delete branch',
    })),
    deleteLocalBranches: classified.localBranches.map((branch) => `git branch -D ${shellQuote(branch)}`),
    deleteLocalTags: classified.tags.map((tag) => `git tag -d ${shellQuote(tag)}`),
    pruneRemoteRefs: classified.remoteRefs.map((ref) => `git update-ref -d ${shellQuote(`refs/remotes/${ref}`)}`),
  };
  return commands;
}

function main() {
  const allRefsScan = scanAllRefs();
  const worktrees = parseWorktrees();
  const staleRefs = collectStaleRefs(allRefsScan.findings || []);
  const classified = classifyRefs(staleRefs, worktrees);
  const commands = buildCommands(classified, worktrees);
  const payload = {
    ok: staleRefs.length === 0,
    destructive: false,
    note: 'read-only plan; commands are suggestions and were not executed',
    findings_count: allRefsScan.findings?.length || 0,
    stale_refs_count: staleRefs.length,
    stale_refs: staleRefs.map((ref) => ref.replace(/^refs\/(heads|tags|remotes)\//, '$1/')),
    classified: {
      local_branches: classified.localBranches,
      worktree_branches: classified.worktreeBranches.map(({ branch, worktree }) => ({
        branch,
        worktree: worktree.path,
        locked: Boolean(worktree.locked),
      })),
      local_tags: classified.tags,
      remote_refs: classified.remoteRefs,
      unknown_refs: classified.unknownRefs,
    },
    commands,
    next_actions: staleRefs.length === 0
      ? []
      : [
          'Confirm stale refs are no longer needed before running any command.',
          'Stop or remove locked agent worktrees before deleting their branches.',
          'Run npm run -s security:post-rewrite-doctor after cleanup.',
        ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

main();

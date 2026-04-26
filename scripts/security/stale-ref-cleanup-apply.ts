#!/usr/bin/env tsx
/*
 * Guarded executor for stale local refs after a secret-history rewrite.
 *
 * Default mode is dry-run. Destructive actions require both:
 *   1. --apply
 *   2. SECURITY_STALE_REF_CLEANUP_CONFIRM=delete-stale-secret-refs
 *
 * Scope flags are explicit: --tags, --branches, --remote-refs, --worktrees.
 * Locked worktrees require the additional --locked-worktrees flag.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

type Plan = {
  ok: boolean;
  classified?: {
    local_branches?: string[];
    worktree_branches?: Array<{ branch: string; worktree: string; locked: boolean }>;
    local_tags?: string[];
    remote_refs?: string[];
  };
};

type Action = {
  scope: string;
  label: string;
  commands: string[][];
  destructive: boolean;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const PLAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'security', 'stale-ref-cleanup-plan.ts');
const CONFIRM_VALUE = 'delete-stale-secret-refs';

function usage() {
  return [
    'Usage:',
    '  npm run -s security:stale-ref-cleanup -- [--plan-file <file>] [--tags] [--branches] [--remote-refs] [--worktrees] [--locked-worktrees] [--prune-worktrees] [--apply]',
    '',
    'Default is dry-run. To execute selected scopes:',
    `  SECURITY_STALE_REF_CLEANUP_CONFIRM=${CONFIRM_VALUE} npm run -s security:stale-ref-cleanup -- --apply --tags`,
    '',
    'Reuse a saved plan to avoid a slow all-ref rescan:',
    '  npm run -s security:stale-ref-plan -- --output /tmp/stale-ref-plan.json',
    '  npm run -s security:stale-ref-cleanup -- --plan-file /tmp/stale-ref-plan.json --tags',
  ].join('\n');
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseJsonOutput(stdout: string): Plan {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('cleanup plan did not return JSON');
  return JSON.parse(stdout.slice(start));
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
}

function runPlan(planFile?: string): Plan {
  if (planFile) {
    const planPath = path.resolve(REPO_ROOT, planFile);
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  }

  const result = run(TSX_BIN, [PLAN_SCRIPT]);
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stdout) {
    throw new Error(`cleanup plan failed: ${result.stderr || result.status}`);
  }
  return parseJsonOutput(result.stdout || '{}');
}

function buildActions(plan: Plan, args: Set<string>): Action[] {
  const classified = plan.classified || {};
  const actions: Action[] = [];

  if (args.has('--prune-worktrees')) {
    actions.push({
      scope: 'prune_worktrees',
      label: 'Prune stale git worktree metadata',
      commands: [['git', 'worktree', 'prune']],
      destructive: true,
    });
  }

  if (args.has('--tags')) {
    for (const tag of classified.local_tags || []) {
      actions.push({
        scope: 'tag',
        label: tag,
        commands: [['git', 'tag', '-d', tag]],
        destructive: true,
      });
    }
  }

  if (args.has('--branches')) {
    for (const branch of classified.local_branches || []) {
      actions.push({
        scope: 'branch',
        label: branch,
        commands: [['git', 'branch', '-D', branch]],
        destructive: true,
      });
    }
  }

  if (args.has('--remote-refs')) {
    for (const ref of classified.remote_refs || []) {
      actions.push({
        scope: 'remote_ref',
        label: ref,
        commands: [['git', 'update-ref', '-d', `refs/remotes/${ref}`]],
        destructive: true,
      });
    }
  }

  if (args.has('--worktrees')) {
    for (const item of classified.worktree_branches || []) {
      const locked = Boolean(item.locked);
      if (locked && !args.has('--locked-worktrees')) {
        actions.push({
          scope: 'worktree_skipped_locked',
          label: item.branch,
          commands: [],
          destructive: false,
        });
        continue;
      }
      actions.push({
        scope: locked ? 'locked_worktree' : 'worktree',
        label: item.branch,
        commands: [
          ['git', 'worktree', 'remove', item.worktree],
          ['git', 'branch', '-D', item.branch],
        ],
        destructive: true,
      });
    }
  }

  return actions;
}

function executeAction(action: Action, apply: boolean) {
  if (!apply || action.commands.length === 0) {
    return { ...action, status: apply && action.commands.length === 0 ? 'skipped' : 'dry_run' };
  }

  const commandResults = [];
  for (const [command, ...args] of action.commands) {
    const result = run(command, args);
    commandResults.push({
      command: [command, ...args],
      status: Number(result.status ?? 1),
      stderr: (result.stderr || '').trim(),
      stdout: (result.stdout || '').trim(),
    });
    if (result.status !== 0) {
      return { ...action, status: 'failed', commandResults };
    }
  }
  return { ...action, status: 'applied', commandResults };
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const apply = args.has('--apply');
  const planFile = readOption(argv, '--plan-file');
  const scopeFlags = ['--tags', '--branches', '--remote-refs', '--worktrees', '--prune-worktrees'];
  const selectedScopes = scopeFlags.filter((flag) => args.has(flag));
  if (selectedScopes.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      applied: false,
      destructive: false,
      note: 'no scopes selected; nothing to do',
      usage: usage(),
    }, null, 2));
    process.exit(0);
  }

  if (apply && process.env.SECURITY_STALE_REF_CLEANUP_CONFIRM !== CONFIRM_VALUE) {
    console.error(JSON.stringify({
      ok: false,
      applied: false,
      error: 'confirmation_required',
      required_env: `SECURITY_STALE_REF_CLEANUP_CONFIRM=${CONFIRM_VALUE}`,
    }, null, 2));
    process.exit(1);
  }

  const plan = runPlan(planFile || undefined);
  const actions = buildActions(plan, args);
  const results = actions.map((action) => executeAction(action, apply));
  const failed = results.filter((result) => result.status === 'failed');
  const skipped = results.filter((result) => result.status === 'skipped');
  const payload = {
    ok: failed.length === 0,
    applied: apply,
    destructive: apply,
    plan_source: planFile ? path.resolve(REPO_ROOT, planFile) : 'generated',
    selected_scopes: selectedScopes,
    actions_count: actions.length,
    applied_count: results.filter((result) => result.status === 'applied').length,
    dry_run_count: results.filter((result) => result.status === 'dry_run').length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    results,
    next_actions: apply
      ? ['Run npm run -s security:post-rewrite-doctor to verify cleanup.']
      : [`Re-run with --apply and SECURITY_STALE_REF_CLEANUP_CONFIRM=${CONFIRM_VALUE} to execute selected scopes.`],
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main();

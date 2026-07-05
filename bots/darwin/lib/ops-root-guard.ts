'use strict';

/**
 * Darwin OPS root branch guard.
 *
 * This is the only Darwin D1 path allowed to recover a dirty Darwin branch by
 * checking out main in the OPS root. Non-Darwin branches are operator-owned.
 */

const { execFileSync }: typeof import('child_process') = require('child_process');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');

type ExecFileOptions = Omit<import('child_process').ExecFileSyncOptionsWithStringEncoding, 'encoding'>;

interface GitRunner {
  (args: string[], opts?: ExecFileOptions & { cwd?: string }): string;
}

interface GuardOptions {
  repoRoot?: string;
  context?: string;
  runGit?: GitRunner;
  notify?: boolean;
}

interface GuardResult {
  ok: boolean;
  branch: string;
  action: 'none' | 'recovered_to_main' | 'warn_only' | 'recover_failed';
  message: string;
  recovered?: boolean;
  error?: string;
}

function defaultRunGit(args: string[], opts: ExecFileOptions & { cwd?: string } = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd || env.PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function toErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    return String(maybe.stderr || maybe.stdout || maybe.message || 'unknown error');
  }
  return String(error || 'unknown error');
}

function emitGuardAlert(message: string, options: GuardOptions = {}): void {
  console.warn(message);
  if (options.notify === false) return;
  try {
    const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
    Promise.resolve(postAlarm({
      message,
      team: 'darwin',
      alertLevel: 3,
      fromBot: 'ops-root-guard',
      alarmType: 'safety',
      visibility: 'ops',
      eventType: 'darwin_ops_root_branch_drift',
      incidentKey: 'darwin:ops-root-branch-drift',
    })).catch(() => null);
  } catch {
    // Logging to stdout/stderr is the minimum guaranteed alert path.
  }
}

function assertOpsRootOnMain(options: GuardOptions = {}): GuardResult {
  const repoRoot = options.repoRoot || env.PROJECT_ROOT;
  const runGit = options.runGit || defaultRunGit;
  const context = options.context || 'darwin';
  const branch = runGit(['branch', '--show-current'], { cwd: repoRoot }).trim();

  if (branch === 'main') {
    return {
      ok: true,
      branch,
      action: 'none',
      message: `[darwin-root-guard] ${context}: OPS root on main`,
    };
  }

  const message = `[darwin-root-guard] ${context}: OPS root branch drift detected: ${branch || '(detached)'}`;
  emitGuardAlert(message, options);

  if (!branch.startsWith('darwin/')) {
    return { ok: false, branch, action: 'warn_only', message };
  }

  try {
    runGit(['checkout', 'main'], { cwd: repoRoot });
    return {
      ok: true,
      branch,
      action: 'recovered_to_main',
      message: `${message}; recovered to main`,
      recovered: true,
    };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    emitGuardAlert(`${message}; recovery failed: ${errorMessage}`, options);
    return {
      ok: false,
      branch,
      action: 'recover_failed',
      message,
      error: errorMessage,
    };
  }
}

module.exports = {
  assertOpsRootOnMain,
  _testOnly_emitGuardAlert: emitGuardAlert,
};

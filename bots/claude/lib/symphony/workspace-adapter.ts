'use strict';

const path = require('path');
const os = require('os');

/**
 * @param {unknown} value
 */
function safeSegment(value = '') {
  return String(value || 'task').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task';
}

/**
 * @param {{ id?: unknown, metadata?: { targetTeam?: unknown } | null }} [task]
 * @param {{ root?: string, workspaceRoot?: string }} [options]
 */
function buildSymphonyWorkspacePlan(task = {}, options = {}) {
  const root = options && typeof options === 'object' && 'root' in options && typeof options.root === 'string'
    ? options.root
    : process.cwd();
  const workspaceRoot = options && typeof options === 'object' && 'workspaceRoot' in options && typeof options.workspaceRoot === 'string'
    ? options.workspaceRoot
    : path.join(os.homedir(), '.ai-agent-system', 'workspace', 'symphony-auto-dev-worktrees');
  const normalizedTask = task || {};
  const taskId = normalizedTask && typeof normalizedTask === 'object' && 'id' in normalizedTask ? normalizedTask.id : 'unknown';
  const metadata = normalizedTask && typeof normalizedTask === 'object' && 'metadata' in normalizedTask && normalizedTask.metadata && typeof normalizedTask.metadata === 'object'
    ? normalizedTask.metadata
    : null;
  const targetTeam = metadata && 'targetTeam' in metadata ? metadata.targetTeam : 'claude';
  const segment = safeSegment(`${taskId || 'unknown'}-${targetTeam || 'claude'}`);
  return {
    mode: 'plan_only',
    root,
    workspaceRoot,
    worktreePath: path.join(workspaceRoot, segment),
    branchName: `codex/symphony-auto-dev-${segment}`,
    createsFiles: false,
    mutatesGit: false,
  };
}

module.exports = {
  buildSymphonyWorkspacePlan,
};

'use strict';

const path = require('path');
const os = require('os');

/**
 * @typedef {{ targetTeam?: unknown } | null | undefined} SymphonyTaskMetadata
 * @typedef {{ id?: unknown, metadata?: SymphonyTaskMetadata }} SymphonyTask
 * @typedef {{ root?: string, workspaceRoot?: string }} WorkspacePlanOptions
 */

/**
 * @param {unknown} value
 */
function safeSegment(value) {
  return String(value || 'task').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task';
}

/**
 * @param {SymphonyTask} [task]
 * @param {WorkspacePlanOptions} [options]
 */
function buildSymphonyWorkspacePlan(task, {
  root = process.cwd(),
  workspaceRoot = path.join(os.homedir(), '.ai-agent-system', 'workspace', 'symphony-auto-dev-worktrees'),
} = {}) {
  /** @type {SymphonyTask} */
  const normalizedTask = task || {};
  const segment = safeSegment(`${normalizedTask.id || 'unknown'}-${normalizedTask.metadata?.targetTeam || 'claude'}`);
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

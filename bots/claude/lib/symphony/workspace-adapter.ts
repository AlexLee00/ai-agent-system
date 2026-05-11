// @ts-nocheck
'use strict';

const path = require('path');
const os = require('os');

function safeSegment(value) {
  return String(value || 'task').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task';
}

function buildSymphonyWorkspacePlan(task = {}, {
  root = process.cwd(),
  workspaceRoot = path.join(os.homedir(), '.ai-agent-system', 'workspace', 'symphony-auto-dev-worktrees'),
} = {}) {
  const segment = safeSegment(`${task.id || 'unknown'}-${task.metadata?.targetTeam || 'claude'}`);
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

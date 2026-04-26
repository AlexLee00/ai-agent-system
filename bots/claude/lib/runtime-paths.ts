// @ts-nocheck
'use strict';

const path = require('path');
const os = require('os');
const env = require('../../../packages/core/lib/env');

function aiAgentHome() {
  return env.AI_AGENT_HOME || process.env.AI_AGENT_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function workspaceDir() {
  return env.AI_AGENT_WORKSPACE || process.env.AI_AGENT_WORKSPACE || path.join(aiAgentHome(), 'workspace');
}

function logsDir() {
  return env.AI_AGENT_LOGS || process.env.AI_AGENT_LOGS || path.join(aiAgentHome(), 'logs');
}

function workspacePath(...parts) {
  return path.join(workspaceDir(), ...parts);
}

function logPath(...parts) {
  return path.join(logsDir(), ...parts);
}

module.exports = {
  aiAgentHome,
  workspaceDir,
  logsDir,
  workspacePath,
  logPath,
};

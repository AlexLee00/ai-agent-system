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

/**
 * @param {...string} parts
 */
function workspacePath() {
  const parts = Array.from(arguments, String);
  return path.join(workspaceDir(), ...parts);
}

/**
 * @param {...string} parts
 */
function logPath() {
  const parts = Array.from(arguments, String);
  return path.join(logsDir(), ...parts);
}

module.exports = {
  aiAgentHome,
  workspaceDir,
  logsDir,
  workspacePath,
  logPath,
};

// @ts-nocheck
'use strict';

/**
 * packages/core/src/utils.js — 공통 유틸리티
 * delay, log (KST timestamp), getTodayKST, getWorkspacePath
 */

const path = require('path');
const os = require('os');

function getWorkspaceRoot() {
  const home = process.env.AI_AGENT_HOME
    || process.env.JAY_HOME
    || path.join(os.homedir(), '.ai-agent-system');
  return process.env.AI_AGENT_WORKSPACE
    || process.env.JAY_WORKSPACE
    || process.env.OPENCLAW_WORKSPACE
    || path.join(home, 'workspace');
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.error(`[${ts}] ${msg}`);
}

function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function getWorkspacePath(...parts) {
  return path.join(getWorkspaceRoot(), ...parts);
}

module.exports = { delay, log, getTodayKST, getWorkspacePath, getWorkspaceRoot };

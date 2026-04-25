// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(process.env.HOME || '/tmp', '.ai-agent-system');
const AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE
  || process.env.JAY_WORKSPACE
  || process.env.OPENCLAW_WORKSPACE
  || path.join(AI_AGENT_HOME, 'workspace');
const SPEED_TEST_LATEST_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-speed-test-latest.json');
const SPEED_TEST_HISTORY_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-speed-test-history.jsonl');

function buildSpeedSnapshotPayload(results, {
  prompt = null,
  runs = null,
  current = null,
  recommended = null,
  applied = null,
} = {}) {
  return {
    capturedAt: new Date().toISOString(),
    prompt,
    runs,
    current,
    recommended,
    applied,
    results: (results || []).map((item, index) => ({
      rank: index + 1,
      modelId: item.modelId,
      provider: item.provider,
      label: item.label,
      ttft: item.ttft,
      total: item.total,
      ok: item.ok === true,
      error: item.error || null,
      errorClass: item.errorClass || null,
    })),
  };
}

function loadLatestSpeedSnapshot() {
  try {
    if (!fs.existsSync(SPEED_TEST_LATEST_FILE)) return null;
    return JSON.parse(fs.readFileSync(SPEED_TEST_LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLatestSpeedSnapshot(results, options = {}) {
  const payload = buildSpeedSnapshotPayload(results, options);
  const status = {
    latestSaved: false,
    historySaved: false,
    latestError: null,
    historyError: null,
    payload,
  };

  try {
    fs.mkdirSync(path.dirname(SPEED_TEST_LATEST_FILE), { recursive: true });
    fs.writeFileSync(SPEED_TEST_LATEST_FILE, JSON.stringify(payload, null, 2) + '\n');
    status.latestSaved = true;
  } catch (error) {
    status.latestError = error.message;
  }

  try {
    fs.mkdirSync(path.dirname(SPEED_TEST_HISTORY_FILE), { recursive: true });
    fs.appendFileSync(SPEED_TEST_HISTORY_FILE, JSON.stringify(payload) + '\n');
    status.historySaved = true;
  } catch (error) {
    status.historyError = error.message;
  }

  return status;
}

module.exports = {
  SPEED_TEST_LATEST_FILE,
  SPEED_TEST_HISTORY_FILE,
  buildSpeedSnapshotPayload,
  loadLatestSpeedSnapshot,
  writeLatestSpeedSnapshot,
};

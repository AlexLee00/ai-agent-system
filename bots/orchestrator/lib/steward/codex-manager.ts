// @ts-nocheck
'use strict';

const DISABLED_REASON = 'docs/codex automation is decommissioned; use docs/auto_dev for auto implementation';

function listActive() {
  return [];
}

function isCompleted() {
  return false;
}

async function traceActiveTasks() {
  return {
    active: 0,
    tracked: 0,
    disabled: true,
    reason: DISABLED_REASON,
  };
}

async function archiveCompleted() {
  return [];
}

function summarize() {
  return {
    active: 0,
    names: [],
    archived: 0,
    disabled: true,
    reason: DISABLED_REASON,
  };
}

module.exports = {
  listActive,
  isCompleted,
  traceActiveTasks,
  archiveCompleted,
  summarize,
  DISABLED_REASON,
};

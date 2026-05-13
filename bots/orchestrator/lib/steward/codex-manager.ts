// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const eventLake = require('../../../../packages/core/lib/event-lake');
const cycle = require('../../../../packages/core/lib/cycle');

const CODEX_DIR = path.join(env.PROJECT_ROOT, 'docs', 'codex');
const ARCHIVE_DIR = path.join(CODEX_DIR, 'archive');
const TRACE_STATE_FILE = path.join(env.PROJECT_ROOT, 'output', 'codex-manager-trace-state.json');

function listActive() {
  if (!fs.existsSync(CODEX_DIR)) return [];
  return fs.readdirSync(CODEX_DIR)
    .filter((file) => file.startsWith('CODEX_') && file.endsWith('.md'))
    .map((file) => ({ name: file, path: path.join(CODEX_DIR, file) }));
}

function isCompleted(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const checkboxes = content.match(/\[[ x]\]/g) || [];
  if (checkboxes.length === 0) return false;
  return !checkboxes.includes('[ ]');
}

function countChecklist(filePath) {
  if (!fs.existsSync(filePath)) return { total: 0, done: 0 };
  const content = fs.readFileSync(filePath, 'utf8');
  const checkboxes = content.match(/\[[ xX]\]/g) || [];
  const done = checkboxes.filter((item) => item.toLowerCase() === '[x]').length;
  return { total: checkboxes.length, done };
}

function readTraceState() {
  try {
    if (!fs.existsSync(TRACE_STATE_FILE)) return { tasks: {} };
    const parsed = JSON.parse(fs.readFileSync(TRACE_STATE_FILE, 'utf8'));
    return { tasks: parsed.tasks || {} };
  } catch {
    return { tasks: {} };
  }
}

function writeTraceState(state) {
  fs.mkdirSync(path.dirname(TRACE_STATE_FILE), { recursive: true });
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${TRACE_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, TRACE_STATE_FILE);
}

async function recordCodexTaskEvent(eventType, codex, checklist, currentCycleId, extra = {}) {
  await eventLake.recordEvent({
    event_type: eventType,
    team: 'meta',
    bot_name: 'codex',
    severity: 'info',
    title: `코덱스 작업 추적: ${codex.name}`,
    tags: ['codex', 'task', 'collab-trace'],
    metadata: {
      cycle_id: currentCycleId,
      task_id: codex.name.replace(/\.md$/i, ''),
      file_path: path.relative(env.PROJECT_ROOT, codex.path),
      total_checkboxes: checklist.total,
      checked: checklist.done,
      observed_at: new Date().toISOString(),
      ...extra,
    },
  });
}

async function traceActiveTasks() {
  const active = listActive();
  const state = readTraceState();
  const tasks = { ...state.tasks };
  let currentCycleId = null;
  try {
    currentCycleId = await cycle.getCurrentCycleId();
  } catch (error) {
    console.warn(`[codex-manager] current cycle 조회 실패: ${error?.message || error}`);
  }

  for (const codex of active) {
    const checklist = countChecklist(codex.path);
    const previous = tasks[codex.name];

    try {
      if (!previous) {
        await recordCodexTaskEvent('codex.task.started', codex, checklist, currentCycleId);
      } else if (previous.total !== checklist.total || previous.done !== checklist.done) {
        await recordCodexTaskEvent('codex.task.checkbox_updated', codex, checklist, currentCycleId, {
          previous_total_checkboxes: previous.total,
          previous_checked: previous.done,
        });
      }
    } catch (error) {
      console.warn(`[codex-manager] EventLake task trace 실패: ${error?.message || error}`);
    }

    tasks[codex.name] = {
      path: path.relative(env.PROJECT_ROOT, codex.path),
      total: checklist.total,
      done: checklist.done,
      lastSeenAt: new Date().toISOString(),
    };
  }

  for (const name of Object.keys(tasks)) {
    if (!active.some((codex) => codex.name === name)) delete tasks[name];
  }

  writeTraceState({ tasks });
  return { active: active.length, tracked: Object.keys(tasks).length };
}

async function recordCodexArchived(codex, destination) {
  try {
    const currentCycleId = await cycle.getCurrentCycleId();
    const checklist = countChecklist(destination);
    await eventLake.recordEvent({
      event_type: 'codex.task.archived',
      team: 'meta',
      bot_name: 'codex',
      severity: 'info',
      title: `코덱스 작업 완료: ${codex.name}`,
      tags: ['codex', 'task', 'archive'],
      metadata: {
        cycle_id: currentCycleId,
        task_id: codex.name.replace(/\.md$/i, ''),
        file_path: path.relative(env.PROJECT_ROOT, destination),
        archived_at: new Date().toISOString(),
        total_checkboxes: checklist.total,
        checked: checklist.done,
      },
    });
    const state = readTraceState();
    delete state.tasks[codex.name];
    writeTraceState(state);
  } catch (error) {
    console.warn(`[codex-manager] EventLake archive trace 실패: ${error?.message || error}`);
  }
}

async function archiveCompleted() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const moved = [];
  for (const codex of listActive()) {
    if (!isCompleted(codex.path)) continue;
    const destination = path.join(ARCHIVE_DIR, codex.name);
    fs.renameSync(codex.path, destination);
    moved.push(codex.name);
    await recordCodexArchived(codex, destination);
  }
  return moved;
}

function summarize() {
  const active = listActive();
  const archived = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter((file) => file.endsWith('.md')).length
    : 0;
  return {
    active: active.length,
    names: active.map((item) => item.name),
    archived,
  };
}

module.exports = {
  listActive,
  isCompleted,
  traceActiveTasks,
  archiveCompleted,
  summarize,
};

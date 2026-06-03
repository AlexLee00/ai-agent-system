// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = require('../../../../packages/core/lib/env');
const eventLake = require('../../../../packages/core/lib/event-lake');
const cycle = require('../../../../packages/core/lib/cycle');

const STATE_FILE = path.join(env.PROJECT_ROOT, 'output', 'metty-trace-state.json');

const WATCH_PATHS = [
  {
    dir: 'docs/metty',
    stage: 'started',
    eventType: 'metty.session.started',
    filter: (file) => file.endsWith('.md'),
  },
  {
    dir: 'docs/metty',
    stage: 'lesson_added',
    eventType: 'metty.session.lesson_added',
    filter: (file) => file === 'LESSONS.md',
  },
  {
    dir: 'docs/strategy',
    stage: 'designed',
    eventType: 'metty.session.designed',
    filter: (file) => file.startsWith('VISIBILITY_SYSTEM_') && file.endsWith('.md'),
  },
  {
    dir: 'docs/strategy',
    stage: 'handoff_updated',
    eventType: 'metty.session.handoff_updated',
    filter: (file) => file.startsWith('NEXT_SESSION_HANDOFF_') && file.endsWith('.md'),
  },
];

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function changedFilesSince(baseRef = 'HEAD~1') {
  try {
    const output = execFileSync('git', ['diff', '--name-only', baseRef, 'HEAD'], {
      cwd: env.PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function currentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: env.PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

function lessonNumber(filePath) {
  if (!filePath.endsWith('LESSONS.md')) return null;
  try {
    const text = fs.readFileSync(path.join(env.PROJECT_ROOT, filePath), 'utf8');
    const numbers = [...text.matchAll(/Lesson\s*#?(\d+)/gi)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    return numbers.length > 0 ? Math.max(...numbers) : null;
  } catch {
    return null;
  }
}

function buildMettyEventsFromFiles(files = []) {
  const events = [];
  const seen = new Set();
  for (const filePath of files) {
    const normalized = String(filePath || '').trim();
    if (!normalized) continue;
    const basename = path.basename(normalized);
    for (const watch of WATCH_PATHS) {
      if (!normalized.startsWith(`${watch.dir}/`) || !watch.filter(basename)) continue;
      const key = `${watch.eventType}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        event_type: watch.eventType,
        team: 'meta',
        bot_name: 'metty',
        severity: 'info',
        title: `메티 ${watch.stage}: ${basename}`,
        tags: ['metty', 'collab-trace', watch.stage],
        metadata: {
          file_path: normalized,
          stage: watch.stage,
          lesson_number: lessonNumber(normalized),
        },
      });
    }
  }
  return events;
}

async function checkMettyChanges({ baseRef = null, dryRun = false } = {}) {
  const head = currentHead();
  const state = readState();
  const resolvedBaseRef = baseRef || state.lastHead || 'HEAD~1';
  const alreadyProcessed = !baseRef && head && state.lastHead === head;
  const files = alreadyProcessed ? [] : changedFilesSince(resolvedBaseRef);
  let currentCycleId = null;
  try {
    currentCycleId = await cycle.getCurrentCycleId();
  } catch (error) {
    console.warn(`[metty-trace] current cycle 조회 실패: ${error?.message || error}`);
  }
  const events = buildMettyEventsFromFiles(files).map((event) => ({
    ...event,
    metadata: {
      ...event.metadata,
      cycle_id: currentCycleId,
      detected_at: new Date().toISOString(),
      base_ref: resolvedBaseRef,
      head,
    },
  }));

  if (!dryRun) {
    for (const event of events) await eventLake.recordEvent(event);
    if (head) writeState({ lastHead: head, lastBaseRef: resolvedBaseRef, eventCount: events.length });
  }

  return {
    ok: true,
    dryRun,
    baseRef: resolvedBaseRef,
    head,
    alreadyProcessed,
    stateFile: STATE_FILE,
    changedFiles: files,
    eventCount: events.length,
    events,
  };
}

async function main() {
  const result = await checkMettyChanges({
    baseRef: argValue('base-ref', null),
    dryRun: hasArg('dry-run'),
  });
  if (hasArg('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`metty-trace ${result.eventCount} event(s)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`metty-trace failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  WATCH_PATHS,
  buildMettyEventsFromFiles,
  checkMettyChanges,
  STATE_FILE,
};

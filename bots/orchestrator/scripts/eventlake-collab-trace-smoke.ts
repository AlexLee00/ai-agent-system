// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');

const eventLake = require('../../../packages/core/lib/event-lake');
const cycle = require('../../../packages/core/lib/cycle');
const mettyTrace = require('../lib/write/metty-trace');
const codexManager = require('../lib/steward/codex-manager');

async function runSmoke() {
  assert.equal(typeof eventLake.recordEvent, 'function');
  assert.equal(typeof cycle.getCurrentCycleId, 'function');
  assert.equal(typeof cycle.getNextCycleId, 'function');
  assert.equal(typeof codexManager.traceActiveTasks, 'function');
  assert.equal(typeof codexManager.archiveCompleted, 'function');

  const events = mettyTrace.buildMettyEventsFromFiles([
    'docs/metty/LESSONS.md',
    'docs/strategy/VISIBILITY_SYSTEM_v3.2.md',
    'docs/strategy/NEXT_SESSION_HANDOFF_2026-05-14.md',
    'docs/codex/CODEX_EVENTLAKE_COLLAB_TRACE.md',
    'README.md',
  ]);

  assert.equal(events.length, 5);
  assert.equal(events.some((event) => event.event_type === 'metty.session.lesson_added'), true);
  assert.equal(events.some((event) => event.event_type === 'metty.session.designed'), true);
  assert.equal(events.some((event) => event.event_type === 'metty.session.handoff_updated'), true);
  assert.equal(events.some((event) => event.event_type === 'metty.session.analyzed'), true);
  assert.equal(events.every((event) => event.team === 'meta' && event.bot_name === 'metty'), true);

  return {
    ok: true,
    status: 'eventlake_collab_trace_smoke_passed',
    eventTypes: events.map((event) => event.event_type),
  };
}

if (require.main === module) {
  runSmoke()
    .then((result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(result.status);
    })
    .catch((error) => {
      console.error(`eventlake-collab-trace-smoke failed: ${error?.message || error}`);
      process.exit(1);
    });
}

module.exports = { runSmoke };

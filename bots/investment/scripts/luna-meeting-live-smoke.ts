#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createMeetingEventBus } from '../services/meeting-room/server/meeting-event-bus.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fixturePlanNote() {
  return {
    ok: true,
    type: 'morning',
    generatedAt: '2026-07-02T00:00:00.000Z',
    segments: [],
    gates: [],
    regimes: [],
    strategySignals: [],
    circuitLocks: [],
    pendingDecisions: [],
    positions: [],
    readOnly: true,
    shadowOnly: true,
    briefMarkdown: '# live stream smoke\n- 자문 전용',
  };
}

function fixtureAgenda() {
  return {
    key: 'market:crypto',
    title: '암호화폐 24시간 점검',
    kind: 'market',
    evidence: { fixture: true },
    defaultGrade: 'c_master',
  };
}

async function main() {
  const bus = createMeetingEventBus({ limit: 500 });
  for (let index = 1; index <= 501; index += 1) {
    bus.emit({
      meetingId: 'meeting-a',
      type: 'agent.done',
      agent: 'luna',
      role: 'analysis',
      agendaKey: 'market:crypto',
      summary: `event ${index}`,
      fullText: `full event ${index}`,
      scores: { bull: index },
      payload: { index, content: 'must_not_be_public' },
    });
  }
  const buffered = bus.getMeetingEvents('meeting-a');
  assert.equal(buffered.length, 500);
  assert.equal(buffered[0].seq, 2);
  assert.equal(buffered[499].seq, 501);
  assert.equal(buffered[0].globalSeq, 2);
  assert.equal(buffered[499].payload.content, undefined);
  assert.equal(buffered[499].hasFullText, true);
  assert.equal(bus.getFullEvent('meeting-a', 501).fullText, 'full event 501');
  assert.deepEqual(bus.getMeetingEvents('meeting-a', 500).map((row) => row.seq), [501]);
  assert.deepEqual(bus.getGlobalEvents(500).map((row) => row.globalSeq), [501]);

  let callbackCount = 0;
  const unsubscribe = bus.subscribeMeeting('meeting-b', () => { callbackCount += 1; });
  bus.emit({ meetingId: 'meeting-b', type: 'meeting.started', summary: 'open' });
  unsubscribe();
  bus.emit({ meetingId: 'meeting-b', type: 'meeting.ended', summary: 'close' });
  assert.equal(callbackCount, 1);

  const minutes = [];
  const events = [];
  const result = await runMeetingSession({
    type: 'morning',
    chair: 'luna',
    dryRun: true,
    apply: false,
    noLlm: true,
    planNote: fixturePlanNote(),
    agendas: [fixtureAgenda()],
    onMinute: (minute) => {
      minutes.push(minute);
      if (minute.seq === 2) throw new Error('minute callback fixture failure');
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'phase.changed') throw new Error('event callback fixture failure');
    },
  }, {
    executeInvestmentSkill: async () => ({ ok: true, text: '그릴 결과 fixture' }),
  });
  assert.equal(result.ok, true);
  assert.equal(minutes.length, result.minutes.length);
  assert.equal(events[0].type, 'meeting.started');
  assert.equal(events.some((event) => event.type === 'phase.changed'), true);
  assert.equal(events.some((event) => event.type === 'decision.pending'), true);
  assert.equal(events.at(-1).type, 'meeting.ended');
  assert.equal(result.telegram.attempted, false);

  const summary = {
    ok: true,
    smoke: 'luna-meeting-live',
    step: 'S1',
    buffered: buffered.length,
    minuteEvents: events.length,
    firstEvent: events[0].type,
    lastEvent: events.at(-1).type,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-meeting-live-smoke 실패:' });
}

export { main };

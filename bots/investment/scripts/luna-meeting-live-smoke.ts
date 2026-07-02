#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import http from 'http';
import { createMeetingEventBus } from '../services/meeting-room/server/meeting-event-bus.ts';
import { startMeetingRoomWebServer } from '../services/meeting-room/server/index.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function request(baseUrl, pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, options);
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, ok: res.ok, payload, text };
}

function readSseEvents(baseUrl, pathname, stopEvent = 'close', timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`${baseUrl}${pathname}`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = { event: 'message', id: null, data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) event.id = line.slice('id:'.length).trim();
            if (line.startsWith('event:')) event.event = line.slice('event:'.length).trim();
            if (line.startsWith('data:')) event.data += line.slice('data:'.length).trim();
          }
          if (event.data) {
            try {
              event.payload = JSON.parse(event.data);
            } catch {
              event.payload = {};
            }
          }
          if (event.event !== 'message' || event.data) events.push(event);
          if (event.event === stopEvent) {
            req.destroy();
            resolve(events);
            return;
          }
          boundary = buffer.indexOf('\n\n');
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(events);
    });
  });
}

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

  const offStarted = await startMeetingRoomWebServer({
    port: 0,
    host: '127.0.0.1',
  }, {
    meetingStore: {
      listMeetings: async () => [],
      hasOpenMeetingType: async () => false,
    },
  });
  const offBaseUrl = `http://127.0.0.1:${offStarted.server.address().port}`;
  try {
    const health = await request(offBaseUrl, '/api/health');
    assert.equal(health.payload.liveStreamEnabled, false);
    const live = await request(offBaseUrl, '/api/meetings/live');
    assert.equal(live.status, 404);
    assert.equal(live.payload.error, 'meeting_live_stream_disabled');
    const stream = await request(offBaseUrl, '/api/meetings/run_fixture/stream');
    assert.equal(stream.status, 404);
    assert.equal(stream.payload.error, 'meeting_live_stream_disabled');
    const full = await request(offBaseUrl, '/api/meetings/run_fixture/events/1/full');
    assert.equal(full.status, 404);
    assert.equal(full.payload.error, 'meeting_live_stream_disabled');
  } finally {
    await closeServer(offStarted.server);
  }

  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const jayBusEvents = [];
  const onServerMinute = (options, minute) => {
    options.onMinute?.(minute);
    options.onEvent?.({
      type: minute.seq === 1 ? 'meeting.started' : 'meeting.ended',
      agent: minute.speaker,
      role: minute.role,
      agendaKey: minute.agendaKey,
      summary: minute.content,
      fullText: minute.content,
      payload: { minuteSeq: minute.seq, state: minute.meta?.state || null },
    });
  };
  const onStarted = await startMeetingRoomWebServer({
    port: 0,
    host: '127.0.0.1',
    liveStreamEnabled: true,
    liveJayBusEnabled: true,
    sseHeartbeatMs: 1000,
  }, {
    meetingStore: {
      listMeetings: async () => [],
      hasOpenMeetingType: async () => false,
    },
    buildMarketSegmentsFn: () => [
      { market: 'domestic', skipped: true, reason: 'weekend' },
      { market: 'overseas', skipped: false, reason: null },
      { market: 'crypto', skipped: false, reason: null },
    ],
    runMeetingSessionFn: async (options) => {
      onServerMinute(options, {
        seq: 1,
        agendaKey: 'session',
        speaker: 'system',
        role: 'system',
        content: '회의 시작 full text',
        meta: { state: 'open' },
      });
      await runGate;
      onServerMinute(options, {
        seq: 2,
        agendaKey: 'session',
        speaker: 'system',
        role: 'system',
        content: '회의 종료 full text',
        meta: { state: 'close' },
      });
      return { ok: true, session: { id: 9901 }, minutes: [{ seq: 1 }, { seq: 2 }], decisions: [], markdownPath: null };
    },
    publishToJayBusFn: async (topic, payload, source) => {
      jayBusEvents.push({ topic, payload, source });
    },
  });
  const onBaseUrl = `http://127.0.0.1:${onStarted.server.address().port}`;
  try {
    const health = await request(onBaseUrl, '/api/health');
    assert.equal(health.payload.liveStreamEnabled, true);
    const start = await request(onBaseUrl, '/api/meetings/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'morning', noLlm: true }),
    });
    assert.equal(start.status, 202);
    const runId = start.payload.run.id;
    const liveSse = readSseEvents(onBaseUrl, `/api/meetings/${runId}/stream`, 'close');
    const full = await request(onBaseUrl, `/api/meetings/${runId}/events/1/full`);
    assert.equal(full.status, 200);
    assert.equal(full.payload.source, 'memory');
    assert.equal(full.payload.fullText, '회의 시작 full text');
    releaseRun();
    const sseEvents = await liveSse;
    assert.deepEqual(sseEvents.map((event) => event.event), ['hello', 'meeting.event', 'meeting.event', 'close']);
    assert.deepEqual(sseEvents.filter((event) => event.event === 'meeting.event').map((event) => event.id), ['1', '2']);
    const replayEvents = await readSseEvents(onBaseUrl, `/api/meetings/${runId}/stream?lastEventId=1`, 'close');
    assert.deepEqual(replayEvents.filter((event) => event.event === 'meeting.event').map((event) => event.payload.seq), [2]);
    const globalEvents = await readSseEvents(onBaseUrl, '/api/meetings/live', 'meeting.event');
    assert.equal(globalEvents[0].event, 'hello');
    assert.equal(globalEvents.find((event) => event.event === 'meeting.event').payload.meetingId, runId);
    await sleep(25);
    assert.ok(jayBusEvents.length >= 2);
    assert.equal(jayBusEvents[0].source, 'luna-meeting-room');
    assert.equal(jayBusEvents[0].topic, 'meeting.meeting.started');
  } finally {
    await closeServer(onStarted.server);
  }

  const jayBusFailureStarted = await startMeetingRoomWebServer({
    port: 0,
    host: '127.0.0.1',
    liveStreamEnabled: true,
    liveJayBusEnabled: true,
  }, {
    meetingStore: {
      listMeetings: async () => [],
      hasOpenMeetingType: async () => false,
    },
    buildMarketSegmentsFn: () => [
      { market: 'domestic', skipped: true, reason: 'weekend' },
      { market: 'overseas', skipped: false, reason: null },
      { market: 'crypto', skipped: false, reason: null },
    ],
    runMeetingSessionFn: async (options) => {
      options.onMinute?.({ seq: 1, agendaKey: 'session', speaker: 'system', role: 'system', content: 'open', meta: { state: 'open' } });
      options.onEvent?.({ type: 'meeting.started', agent: 'system', role: 'system', agendaKey: 'session', summary: 'open', fullText: 'open' });
      return { ok: true, session: { id: 9902 }, minutes: [{ seq: 1 }], decisions: [], markdownPath: null };
    },
    publishToJayBusFn: async () => {
      throw new Error('jaybus fixture failure');
    },
  });
  const jayBusFailureBaseUrl = `http://127.0.0.1:${jayBusFailureStarted.server.address().port}`;
  try {
    const start = await request(jayBusFailureBaseUrl, '/api/meetings/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'morning', noLlm: true }),
    });
    assert.equal(start.status, 202);
    await sleep(50);
    const run = await request(jayBusFailureBaseUrl, `/api/meetings/${start.payload.run.id}`);
    assert.equal(run.payload.run.status, 'completed');
  } finally {
    await closeServer(jayBusFailureStarted.server);
  }

  const appJs = fs.readFileSync(new URL('../services/meeting-room/web/app.js', import.meta.url), 'utf8');
  const indexHtml = fs.readFileSync(new URL('../services/meeting-room/web/index.html', import.meta.url), 'utf8');
  assert.ok(appJs.includes('const [liveStreamEnabled, setLiveStreamEnabled] = useState(false);'));
  assert.ok(appJs.includes("source.addEventListener('meeting.event'"));
  assert.ok(appJs.includes('function AgentHistory'));
  assert.ok(appJs.includes('function ReplayControls'));
  assert.ok(appJs.includes('function minuteToReplayEvent'));
  assert.ok(appJs.includes('function ScoreGraph'));
  assert.ok(appJs.includes('function mergeEventsBySeq'));
  assert.ok(appJs.includes('function eventFullKey'));
  assert.ok(appJs.includes('전문 보기'));
  assert.ok(appJs.includes('점수 표본 없음'));
  assert.ok(appJs.includes('<${Timeline} token=${token} detail=${detail} catchup=${catchup} loading=${detailLoading} liveEvents=${liveEvents} />'));
  assert.ok(indexHtml.includes('.live-event-list'));
  assert.ok(indexHtml.includes('.agent-history-grid'));
  assert.ok(indexHtml.includes('.replay-panel'));
  assert.ok(indexHtml.includes('.full-text-panel'));
  assert.ok(indexHtml.includes('.score-graph'));

  const summary = {
    ok: true,
    smoke: 'luna-meeting-live',
    step: 'S5',
    buffered: buffered.length,
    minuteEvents: events.length,
    firstEvent: events[0].type,
    lastEvent: events.at(-1).type,
    http: {
      offDisabled: true,
      sseReplay: true,
      fullText: true,
      jayBusMock: jayBusEvents.length,
      jayBusFailureSafe: true,
      webLiveView: true,
      replay: true,
      debateVisibility: true,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-meeting-live-smoke 실패:' });
}

export { main };

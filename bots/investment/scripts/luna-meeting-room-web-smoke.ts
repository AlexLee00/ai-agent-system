#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { startMeetingRoomWebServer } from '../services/meeting-room/server/index.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonHeaders(token = '') {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, ok: res.ok, payload, text };
}

function createMemoryStore() {
  const sessions = [
    {
      id: 1,
      type: 'morning',
      status: 'closed',
      chair: 'luna',
      startedAt: '2026-06-11T00:00:00.000Z',
      closedAt: '2026-06-11T00:05:00.000Z',
      summary: 'fixture meeting',
      segments: [],
    },
  ];
  const minutes = [
    { id: 1, sessionId: 1, seq: 1, agendaKey: 'session', speaker: 'system', role: 'system', content: 'open', meta: {}, createdAt: '2026-06-11T00:00:00.000Z' },
    { id: 2, sessionId: 1, seq: 2, agendaKey: 'market:crypto', speaker: 'stack-adapter', role: 'data', content: '<script>alert(1)</script>', meta: {}, createdAt: '2026-06-11T00:00:01.000Z' },
  ];
  const decisions = [
    { id: 11, sessionId: 1, agendaKey: 'market:crypto', decision: 'crypto 점검 pending', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-12T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:02.000Z' },
    { id: 12, sessionId: 1, agendaKey: 'market:domestic', decision: 'domestic 점검 pending', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-13T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:03.000Z' },
  ];
  let nextSessionId = 2;
  let nextMinuteId = 3;

  return {
    listMeetings: async () => sessions.slice().sort((a, b) => b.id - a.id),
    getMeeting: async (id) => {
      const session = sessions.find((row) => String(row.id) === String(id));
      if (!session) throw Object.assign(new Error('meeting not found'), { statusCode: 404, code: 'meeting_not_found' });
      return {
        ok: true,
        session,
        minutes: minutes.filter((row) => String(row.sessionId) === String(id)).sort((a, b) => a.seq - b.seq),
        decisions: decisions.filter((row) => String(row.sessionId) === String(id)),
      };
    },
    listPendingDecisions: async () => decisions
      .filter((row) => row.status === 'pending_master')
      .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt))),
    hasOpenMeetingType: async (type) => sessions.some((row) => row.type === type && row.status === 'open'),
    updateDecision: async (id, action, note) => {
      const decision = decisions.find((row) => String(row.id) === String(id));
      if (!decision) throw Object.assign(new Error('decision not found'), { statusCode: 404, code: 'decision_not_found' });
      if (decision.status !== 'pending_master') {
        throw Object.assign(new Error(`decision ${decision.status}`), { statusCode: 409, code: 'decision_not_pending' });
      }
      if (action === 'confirm') decision.status = 'confirmed';
      if (action === 'defer') decision.status = 'deferred';
      decision.evidence = { ...decision.evidence, mr_b: { action, note, advisoryOnly: true } };
      const nextSeq = minutes.filter((row) => row.sessionId === decision.sessionId).length + 1;
      minutes.push({
        id: nextMinuteId++,
        sessionId: decision.sessionId,
        seq: nextSeq,
        agendaKey: decision.agendaKey,
        speaker: 'meeting-room-web',
        role: 'system',
        content: `MR-B ${action}: ${note || 'no note'}`,
        meta: { state: `decision_${action}`, decisionId: id },
        createdAt: new Date().toISOString(),
      });
      return {
        ok: true,
        action,
        logicalStatus: action === 'defer' ? 'deferred' : 'confirmed',
        decision,
        auditMinuteSeq: nextSeq,
      };
    },
    addCompletedMeeting: () => {
      const id = nextSessionId++;
      sessions.push({
        id,
        type: 'morning',
        status: 'closed',
        chair: 'luna',
        startedAt: new Date().toISOString(),
        closedAt: new Date().toISOString(),
        summary: 'started from web smoke',
        segments: [],
      });
      minutes.push({ id: nextMinuteId++, sessionId: id, seq: 1, agendaKey: 'session', speaker: 'system', role: 'system', content: 'open', meta: {}, createdAt: new Date().toISOString() });
      return id;
    },
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function waitForRun(baseUrl, runId) {
  for (let i = 0; i < 20; i += 1) {
    const res = await request(baseUrl, `/api/meetings/${runId}`);
    if (res.payload?.run?.status === 'completed') return res.payload.run;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not complete`);
}

async function main() {
  const store = createMemoryStore();
  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const deps = {
    meetingStore: store,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# fixture plan-note\n- advisory only',
      segments: [],
    }),
    runMeetingSessionFn: async () => {
      await runGate;
      const id = store.addCompletedMeeting();
      return { ok: true, session: { id }, minutes: [{ seq: 1 }], decisions: [], markdownPath: '/tmp/fixture.md' };
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => ({ ok: true, provider: 'fixture', text: 'fixture answer' }),
  };

  const started = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, deps);
  const address = started.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.equal(address.address, '127.0.0.1');

  try {
    const health = await request(baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.shadowOnly, true);

    const html = await request(baseUrl, '/');
    assert.equal(html.status, 200);
    assert.ok(html.text.includes('Luna Meeting Room'));
    const appJs = await request(baseUrl, '/app.js');
    assert.equal(appJs.status, 200);
    assert.equal(appJs.text.includes('dangerouslySetInnerHTML'), false);
    const escapedStaticPath = await request(baseUrl, '/%2e%2e%2fserver/index.ts');
    assert.equal(escapedStaticPath.status, 403);

    const meetings = await request(baseUrl, '/api/meetings');
    assert.equal(meetings.payload.meetings.length, 1);
    assert.ok(Array.isArray(meetings.payload.segments));

    const detail = await request(baseUrl, '/api/meetings/1');
    assert.equal(detail.payload.minutes.length, 2);
    const catchup = await request(baseUrl, '/api/catchup/1');
    assert.equal(catchup.payload.lines.length, 3);

    const pending = await request(baseUrl, '/api/decisions/pending');
    assert.deepEqual(pending.payload.decisions.map((row) => row.id), [11, 12]);

    const confirm = await request(baseUrl, '/api/decisions/11', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ action: 'confirm', note: 'approved in smoke' }),
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.payload.decision.status, 'confirmed');
    const doubleConfirm = await request(baseUrl, '/api/decisions/11', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ action: 'confirm' }),
    });
    assert.equal(doubleConfirm.status, 409);

    const defer = await request(baseUrl, '/api/decisions/12', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ action: 'defer', note: 'need more data' }),
    });
    assert.equal(defer.status, 200);
    assert.equal(defer.payload.logicalStatus, 'deferred');
    assert.equal(defer.payload.decision.status, 'deferred');
    const pendingAfterDefer = await request(baseUrl, '/api/decisions/pending');
    assert.deepEqual(pendingAfterDefer.payload.decisions.map((row) => row.id), []);

    const start = await request(baseUrl, '/api/meetings/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ type: 'morning', noLlm: true }),
    });
    assert.equal(start.status, 202);
    const duplicate = await request(baseUrl, '/api/meetings/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ type: 'morning', noLlm: true }),
    });
    assert.equal(duplicate.status, 409);
    releaseRun();
    const completedRun = await waitForRun(baseUrl, start.payload.run.id);
    assert.equal(completedRun.status, 'completed');

    const ask1 = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '오늘 결정 대기 핵심은?' }),
    });
    const ask2 = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'aria', question: '기술적으로 볼 것은?' }),
    });
    const ask3 = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'sophia', question: '한 번 더?' }),
    });
    assert.equal(ask1.status, 200);
    assert.equal(ask2.status, 200);
    assert.equal(ask3.status, 429);
  } finally {
    await closeServer(started.server);
  }

  const authStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1', token: 'fixture-token' }, deps);
  const authBase = `http://127.0.0.1:${authStarted.server.address().port}`;
  try {
    const unauthorized = await request(authBase, '/api/health');
    assert.equal(unauthorized.status, 401);
    const authorized = await request(authBase, '/api/health', { headers: { authorization: 'Bearer fixture-token' } });
    assert.equal(authorized.status, 200);
  } finally {
    await closeServer(authStarted.server);
  }

  return {
    ok: true,
    smoke: 'luna-meeting-room-web',
    scenarios: {
      apiListDetailCatchup: true,
      pendingDueOrder: true,
      startDuplicateGuard: true,
      confirmAuditAndIdempotency: true,
      deferAudit: true,
      deferLeavesPendingQueue: true,
      askRateLimit: true,
      tokenAuth: true,
      localhostBinding: true,
      staticServingAndXssBaseline: true,
      staticPathEscapeBlocked: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`[luna-meeting-room-web-smoke] ok ${JSON.stringify(result.scenarios)}`);
    },
    errorPrefix: '❌ luna-meeting-room-web-smoke 실패:',
  });
}

export default { main };

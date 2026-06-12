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
    {
      id: 2,
      sessionId: 1,
      seq: 2,
      agendaKey: 'market:crypto',
      speaker: 'stack-adapter',
      role: 'data',
      content: [
        '### crypto 요약',
        '- **BTC** 점검',
        '| 항목 | 값 |',
        '| --- | --- |',
        '| risk | reduced |',
        '게이트=reduced score=55.3',
        '레짐=bear source=hmm',
        '5. **활성 서킷**: 57건',
        '<script>alert(1)</script>',
      ].join('\n'),
      meta: {},
      createdAt: '2026-06-11T00:00:01.000Z',
    },
    {
      id: 3,
      sessionId: 1,
      seq: 3,
      agendaKey: 'decision:regime-engine-hmm',
      speaker: 'stack-adapter',
      role: 'data',
      content: [
        'C15 결정 대기 항목',
        '{',
        '  "type": "registry_review",',
        '  "component": "regime-engine-hmm",',
        '  "status": "active",',
        '  "sampleCount": 0,',
        '  "criteria": {',
        '    "metrics": ["brier_hmm_lt_fallback", "transition_alert_precision"],',
        '    "placeholder": true,',
        '    "durationWeeks": 4,',
        '    "compareAgainst": "same_bar_close",',
        '    "grillCoverage": true,',
        '    "decisionTracking": true,',
        '    "completedMeetings": 10',
        '  }',
        '}',
      ].join('\n'),
      meta: { legacyFixture: true },
      createdAt: '2026-06-11T00:00:02.000Z',
    },
    {
      id: 4,
      sessionId: 1,
      seq: 4,
      agendaKey: 'decision:adr',
      speaker: 'adr',
      role: 'decision',
      content: 'ADR recorded: c_master/pending_master',
      meta: { fixture: 'adr' },
      createdAt: '2026-06-11T00:00:03.000Z',
    },
    {
      id: 5,
      sessionId: 1,
      seq: 5,
      agendaKey: 'market:domestic',
      speaker: 'sophia',
      role: 'analysis',
      content: [
        '국내 장전 계획에 대한 분석 결과입니다.',
        '',
        'G0 게이트: 국내: 중단(32), 해외: 중단(33), 암호화폐: 감소(55), 미국: 전체(72)',
        '국내 시장은 현재 중단 상태(32점)입니다.',
        '암호화폐 시장은 감소(55점)로, 하락 레짐을 유지하고 있습니다.',
        '해외 시장은 현재 halt 상태이며, 이는 저평가 상태를 나타냅니다.',
        "G0 게이트: 해외 시장은 현재 '할당' 상태이며, 점수는 32.51입니다.",
        '현재 국내, 해외, 암호화폐 세그먼트 모두 중단 상태입니다.',
        'BTC 실현 볼륨 프로ksi: 65.38 (점유율 상승)',
        '* BTC 실현 볼륨 프로끼가 상승하고 있습니다.',
        '* **전략군 24시간**: 0건(입장 없음)',
        '5. 결정 대기: 현재 5개의 결정이 대기 중입니다.',
        '현재는 입장한 거래가 없습니다.',
        '* 전략군은 현재 입장하지 않았으며, 전략군의 입장을 고려할 필요가 있습니다.',
        '* 결정 대기는 5건 남아있다.',
        '5. 결정 대기는 5건이 대기 중입니다.',
        'C15 결정: 중단 제안은 한국어 라벨로 유지합니다.',
        '',
        '이러한 결과를 기반으로, 최종 결론은 다음과 같습니다.',
        '',
        '- 국내 시장은 주의가 필요합니다.',
        '',
        '이러한 결과를 기반으로, Luna 회의에서는 최종 결론을 다음과 같이 제시할 수 있습니다.',
        '',
        '- 국내 장전 계획은 주의가 필요합니다.',
      ].join('\n'),
      meta: { fixture: 'repetition' },
      createdAt: '2026-06-11T00:00:04.000Z',
    },
  ];
  const decisions = [
    { id: 11, sessionId: 1, agendaKey: 'decision:regime-engine-hmm', decision: 'regime-engine-hmm: crypto **점검** pending\n- confirm 필요', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-12T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:02.000Z' },
    { id: 12, sessionId: 1, agendaKey: 'market:domestic', decision: 'advisory 기록 후 마스터 확인 대기', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-13T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:03.000Z' },
  ];
  let nextSessionId = 2;
  let nextMinuteId = 6;

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
        return {
          ok: true,
          action,
          logicalStatus: decision.status,
          idempotent: true,
          decision,
          auditMinuteSeq: null,
        };
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

async function waitForRun(baseUrl, runId, expectedStatus = 'completed') {
  for (let i = 0; i < 20; i += 1) {
    const res = await request(baseUrl, `/api/meetings/${runId}`);
    if (res.payload?.run?.status === expectedStatus) return res.payload.run;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}

async function main() {
  const store = createMemoryStore();
  const runSessionOptions = [];
  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const deps = {
    meetingStore: store,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# fixture plan-note\n- advisory only',
      segments: [],
    }),
    buildMarketSegmentsFn: () => [
      { market: 'domestic', skipped: true, reason: 'weekend' },
      { market: 'overseas', skipped: false, reason: null },
      { market: 'crypto', skipped: false, reason: null },
    ],
    runMeetingSessionFn: async (options) => {
      runSessionOptions.push(options);
      await runGate;
      const id = store.addCompletedMeeting();
      return { ok: true, session: { id }, minutes: [{ seq: 1 }], decisions: [], markdownPath: '/tmp/fixture.md' };
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => ({ ok: true, provider: 'fixture', text: '#### fixture answer\n- **bold** answer\n| k | v |\n|---|---|\n| ok | true |' }),
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
    assert.ok(html.text.includes(':focus-visible'));
    assert.ok(html.text.includes('outline-offset: 3px'));
    assert.ok(html.text.includes('.due.overdue'));
    assert.ok(html.text.includes('.minute.adr'));
    assert.ok(html.text.includes('.role-legend'));
    assert.ok(html.text.includes('.role-dot.data'));
    assert.ok(html.text.includes('overflow-x: auto'));
    assert.ok(html.text.includes('table-layout: fixed'));
    assert.ok(html.text.includes('overflow-wrap: anywhere'));
    const appJs = await request(baseUrl, '/app.js');
    assert.equal(appJs.status, 200);
    assert.equal(appJs.text.includes('dangerouslySetInnerHTML'), false);
    assert.equal(appJs.text.includes('innerHTML'), false);
    assert.ok(appJs.text.includes('function renderMarkdownLite'));
    assert.ok(appJs.text.includes('function MarkdownLite'));
    assert.ok(appJs.text.includes('renderInlineMarkdown'));
    assert.ok(appJs.text.includes('markdown-table'));
    assert.ok(appJs.text.includes('className="topline" role="status" aria-label="회의실 실행 상태"'));
    assert.ok(appJs.text.includes('aria-label="자문 및 섀도 전용"'));
    assert.ok(appJs.text.includes('aria-label="로컬 바인딩 127.0.0.1 포트 7791"'));
    assert.ok(appJs.text.includes('aria-label="TeamJay Dashboard 7787 새 창으로 열기"'));
    assert.ok(appJs.text.includes('htmlFor="meeting-room-token">접근 토큰 (MEETING_ROOM_TOKEN)'));
    assert.ok(appJs.text.includes('type="password"'));
    assert.ok(appJs.text.includes('autoComplete="off"'));
    assert.ok(appJs.text.includes('aria-label="회의실 접근 토큰"'));
    assert.ok(appJs.text.includes('className="tabs"'));
    assert.ok(appJs.text.includes('className="tab-switcher" role="tablist" aria-label="회의실 화면 전환"'));
    assert.ok(appJs.text.includes('id="meeting-tab-daily"'));
    assert.ok(appJs.text.includes('id="meeting-tab-ask"'));
    assert.ok(appJs.text.includes('role="tab"'));
    assert.ok(appJs.text.includes("aria-selected=${tab === 'daily'}"));
    assert.ok(appJs.text.includes("aria-selected=${tab === 'ask'}"));
    assert.ok(appJs.text.includes('aria-controls="meeting-panel-daily"'));
    assert.ok(appJs.text.includes('aria-controls="meeting-panel-ask"'));
    assert.ok(appJs.text.includes('role="tabpanel"'));
    assert.ok(appJs.text.includes("aria-labelledby=${tab === 'daily' ? 'meeting-tab-daily' : 'meeting-tab-ask'}"));
    assert.ok(appJs.text.includes('function handleTabKeyDown'));
    assert.ok(appJs.text.includes('ArrowRight'));
    assert.ok(appJs.text.includes('ArrowLeft'));
    assert.ok(appJs.text.includes("Home: 'daily'"));
    assert.ok(appJs.text.includes("End: 'ask'"));
    assert.ok(appJs.text.includes("tabIndex=${tab === 'daily' ? 0 : -1}"));
    assert.ok(appJs.text.includes("tabIndex=${tab === 'ask' ? 0 : -1}"));
    assert.ok(html.text.includes('.tab-switcher'));
    assert.ok(appJs.text.includes("aria-pressed=${tab === 'daily'}"));
    assert.ok(appJs.text.includes("aria-pressed=${tab === 'ask'}"));
    assert.ok(appJs.text.includes('function meetingStatusLabel'));
    assert.ok(appJs.text.includes('function meetingTypeLabel'));
    assert.ok(appJs.text.includes('function agendaLabel'));
    assert.ok(appJs.text.includes('function speakerLabel'));
    assert.ok(appJs.text.includes('aria-label=${`회의 #${meeting.id} ${meetingTypeLabel(meeting.type)} ${meetingStatusLabel(meeting.status)} 선택`}'));
    assert.ok(appJs.text.includes('aria-label=${`실행 중 회의 ${meetingTypeLabel(run.type)} ${meetingStatusLabel(run.status)} 선택`}'));
    assert.ok(appJs.text.includes('title=${`원문 상태: ${meeting.status ||'));
    assert.ok(appJs.text.includes('title=${`원문 타입: ${meeting.type ||'));
    assert.ok(appJs.text.includes('title=${`원문 안건: ${minute.agendaKey ||'));
    assert.ok(appJs.text.includes('title=${`원문 안건: ${decision.agendaKey ||'));
    assert.ok(appJs.text.includes('role="region" aria-label="회의 목록"'));
    assert.ok(appJs.text.includes('role="list" aria-live="polite" aria-label=${`회의 목록 ${totalCount}건`}'));
    assert.ok(appJs.text.includes('className="meeting-list-row" role="listitem"'));
    assert.ok(appJs.text.includes('htmlFor="meeting-type-select">회의 시작'));
    assert.ok(appJs.text.includes('aria-label="시작할 회의 타입"'));
    assert.ok(appJs.text.includes('aria-describedby="meeting-segment-status"'));
    assert.ok(appJs.text.includes('id="meeting-segment-status"'));
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label="시장 세그먼트 상태"'));
    assert.ok(appJs.text.includes('비활성, 사유'));
    assert.ok(appJs.text.includes('advisory/shadow 회의로 시작합니다.'));
    assert.ok(appJs.text.includes('selectedTypeDisabled'));
    assert.ok(appJs.text.includes('startDisabled'));
    assert.ok(appJs.text.includes('선택한 회의 타입은 현재 비활성입니다'));
    assert.ok(appJs.text.includes('시작 불가, 사유'));
    assert.ok(appJs.text.includes('id="meeting-llm-toggle"'));
    assert.ok(appJs.text.includes('aria-describedby="meeting-llm-mode"'));
    assert.ok(appJs.text.includes('id="meeting-llm-mode"'));
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label="LLM 발언 모드"'));
    assert.ok(appJs.text.includes('role="region" aria-label="회의 타임라인"'));
    assert.ok(appJs.text.includes('role="list" aria-label="타임라인 역할 색상 범례"'));
    assert.ok(appJs.text.includes('aria-label=${`${label} 역할 색상`}'));
    assert.ok(appJs.text.includes('aria-label=${`${minute.seq}번 minute · ${agendaLabel(minute.agendaKey ||'));
    assert.ok(appJs.text.includes('speakerLabel(minute.speaker)}'));
    assert.ok(appJs.text.includes('원문 speaker: ${minute.speaker ||'));
    assert.ok(appJs.text.includes("'stack-adapter': '데이터 어댑터'"));
    assert.ok(appJs.text.includes("adr: 'ADR 기록기'"));
    assert.ok(appJs.text.includes('const catchupLines = loading'));
    assert.ok(appJs.text.includes("catchup?.length ? catchup : ['회의를 선택하면 U1 캐치업이 표시됩니다.']"));
    assert.ok(appJs.text.includes("const catchupLabel = `U1 캐치업 요약: ${catchupLines.join(' / ')}`"));
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label=${catchupLabel}'));
    assert.ok(appJs.text.includes('role="list" aria-label=${`U1 캐치업 ${catchupLines.length}줄 요약`}'));
    assert.ok(appJs.text.includes('className="catchup-line" role="listitem"'));
    assert.ok(appJs.text.includes('className="error" role="alert" aria-live="assertive"'));
    assert.ok(appJs.text.includes('className="notice" role="status" aria-live="polite"'));
    assert.ok(appJs.text.includes('회의 상세를 불러오는 중입니다.'));
    assert.ok(appJs.text.includes('이미 진행 중인 같은 타입 회의가 있습니다'));
    assert.ok(appJs.text.includes('이미 처리된 결정입니다. 최신 상태로 갱신했습니다.'));
    assert.ok(appJs.text.includes('분당 질의 한도에 도달했습니다'));
    assert.ok(appJs.text.includes('회의실 서버에 연결할 수 없습니다'));
    assert.ok(appJs.text.includes("setError('');"));
    assert.ok(appJs.text.includes("payload.run.status === 'completed'"));
    assert.ok(appJs.text.includes('await refreshSelected(payload.run.sessionId)'));
    assert.ok(appJs.text.includes('function clearDailyRoomData'));
    assert.ok(appJs.text.includes('clearDailyRoomData();'));
    assert.ok(appJs.text.includes('회의 상세를 불러오지 못했습니다.'));
    assert.ok(appJs.text.includes("payload.run.status === 'failed'"));
    assert.ok(appJs.text.includes('오류: ${payload.run.error ||'));
    assert.ok(appJs.text.includes('원인 미상'));
    assert.ok(appJs.text.includes('function dueState'));
    assert.ok(appJs.text.includes('기한 임박:'));
    assert.ok(appJs.text.includes('기한 경과:'));
    assert.ok(appJs.text.includes('기한 확인 필요:'));
    assert.ok(appJs.text.includes('title=${due.title} aria-label=${due.title}'));
    assert.ok(appJs.text.includes('function decisionGradeLabel'));
    assert.ok(appJs.text.includes('function decisionStatusLabel'));
    assert.ok(appJs.text.includes('function minuteClassName'));
    assert.ok(appJs.text.includes('function SegmentStatus'));
    assert.ok(appJs.text.includes('function segmentReasonLabel'));
    assert.ok(appJs.text.includes("weekend: '주말'"));
    assert.ok(appJs.text.includes('reasonLabel'));
    assert.ok(appJs.text.includes('segment-pill'));
    assert.ok(appJs.text.includes('세그먼트 상태 로딩 중'));
    assert.ok(appJs.text.includes('`${marketLabel(segment.market)} 활성`'));
    assert.ok(appJs.text.includes(": '활성'"));
    assert.equal(appJs.text.includes('`${marketLabel(segment.market)} active`'), false);
    assert.ok(appJs.text.includes('결정론 발언 · LLM 비용 0'));
    assert.ok(appJs.text.includes('LLM 발언 사용 · 비용 가드 적용'));
    assert.ok(appJs.text.includes('근거 JSON 보기'));
    assert.ok(appJs.text.includes('C 마스터 확인'));
    assert.ok(appJs.text.includes('마스터 액션 대기'));
    assert.ok(appJs.text.includes('원문 등급:'));
    assert.ok(appJs.text.includes('원문 상태:'));
    assert.ok(appJs.text.includes('마스터 액션 대기 결정 ${decisions.length}건'));
    assert.ok(appJs.text.includes('마스터 액션 대기 결정 없음'));
    assert.equal(appJs.text.includes('pending_master 결정 ${decisions.length}건'), false);
    assert.ok(appJs.text.includes('감사 메모'));
    assert.ok(appJs.text.includes("busy === 'confirm' ? '확정 중' : '확정'"));
    assert.ok(appJs.text.includes("busy === 'defer' ? '보류 중' : '보류'"));
    assert.ok(appJs.text.includes('결정 #${decision.id} 확정'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 보류'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 감사 메모'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 근거 JSON 보기'));
    assert.ok(appJs.text.includes('role="listitem"'));
    assert.ok(appJs.text.includes('aria-label=${`결정 #${decision.id} · ${agendaLabel(decision.agendaKey)}'));
    assert.ok(appJs.text.includes('role="region" aria-label="결정 대기함"'));
    assert.ok(appJs.text.includes('role="list" aria-live="polite" aria-label=${`마스터 액션 대기 결정 ${decisions.length}건`}'));
    assert.ok(appJs.text.includes('LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도'));
    assert.ok(appJs.text.includes('htmlFor="meeting-agent-select">에이전트'));
    assert.ok(appJs.text.includes('htmlFor="meeting-agent-question">질문'));
    assert.ok(appJs.text.includes('aria-label="질의 대상 에이전트"'));
    assert.ok(appJs.text.includes('aria-label="회의실 컨텍스트 기반 advisory 질문"'));
    assert.ok(appJs.text.includes('aria-describedby="ask-helper ask-safety-note"'));
    assert.ok(appJs.text.includes('function updateAgent'));
    assert.ok(appJs.text.includes('function updateQuestion'));
    assert.ok(appJs.text.includes('updateAgent(event.target.value)'));
    assert.ok(appJs.text.includes('updateQuestion(event.target.value)'));
    assert.ok(appJs.text.includes('질문을 입력하면 전송 버튼이 활성화됩니다.'));
    assert.ok(appJs.text.includes('질문을 입력하면 활성화됩니다.'));
    assert.ok(appJs.text.includes('선택한 에이전트에게 advisory 질문을 보냅니다.'));
    assert.ok(appJs.text.includes('아직 응답 없음 · 질문을 입력한 뒤 질의 보내기를 누르세요.'));
    assert.ok(appJs.text.includes('setAnswer(null);'));
    assert.ok(appJs.text.includes('className="answer" role="status" aria-live="polite" aria-busy=${busy} aria-label="에이전트 질의 응답"'));
    assert.ok(appJs.text.includes('질의 중 · 에이전트 응답을 기다리는 중입니다.'));
    assert.ok(appJs.text.includes('function answerStatusLabel'));
    assert.ok(appJs.text.includes('에이전트 ${answer.agent || agent} · 제공자 ${answer.provider || answer.route?.provider ||'));
    assert.ok(appJs.text.includes('상태 ${answerStatusLabel(answer.ok)}'));
    assert.equal(appJs.text.includes('ok=${String(answer.ok)}'), false);
    assert.ok(html.text.includes('.ask-helper'));
    assert.ok(html.text.includes('.notice'));
    assert.ok(html.text.includes('.decision-state'));
    assert.ok(html.text.includes('.catchup [role="list"]'));
    assert.ok(html.text.includes('.polling-status'));
    assert.ok(html.text.includes('details:not([open]) > :not(summary)'));
    assert.ok(html.text.includes('display: none;'));
    assert.ok(html.text.includes('@media (max-width: 1080px)'));
    assert.ok(html.text.includes('.grid, .ask-grid { grid-template-columns: 1fr; }'));
    assert.ok(html.text.includes('.meeting-list-row .meeting-item'));
    assert.ok(html.text.includes('.due.unknown'));
    assert.ok(appJs.text.includes("run.status === 'running'"));
    assert.ok(appJs.text.includes('const pollingIntervalMs = hasRunningRun ? 3000 : 30000'));
    assert.ok(appJs.text.includes('폴링: 실행 중 회의 감지 · 3초마다 갱신'));
    assert.ok(appJs.text.includes('폴링: 대기 · 30초마다 갱신'));
    assert.equal(appJs.text.includes('폴링: idle'), false);
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label="회의실 폴링 상태"'));
    assert.ok(appJs.text.includes("' adr'"));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${minute.content}'));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${decision.decision}'));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${answer.text || answer.error ||'));
    const escapedStaticPath = await request(baseUrl, '/%2e%2e%2fserver/index.ts');
    assert.equal(escapedStaticPath.status, 403);

    const meetings = await request(baseUrl, '/api/meetings');
    assert.equal(meetings.payload.meetings.length, 1);
    assert.ok(Array.isArray(meetings.payload.segments));
    assert.equal(meetings.payload.segments.find((row) => row.market === 'domestic')?.skipped, true);
    assert.equal(meetings.payload.segments.find((row) => row.market === 'domestic')?.reason, 'weekend');

    const detail = await request(baseUrl, '/api/meetings/1');
    assert.equal(detail.payload.minutes.length, 5);
    assert.equal(detail.payload.minutes[0].content, '회의 시작');
    assert.ok(detail.payload.minutes[1].content.includes('**BTC**'));
    assert.ok(detail.payload.minutes[1].content.includes('| 항목 | 값 |'));
    assert.ok(detail.payload.minutes[1].content.includes('<script>alert(1)</script>'));
    assert.ok(detail.payload.minutes[1].content.includes('게이트=reduced 점수=55.3'));
    assert.ok(detail.payload.minutes[1].content.includes('레짐=bear 출처=hmm'));
    assert.equal(detail.payload.minutes[1].content.includes('score='), false);
    assert.equal(detail.payload.minutes[1].content.includes('source='), false);
    assert.equal(detail.payload.minutes[1].content.includes('활성 서킷: 57건'), false);
    assert.ok(detail.payload.minutes[1].content.includes('과거 발언의 중복 서킷 숫자 숨김'));
    assert.equal(detail.payload.minutes[1].content.includes('legacy'), false);
    assert.equal(detail.payload.minutes[1].content.includes('distinct'), false);
    assert.equal(/[{}]/.test(detail.payload.minutes[2].content), false);
    assert.ok(detail.payload.minutes[2].content.includes('컴포넌트=C15 레짐 엔진 HMM'));
    assert.equal(detail.payload.minutes[2].content.includes('regime-engine-hmm'), false);
    assert.ok(detail.payload.minutes[2].content.includes('상태=활성'));
    assert.ok(detail.payload.minutes[2].content.includes('모드=미정→미정'));
    assert.ok(detail.payload.minutes[2].content.includes('Brier: HMM<폴백'));
    assert.ok(detail.payload.minutes[2].content.includes('비교 기준=same_bar_close'));
    assert.ok(detail.payload.minutes[2].content.includes('그릴 커버리지=예'));
    assert.ok(detail.payload.minutes[2].content.includes('결정 추적=예'));
    assert.ok(detail.payload.minutes[2].content.includes('완료 회의 수=10'));
    assert.ok(detail.payload.minutes[2].content.includes('placeholder 기준=예'));
    assert.equal(detail.payload.minutes[2].content.includes('상태=active'), false);
    assert.equal(detail.payload.minutes[2].content.includes('unknown→unknown'), false);
    assert.equal(detail.payload.minutes[2].content.includes('placeholder 기준=true'), false);
    assert.equal(detail.payload.minutes[2].content.includes('compareAgainst='), false);
    assert.equal(detail.payload.minutes[2].content.includes('grillCoverage='), false);
    assert.ok(detail.payload.minutes[3].content.includes('ADR 기록: C 마스터 확인 / 마스터 액션 대기'));
    assert.equal(detail.payload.minutes[3].content.includes('ADR recorded: c_master/pending_master'), false);
    assert.equal((detail.payload.minutes[4].content.match(/이러한 결과를 기반으로/g) || []).length, 1);
    assert.ok(detail.payload.minutes[4].content.includes('반복 결론 문단'));
    assert.ok(detail.payload.minutes[4].content.includes('국내: halt(32)'));
    assert.ok(detail.payload.minutes[4].content.includes('암호화폐: reduced(55)'));
    assert.ok(detail.payload.minutes[4].content.includes('미국: full(72)'));
    assert.ok(detail.payload.minutes[4].content.includes('halt 상태(32점)'));
    assert.ok(detail.payload.minutes[4].content.includes('암호화폐 시장은 reduced(55점)'));
    assert.ok(detail.payload.minutes[4].content.includes('해외 시장은 현재 halt 상태'));
    assert.ok(detail.payload.minutes[4].content.includes('세그먼트 모두 halt 상태'));
    assert.ok(detail.payload.minutes[4].content.includes('BTC 실현 볼륨 프록시'));
    assert.ok(detail.payload.minutes[4].content.includes('진입 없음'));
    assert.ok(detail.payload.minutes[4].content.includes('현재는 진입한 거래가 없습니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('이는 배치 halt 상태를 나타냅니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('전략군은 현재 진입하지 않았으며'));
    assert.ok(detail.payload.minutes[4].content.includes('전략군 진입을 고려'));
    assert.ok(detail.payload.minutes[4].content.includes('결정 대기: 과거 발언 숫자 숨김'));
    assert.equal(detail.payload.minutes[4].content.includes('legacy'), false);
    assert.equal(detail.payload.minutes[4].content.includes('최신 데이터 minute'), false);
    assert.equal(detail.payload.minutes[4].content.includes("'할당' 상태"), false);
    assert.equal(detail.payload.minutes[4].content.includes('프로ksi'), false);
    assert.equal(detail.payload.minutes[4].content.includes('프로끼'), false);
    assert.equal(detail.payload.minutes[4].content.includes('저평가 상태'), false);
    assert.equal(detail.payload.minutes[4].content.includes('입장한 거래'), false);
    assert.equal(detail.payload.minutes[4].content.includes('입장하지'), false);
    assert.equal(detail.payload.minutes[4].content.includes('현재 5개의 결정이 대기 중'), false);
    assert.equal(detail.payload.minutes[4].content.includes('결정 대기는 5건 남아있다'), false);
    assert.equal(detail.payload.minutes[4].content.includes('결정 대기는 5건이 대기 중'), false);
    assert.ok(detail.payload.minutes[4].content.includes('중단 제안은 한국어 라벨로 유지'));
    const catchup = await request(baseUrl, '/api/catchup/1');
    assert.equal(catchup.payload.lines.length, 3);
    assert.ok(catchup.payload.lines[0].includes('확정 0건, 보류 0건, 대기 2건'));
    assert.ok(catchup.payload.lines[1].includes('C15 레짐 엔진 HMM:'));
    assert.ok(catchup.payload.lines[1].includes('국내 장전 계획: 자문 기록 후 마스터 확인 대기'));
    assert.equal(catchup.payload.lines[1].includes('advisory 기록'), false);
    assert.equal(catchup.payload.lines[1].includes('market:crypto'), false);
    assert.equal(catchup.payload.lines[1].includes('market:domestic'), false);
    assert.equal(catchup.payload.lines[1].includes('regime-engine-hmm'), false);
    assert.ok(catchup.payload.lines[2].includes('회의록 5행'));
    assert.ok(catchup.payload.lines[2].includes('최신 상태 완료'));
    assert.equal(catchup.payload.lines[2].includes('minutes'), false);
    assert.equal(catchup.payload.lines[2].includes('최신 상태 closed'), false);

    const pending = await request(baseUrl, '/api/decisions/pending');
    assert.deepEqual(pending.payload.decisions.map((row) => row.id), [11, 12]);
    assert.ok(pending.payload.decisions[0].decision.includes('C15 레짐 엔진 HMM'));
    assert.equal(pending.payload.decisions[0].decision.includes('regime-engine-hmm'), false);

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
    assert.equal(doubleConfirm.status, 200);
    assert.equal(doubleConfirm.payload.idempotent, true);

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
    const catchupAfterDefer = await request(baseUrl, '/api/catchup/1');
    assert.ok(catchupAfterDefer.payload.lines[0].includes('확정 1건, 보류 1건, 대기 0건'));
    assert.ok(catchupAfterDefer.payload.lines[1].includes('마스터 액션 필요: 없음'));

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
    assert.equal(completedRun.sessionId, 2);
    assert.equal(runSessionOptions[0]?.noLlm, true);
    const meetingsAfterRun = await request(baseUrl, '/api/meetings');
    assert.equal(meetingsAfterRun.payload.activeRuns.length, 0);
    assert.equal(meetingsAfterRun.payload.meetings[0].id, 2);
    const completedRunDetail = await request(baseUrl, `/api/meetings/${start.payload.run.id}`);
    assert.equal(completedRunDetail.payload.run.status, 'completed');
    assert.equal(completedRunDetail.payload.run.sessionId, 2);
    const completedMeetingDetail = await request(baseUrl, '/api/meetings/2');
    assert.equal(completedMeetingDetail.payload.minutes.length, 1);
    const completedMeetingCatchup = await request(baseUrl, '/api/catchup/2');
    assert.ok(completedMeetingCatchup.payload.lines[0].includes('확정 0건, 보류 0건, 대기 0건'));

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

  const failedStore = createMemoryStore();
  const failedStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: failedStore,
    runMeetingSessionFn: async () => {
      throw new Error('fixture run failed');
    },
  });
  const failedBase = `http://127.0.0.1:${failedStarted.server.address().port}`;
  try {
    const failedStart = await request(failedBase, '/api/meetings/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ type: 'morning', noLlm: true }),
    });
    assert.equal(failedStart.status, 202);
    const failedRun = await waitForRun(failedBase, failedStart.payload.run.id, 'failed');
    assert.equal(failedRun.status, 'failed');
    assert.ok(failedRun.error.includes('fixture run failed'));
  } finally {
    await closeServer(failedStarted.server);
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
      headerStatusAndDashboardA11y: true,
      keyboardFocusVisible: true,
      mobileOneColumnContract: true,
      pendingDueOrder: true,
      startDuplicateGuard: true,
      completedRunSwitchesToSessionDetail: true,
      failedRunShowsError: true,
      confirmAuditAndIdempotency: true,
      idempotentDecisionNotice: true,
      deferAudit: true,
      deferLeavesPendingQueue: true,
      catchupConfirmedDeferredPendingCounts: true,
      catchupLinesA11y: true,
      catchupInternalTermsLocalized: true,
      askRateLimit: true,
      askSafetyNotice: true,
      askFormKoreanLabels: true,
      askInputGuidance: true,
      askClearsStaleAnswerOnSubmit: true,
      askInputClearsStaleError: true,
      askAnswerLiveRegion: true,
      askBusyStatus: true,
      askResponseMetadataLabels: true,
      pollingCadenceConfigured: true,
      pollingStatusVisible: true,
      pollingStatusKoreanLabel: true,
      tokenAuth: true,
      headerTokenA11y: true,
      tablistSemantics: true,
      tabKeyboardNavigation: true,
      tabPressedState: true,
      startMeetingA11y: true,
      startClosedSegmentUiGuard: true,
      meetingListPressedState: true,
      meetingListRegionA11y: true,
      timelineArticleA11y: true,
      timelineRoleLegend: true,
      dynamicRegionA11y: true,
      localhostBinding: true,
      staticServingAndXssBaseline: true,
      staticPathEscapeBlocked: true,
      markdownLiteBoldHeadingListTable: true,
      markdownTableMobileWrapGuard: true,
      markdownLiteNoInnerHtml: true,
      legacyRawJsonMinuteNormalized: true,
      legacyCircuitCountMasked: true,
      friendlyUiErrors: true,
      closedSegmentReasonVisible: true,
      closedSegmentReasonA11y: true,
      activeSegmentStatusKoreanLabel: true,
      segmentReasonKoreanLabel: true,
      llmToggleDefaultNoCost: true,
      llmModeLiveRegion: true,
      evidenceDisclosureKoreanLabel: true,
      evidencePreMobileOverflowGuard: true,
      collapsedEvidenceDoesNotCreateScrollSpace: true,
      decisionActionKoreanLabels: true,
      decisionControlsAccessibleNames: true,
      decisionRegionA11y: true,
      decisionStatusRawTokenHidden: true,
      serverRecoveryClearsError: true,
      authFailureClearsCachedData: true,
      dueBadges: true,
      dueBadgeA11y: true,
      adrRolePresentation: true,
      repetitiveLlmMinuteCompacted: true,
      canonicalStatusTokensPreserved: true,
      legacyEntryTradeTermNormalized: true,
      legacyHaltValuationTermNormalized: true,
      legacyPendingCountMasked: true,
      legacyAdrStatusLabelNormalized: true,
      meetingStatusKoreanLabel: true,
      internalAgendaKeysHidden: true,
      timelineSpeakerLabelsNormalized: true,
      dataMinuteMetaKeysLocalized: true,
      c15StateValuesLocalized: true,
      c15ComponentKeysLocalized: true,
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

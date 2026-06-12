#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import { _testOnly, startMeetingRoomWebServer } from '../services/meeting-room/server/index.ts';
import { loadMeetingMinutesResult, renderMeetingMinutesMarkdown } from '../services/meeting-room/server/minutes.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const MEETING_LAUNCHD_PLISTS = [
  'ai.luna.meeting-morning-0500.plist',
  'ai.luna.meeting-debrief-1600.plist',
  'ai.luna.meeting-premarket-2200.plist',
  'ai.luna.meeting-weekly-sun-0600.plist',
  'ai.luna.meeting-room-web.plist',
];

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
  return { status: res.status, ok: res.ok, payload, text, headers: res.headers };
}

function userVisibleMeetingApiText(payload = {}, extraLines = []) {
  return [
    ...(payload.minutes || []).map((row) => row.content),
    ...(payload.decisions || []).map((row) => row.decision),
    ...extraLines,
  ].filter(Boolean).join('\n');
}

function userVisibleMeetingApiBlocks(payload = {}, extraLines = []) {
  return [
    ...(payload.minutes || []).map((row) => ({
      label: `minute:${row.seq || row.id || 'unknown'}`,
      text: row.content,
    })),
    ...(payload.decisions || []).map((row) => ({
      label: `decision:${row.id || 'unknown'}`,
      text: row.decision,
    })),
    ...(extraLines.length ? [{ label: 'catchup', text: extraLines.join('\n') }] : []),
  ].filter((block) => block.text);
}

function assertNoUserVisibleRawLeaks(text, context) {
  const checks = [
    ['raw JSON object', /\{\s*"[a-zA-Z0-9_]+":/],
    ['raw JSON array', /\[\s*\{\s*"[a-zA-Z0-9_]+":/],
    ['internal status token', /\b(pending_master|c_master|changed_via|agendaKey|decision_id|due_at|provider|rule_based|noLLM route)\b/],
    ['component id', /\b(regime-engine-hmm|market-deployment-gate|meeting-room-orchestrator|backtest-nextbar-execution)\b/],
    ['DB/raw marker', /\b(jsonb|raw DB|원문 DB|DB 원문|gate_transitions=|regime_transitions=|segments:\s*\[|errors=\[)\b/],
    ['internal C15 pending prefix', /C15 결정 대기:/],
    ['legacy LLM boilerplate', /이러한 결과를 기반으로|최종 결론|최종 결정을 내릴 수 있도록/],
    ['market gate score as active segment percent', /%의 활성 세그먼트가 유지되고 있습니다/],
  ];
  for (const [label, pattern] of checks) {
    assert.equal(pattern.test(text), false, `${context} should not expose ${label}`);
  }
}

function repeatedSentenceHits(text, minCount = 3) {
  const sentences = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .match(/[^.!?。！？\n]+[.!?。！？]+|[^.!?。！？\n]+(?=\n|$)/gu) || [];
  const counts = new Map();
  for (const rawSentence of sentences) {
    const sentence = rawSentence
      .replace(/^[\s>*\-•\d.)]+/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (sentence.length < 12) continue;
    counts.set(sentence, (counts.get(sentence) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .map(([sentence, count]) => ({ sentence, count }));
}

function assertNoRepeatedSentenceRunsInBlocks(blocks, context) {
  for (const block of blocks) {
    const hits = repeatedSentenceHits(block.text);
    assert.deepEqual(hits, [], `${context} ${block.label} should not repeat the same sentence 3+ times`);
  }
}

function assertMeetingLaunchdLogPaths() {
  for (const fileName of MEETING_LAUNCHD_PLISTS) {
    const plistPath = new URL(`../launchd/${fileName}`, import.meta.url);
    const content = fs.readFileSync(plistPath, 'utf8');
    assert.equal(content.includes('/tmp/logs/luna-meeting'), false, `${fileName} should not use volatile nested /tmp meeting logs`);
    assert.ok(content.includes('/Users/alexlee/.ai-agent-system/logs/luna-meeting'), `${fileName} should use persistent meeting logs`);
  }
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
      segments: [
        { market: 'domestic', label: '국내 장전 계획', active: false, skipped: true, reason: 'weekend' },
        { market: 'crypto', label: 'crypto 24h 점검', active: true, skipped: false, reason: 'crypto_24h' },
      ],
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
        '활성 서킷 [',
        '  {"market":"crypto","symbol":"RENDER/USDT","circuit":"low_profit_symbol","reason":"cumulative_r_below_zero"},',
        '  {"market":"crypto","symbol":"SOL/USDT","circuit":"symbol_cooldown","reason":"cooldown"}',
        ']',
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
        'C15 결정 대기: mapek: advisory 기록 후 마스터 확인 대기',
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
        '근거: plan-note와 shadow stack.',
        '최신 gate/regime/signal/circuit이 반대로 바뀌면 무효다.',
        '동유형 ADR/registry evidence를 확인해야 한다.',
        'cost_guard_skipped: max calls 6 reached',
        'crypto 시장은 현재 하락세에 있다.',
        '현재는 입장한 거래가 없습니다.',
        '* 전략군은 현재 입장하지 않았으며, 전략군의 입장을 고려할 필요가 있습니다.',
        '* 결정 대기는 5건 남아있다.',
        '5. 결정 대기는 5건이 대기 중입니다.',
        'C2 레짐 : 국내, 미국, 암호화폐 세그먼트의 레짐은 각각 bull(0.41), sideways(0.47), bear(0.74) 상태입니다.',
        '레짐은 국내 bull, 미국 sideways, 암호화폐 bear 상태입니다.',
        '회의 데이터 요약를 기준으로 미국가 수평 상태입니다.',
        '비교 기준=gate_off_virtual',
        'halt_reduced_avoidance_delta: 비교 데이터가 없습니다.',
        '[aria] C15 결정 대기 점검',
        '생성일: 2026-06-11T14:43:59.419Z',
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
    { id: 11, sessionId: 1, agendaKey: 'decision:regime-engine-hmm', decision: 'C15 결정 대기: C15 레짐 엔진 HMM: advisory 기록 후 마스터 확인 대기', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-12T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:02.000Z' },
    { id: 12, sessionId: 1, agendaKey: 'market:domestic', decision: 'advisory 기록 후 마스터 확인 대기', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-13T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:03.000Z' },
  ];
  let nextSessionId = 2;
  let nextMinuteId = 6;

  return {
    listMeetings: async () => sessions.slice().sort((a, b) => b.id - a.id),
    getMeeting: async (id) => {
      const session = sessions.find((row) => String(row.id) === String(id));
      if (!session) throw Object.assign(new Error(`회의 ${id}를 찾을 수 없습니다.`), { statusCode: 404, code: 'meeting_not_found' });
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
        content: `결정 ${action === 'defer' ? '보류' : '확정'} 처리 · 경로=웹 · ${note ? `메모=${note}` : '메모 없음'}`,
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
  assertMeetingLaunchdLogPaths();
  const store = createMemoryStore();
  const runSessionOptions = [];
  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const deps = {
    meetingStore: store,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# fixture plan-note\n- 자문 전용',
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
    resolveAgentLLMRouteFn: (agent) => (agent === 'aria'
      ? { primary: 'investment.aria', selectorKey: 'investment.aria', fallbacks: [], noLLM: true }
      : { provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => ({
      ok: true,
      provider: 'fixture',
      text: '#### fixture answer\n- **bold** answer\n| k | v |\n|---|---|\n| ok | true |\n회의 plan-note 기준 세그먼트는 domestic과 overseas는 활성이고 crypto는 대기입니다. 게이트가 정지 상태이고 게이트가 감소한 상태입니다. 감소한 상태로 reduced 표시도 있습니다. 국내(33%), 미국(47%), 암호화폐(61%) 시장은 각각 중단, 감소, reduced 상태이며, 미국는 수평 상태입니다. 국내는 진행이 중단된 상태입니다. 국내는 중단 상태, 미국은 reduced 상태, 암호화폐는 최대 상태입니다. 암호화폐는 완전한 상태입니다.',
    }),
  };

  const started = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, deps);
  const address = started.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.equal(address.address, '127.0.0.1');

  try {
    const health = await request(baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.shadowOnly, true);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.ok(health.headers.get('permissions-policy')?.includes('camera=()'));
    assert.ok(health.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));

    const html = await request(baseUrl, '/');
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(html.headers.get('x-frame-options'), 'DENY');
    assert.ok(html.headers.get('permissions-policy')?.includes('camera=()'));
    assert.ok(html.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.ok(html.text.includes('Luna Meeting Room'));
    assert.ok(html.text.includes(':focus-visible'));
    assert.ok(html.text.includes('outline-offset: 3px'));
    assert.ok(html.text.includes('.due.overdue'));
    assert.ok(html.text.includes('.minute.adr'));
    assert.ok(html.text.includes('.role-legend'));
    assert.ok(html.text.includes('.role-dot.data'));
    assert.ok(html.text.includes('.schedule-status'));
    assert.ok(html.text.includes('rgba(54, 95, 122, 0.08)'));
    assert.equal(html.text.includes('.pill-inline-separator'), false);
    assert.ok(html.text.includes('.token-box { min-width: 260px; }'));
    assert.ok(html.text.includes('.token-box { min-width: 0; width: 100%; max-width: 100%; }'));
    assert.ok(html.text.includes('overflow-x: auto'));
    assert.ok(html.text.includes('table-layout: fixed'));
    assert.ok(html.text.includes('overflow-wrap: anywhere'));
    const appJs = await request(baseUrl, '/app.js');
    assert.equal(appJs.status, 200);
    assert.equal(appJs.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(appJs.headers.get('cache-control'), 'no-store');
    assert.equal(appJs.text.includes('dangerouslySetInnerHTML'), false);
    assert.equal(appJs.text.includes('innerHTML'), false);
    assert.ok(appJs.text.includes('const { useEffect, useMemo, useRef, useState } = React;'));
    assert.ok(appJs.text.includes("const SELECTED_MEETING_STORAGE_KEY = 'lunaMeetingRoomSelectedMeetingId';"));
    assert.ok(appJs.text.includes('selectedMeetingId: requestSelectedMeetingId'));
    assert.ok(appJs.text.includes('const [scheduleStatus, setScheduleStatus] = useState'));
    assert.ok(appJs.text.includes('setScheduleStatus(String(list.scheduleStatus ||'));
    assert.ok(appJs.text.includes('className="schedule-status" role="status"'));
    assert.ok(appJs.text.includes('aria-label=${scheduleStatus}'));
    assert.ok(appJs.text.includes('function renderMarkdownLite'));
    assert.ok(appJs.text.includes('function MarkdownLite'));
    assert.ok(appJs.text.includes("function pushBlock(node)"));
    assert.ok(appJs.text.includes("blocks.push(node, '\\n');"));
    assert.ok(appJs.text.includes("items.push(html`<li key=${itemKey}>${renderInlineMarkdown(lines[index].slice(2), itemKey)}</li>`, '\\n');"));
    assert.ok(appJs.text.includes('renderInlineMarkdown'));
    assert.ok(appJs.text.includes('markdown-table'));
    assert.ok(appJs.text.includes('className="topline" role="status" aria-label="회의실 실행 상태: MR-B, 자문 및 섀도 전용, 로컬 바인딩 127.0.0.1 포트 7791"'));
    assert.ok(appJs.text.includes('aria-label="자문 및 섀도 전용"'));
    assert.ok(appJs.text.includes('자문 / 섀도 전용'));
    const meetingSessionSource = fs.readFileSync(new URL('../services/meeting-room/server/orchestrator/meeting-session.ts', import.meta.url), 'utf8');
    assert.ok(meetingSessionSource.includes('function deterministicAnalysis'));
    assert.ok(meetingSessionSource.includes("'회의 데이터만 근거로 작성한 자문입니다.'"));
    assert.equal(meetingSessionSource.includes("return [\n    agenda.title,\n    '회의 데이터만 근거로 작성한 자문입니다.'"), false);
    assert.ok(meetingSessionSource.includes('function meetingTypeLabel'));
    assert.ok(meetingSessionSource.includes('`${meetingTypeLabel(type)} 완료: 안건 ${agendas.length}건'));
    assert.equal(meetingSessionSource.includes('`${type} 회의 완료: 안건 ${agendas.length}건'), false);
    assert.ok(appJs.text.includes("MR-B ·${' '}"));
    assert.ok(appJs.text.includes("자문 / 섀도 전용 ·${' '}"));
    assert.ok(appJs.text.includes(`<h1>Luna Meeting Room</h1>
        \${'\\n'}
        <p>회의록, 결정 대기함, 에이전트 질의를 한 화면에서 다룹니다.`));
    assert.equal(appJs.text.includes('className="pill-separator"'), false);
    assert.equal(appJs.text.includes('pill-inline-separator'), false);
    assert.ok(appJs.text.includes('className="token-box"'));
    assert.equal(appJs.text.includes("minWidth: '260px'"), false);
    assert.equal(appJs.text.includes('advisory / shadow only'), false);
    assert.ok(appJs.text.includes("Number.isNaN(date.getTime())"));
    assert.ok(appJs.text.includes("'시간 확인 필요'"));
    assert.equal(appJs.text.includes("return String(value);"), false);
    assert.ok(appJs.text.includes('aria-label="로컬 바인딩 127.0.0.1 포트 7791"'));
    assert.ok(html.text.includes('.dashboard-link'));
    assert.ok(html.text.includes('text-transform: none;'));
    assert.ok(html.text.includes('letter-spacing: normal;'));
    assert.ok(appJs.text.includes('className="pill dashboard-link"'));
    assert.ok(appJs.text.includes('aria-label="TeamJay Dashboard 7787 새 창으로 열기"'));
    assert.ok(appJs.text.includes('target="_blank"'));
    assert.ok(appJs.text.includes('rel="noopener noreferrer"'));
    assert.equal(appJs.text.includes('rel="noreferrer"'), false);
    assert.ok(appJs.text.includes("const TOKEN_STORAGE_KEY = 'lunaMeetingRoomToken';"));
    assert.ok(appJs.text.includes('function readLocalValue(key, fallback ='));
    assert.ok(appJs.text.includes('function writeLocalValue(key, value)'));
    assert.ok(appJs.text.includes("useState(() => readLocalValue(TOKEN_STORAGE_KEY, ''))"));
    assert.ok(appJs.text.includes('writeLocalValue(TOKEN_STORAGE_KEY, value);'));
    assert.equal(appJs.text.includes("localStorage.getItem('lunaMeetingRoomToken')"), false);
    assert.equal(appJs.text.includes("localStorage.setItem('lunaMeetingRoomToken', value)"), false);
    assert.ok(appJs.text.includes('htmlFor="meeting-room-token">접근 토큰'));
    assert.ok(appJs.text.includes(`<label className="meta" htmlFor="meeting-room-token">접근 토큰</label>
        \${'\\n'}`));
    assert.ok(appJs.text.includes('type="password"'));
    assert.ok(appJs.text.includes('autoComplete="off"'));
    assert.ok(appJs.text.includes('aria-describedby="meeting-room-token-help"'));
    assert.ok(appJs.text.includes(`<div id="meeting-room-token-help" className="meta">MEETING_ROOM_TOKEN 설정 시 입력 · 로컬 무인증이면 비워둠</div>
      </div>
    </div>
    \${'\\n'}`));
    assert.ok(appJs.text.includes('id="meeting-room-token-help"'));
    assert.ok(appJs.text.includes('MEETING_ROOM_TOKEN 설정 시 입력 · 로컬 무인증이면 비워둠'));
    assert.equal(appJs.text.includes('aria-label="회의실 접근 토큰"'), false);
    assert.ok(appJs.text.includes('className="tabs"'));
    assert.ok(appJs.text.includes('className="tab-switcher" role="tablist" aria-label="회의실 화면 전환"'));
    assert.ok(appJs.text.includes('id="meeting-tab-daily"'));
    assert.ok(appJs.text.includes('id="meeting-tab-ask"'));
    assert.ok(appJs.text.includes('role="tab"'));
    assert.ok(appJs.text.includes("aria-selected=${tab === 'daily'}"));
    assert.ok(appJs.text.includes("aria-selected=${tab === 'ask'}"));
    assert.ok(appJs.text.includes(`>일일 회의실</button>
        \${'\\n'}
        <button
          id="meeting-tab-ask"`));
    assert.ok(appJs.text.includes(`<div className="tab-switcher" role="tablist" aria-label="회의실 화면 전환">`));
    assert.ok(appJs.text.includes('<${Header} token=${token} setToken=${setToken} tab=${tab} setTab=${setTab} />'));
    assert.ok(appJs.text.includes(`\${'\\n'}
      <section
        id="meeting-panel-daily"`));
    assert.ok(appJs.text.includes(`</section>
      \${'\\n'}
      <section
        id="meeting-panel-ask"`));
    assert.ok(appJs.text.includes('aria-controls="meeting-panel-daily"'));
    assert.ok(appJs.text.includes('aria-controls="meeting-panel-ask"'));
    assert.ok(appJs.text.includes('role="tabpanel"'));
    assert.ok(appJs.text.includes('id="meeting-panel-daily"'));
    assert.ok(appJs.text.includes('aria-labelledby="meeting-tab-daily"'));
    assert.ok(appJs.text.includes("hidden=${tab !== 'daily'}"));
    assert.ok(appJs.text.includes('id="meeting-panel-ask"'));
    assert.ok(appJs.text.includes('aria-labelledby="meeting-tab-ask"'));
    assert.ok(appJs.text.includes("hidden=${tab !== 'ask'}"));
    assert.ok(appJs.text.includes('<${AskRoom} token=${token} />'));
    assert.equal(appJs.text.includes("tab === 'ask' ? html`<${AskRoom} token=${token} />` : null"), false);
    assert.equal(appJs.text.includes("id=${tab === 'daily' ? 'meeting-panel-daily' : 'meeting-panel-ask'}"), false);
    assert.ok(appJs.text.includes('function handleTabKeyDown'));
    assert.ok(appJs.text.includes('ArrowRight'));
    assert.ok(appJs.text.includes('ArrowLeft'));
    assert.ok(appJs.text.includes("Home: 'daily'"));
    assert.ok(appJs.text.includes("End: 'ask'"));
    assert.ok(appJs.text.includes("tabIndex=${tab === 'daily' ? 0 : -1}"));
    assert.ok(appJs.text.includes("tabIndex=${tab === 'ask' ? 0 : -1}"));
    assert.ok(html.text.includes('.tab-switcher'));
    assert.equal(appJs.text.includes("aria-pressed=${tab === 'daily'}"), false);
    assert.equal(appJs.text.includes("aria-pressed=${tab === 'ask'}"), false);
    assert.ok(appJs.text.includes('function meetingStatusLabel'));
    assert.ok(appJs.text.includes('function meetingTypeLabel'));
    assert.ok(appJs.text.includes('function agendaLabel'));
    assert.ok(appJs.text.includes('function speakerLabel'));
    assert.ok(appJs.text.includes('function roleName'));
    assert.ok(appJs.text.includes("|| '역할 미상';"));
    assert.equal(appJs.text.includes("|| role;"), false);
    assert.ok(appJs.text.includes('function minuteRoleClass'));
    assert.ok(appJs.text.includes("['data', 'analysis', 'grill', 'decision', 'system'].includes(value) ? value : 'system'"));
    assert.ok(appJs.text.includes("adhoc: '임시 회의'"));
    assert.ok(appJs.text.includes("ad_hoc: '임시 회의'"));
    assert.ok(appJs.text.includes("|| '상태 미상';"));
    assert.equal(appJs.text.includes("|| status || '상태 미상'"), false);
    assert.ok(appJs.text.includes("|| '회의';"));
    assert.equal(appJs.text.includes("|| type || '회의'"), false);
    assert.equal(
      _testOnly.normalizeSession({
        id: 143,
        type: 'us_premarket',
        status: 'closed',
        summary: 'us_premarket 회의 완료: 안건 2건, ADR 2건, LLM 2회',
      }).summary,
      '미장 전 회의 완료: 안건 2건, ADR 2건, LLM 2회',
    );
    assert.equal(
      _testOnly.normalizeSession({
        id: 117,
        type: 'domestic_debrief',
        status: 'closed',
        summary: 'domestic_debrief 회의 완료: 안건 1건, ADR 1건, LLM 0회',
      }).summary,
      '국내 장후 회의 완료: 안건 1건, ADR 1건, LLM 0회',
    );
    assert.ok(appJs.text.includes("|| '안건';"));
    assert.equal(appJs.text.includes("|| key || '안건'"), false);
    assert.ok(appJs.text.includes("|| '에이전트 미상';"));
    assert.equal(appJs.text.includes("|| agent || '에이전트'"), false);
    assert.ok(appJs.text.includes("'market:crypto': '암호화폐 24시간 점검'"));
    assert.ok(appJs.text.includes("'debrief:g6-plan-vs-actual': '국내 마감 G6 대조표'"));
    assert.ok(appJs.text.includes("'premarket:overseas-gate-regime': '미장 전 게이트·레짐 점검'"));
    assert.ok(appJs.text.includes("'premarket:overseas-watch': '미장 전 감시 목록 점검'"));
    assert.ok(appJs.text.includes("'weekly:shadow-stack-review': '주간 섀도 스택 리뷰'"));
    assert.equal(appJs.text.includes("'market:crypto': 'crypto 24h 점검'"), false);
    assert.ok(appJs.text.includes("crypto: '암호화폐'"));
    assert.ok(appJs.text.includes("|| '시장 미상';"));
    assert.equal(appJs.text.includes("crypto: 'crypto'"), false);
    assert.equal(appJs.text.includes("|| market || 'unknown'"), false);
    assert.ok(appJs.text.includes('aria-label=${`회의 #${meeting.id} ${meetingTypeLabel(meeting.type)} ${meetingStatusLabel(meeting.status)} 선택`}'));
    assert.ok(appJs.text.includes('aria-label=${`실행 중 회의 ${meetingTypeLabel(run.type)} ${meetingStatusLabel(run.status)} 선택`}'));
    assert.ok(appJs.text.includes('title=${`회의 타입: ${meetingTypeLabel(meeting.type)}`'));
    assert.ok(appJs.text.includes('title=${`상태: ${meetingStatusLabel(meeting.status)}`'));
    assert.ok(appJs.text.includes('data-raw-type=${meeting.type ||'));
    assert.ok(appJs.text.includes('data-raw-status=${meeting.status ||'));
    assert.ok(appJs.text.includes('title=${`안건: ${agendaLabel(minute.agendaKey ||'));
    assert.ok(appJs.text.includes('title=${`결정 #${decision.id} · 안건: ${agendaLabel(decision.agendaKey)}`'));
    assert.ok(appJs.text.includes('data-raw-agenda=${minute.agendaKey ||'));
    assert.ok(appJs.text.includes('data-raw-agenda=${decision.agendaKey ||'));
    assert.equal(appJs.text.includes('title=${`원문 안건:'), false);
    assert.equal(appJs.text.includes('title=${`원문 타입:'), false);
    assert.ok(appJs.text.includes('role="region" aria-label="회의 목록"'));
    assert.ok(appJs.text.includes('role="list" aria-live="polite" aria-label=${`회의 목록 ${totalCount}건`}'));
    assert.ok(appJs.text.includes('className="meeting-list-row" role="listitem"'));
    assert.ok(appJs.text.includes('function safeArray(value)'));
    assert.ok(appJs.text.includes('return Array.isArray(value) ? value : [];'));
    assert.ok(appJs.text.includes('const meetingRows = safeArray(meetings);'));
    assert.ok(appJs.text.includes('const activeRunRows = safeArray(activeRuns);'));
    assert.ok(appJs.text.includes('const totalCount = meetingRows.length + activeRunRows.length;'));
    assert.ok(appJs.text.includes('String(selectedId) === String(run.id)'));
    assert.ok(appJs.text.includes('activeRuns.map((run) => `${run.id}:${run.status}`).join(\',\')'));
    assert.equal(appJs.text.includes('selectedId === run.id'), false);
    assert.equal(appJs.text.includes('run.id + run.status'), false);
    assert.ok(appJs.text.includes('htmlFor="meeting-type-select">회의 타입'));
    assert.ok(appJs.text.includes('title="시작할 회의 타입"'));
    assert.equal(appJs.text.includes('aria-label="시작할 회의 타입"'), false);
    assert.ok(appJs.text.includes('aria-describedby="meeting-manual-start-note meeting-segment-status"'));
    assert.ok(appJs.text.includes('id="meeting-segment-status"'));
    assert.ok(appJs.text.includes('id="meeting-manual-start-note"'));
    assert.ok(appJs.text.includes('className="manual-start-note" role="note"'));
    assert.ok(appJs.text.includes('수동 시작은 정례 05:00 실행이 아니라 현재 화면의 세그먼트 상태 기준'));
    assert.ok(appJs.text.includes('회의록과 ADR만 새로 남깁니다.'));
    assert.equal(appJs.text.includes('aria-describedby="meeting-segment-status" value=${type}'), false);
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label="시장 세그먼트 상태"'));
    assert.ok(appJs.text.includes('비활성, 사유'));
    assert.ok(appJs.text.includes('자문/섀도 회의로 시작합니다.'));
    assert.equal(appJs.text.includes('advisory/shadow 회의로 시작합니다.'), false);
    assert.ok(appJs.text.includes('selectedTypeDisabled'));
    assert.ok(appJs.text.includes('const segmentsReady = safeArray(segments).length > 0;'));
    assert.ok(appJs.text.includes('const startBlocked = !segmentsReady || selectedTypeDisabled;'));
    assert.ok(appJs.text.includes("? '세그먼트 상태 확인 중'"));
    assert.ok(appJs.text.includes('startDisabled'));
    assert.ok(appJs.text.includes('const startInFlightRef = useRef(false);'));
    assert.ok(appJs.text.includes('if (startInFlightRef.current || startBlocked) return;'));
    assert.equal(appJs.text.includes('if (startInFlightRef.current || selectedTypeDisabled) return;'), false);
    assert.ok(appJs.text.includes('startInFlightRef.current = true;'));
    assert.ok(appJs.text.includes('startInFlightRef.current = false;'));
    assert.ok(appJs.text.includes('MEETING_START_MALFORMED_MESSAGE'));
    assert.ok(appJs.text.includes('회의 시작 응답이 올바르지 않습니다. 잠시 후 다시 시도하세요.'));
    assert.ok(appJs.text.includes('if (payload?.run?.id == null) throw new Error(MEETING_START_MALFORMED_MESSAGE);'));
    assert.ok(appJs.text.includes('const startButtonLabel = startBlocked'));
    assert.ok(appJs.text.includes('? `${selectedType?.label || type} 시작 중`'));
    assert.ok(appJs.text.includes('aria-label=${startButtonLabel}'));
    assert.ok(appJs.text.includes('aria-busy=${busy}'));
    assert.ok(appJs.text.includes('선택한 회의 타입은 현재 시작할 수 없습니다'));
    assert.equal(appJs.text.includes('선택한 회의 타입은 현재 비활성입니다'), false);
    assert.ok(appJs.text.includes('시작 불가, 사유'));
    assert.ok(appJs.text.includes('id="meeting-llm-toggle"'));
    assert.ok(appJs.text.includes('aria-describedby="meeting-llm-mode"'));
    assert.ok(appJs.text.includes('id="meeting-llm-mode"'));
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label="LLM 발언 모드"'));
    assert.ok(appJs.text.includes('role="region" aria-label="회의 타임라인"'));
    assert.ok(appJs.text.includes('role="list" aria-label="타임라인 역할 색상 범례"'));
    assert.ok(appJs.text.includes('aria-label=${`${label} 역할 색상`}'));
    assert.ok(appJs.text.includes('aria-label=${`${minute.seq}번 회의록 · ${agendaLabel(minute.agendaKey ||'));
    assert.ok(appJs.text.includes("${'\\n'}\n              <div className=\"meta\">${formatTime(minute.createdAt)}</div>"));
    assert.ok(appJs.text.includes("<div className=\"meta\">${formatTime(minute.createdAt)}</div>\n              ${'\\n'}"));
    assert.ok(appJs.text.includes('<div className="meta">${formatTime(minute.createdAt)}</div>'));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${minute.content} />'));
    assert.ok(appJs.text.includes('선택된 회의의 회의록이 없습니다.'));
    assert.equal(appJs.text.includes('선택된 회의의 minute가 없습니다.'), false);
    assert.ok(appJs.text.includes('speakerLabel(minute.speaker)}'));
    assert.ok(appJs.text.includes('}[value] || agentLabel(speaker);'));
    assert.ok(appJs.text.includes('data-raw-speaker=${minute.speaker ||'));
    assert.ok(appJs.text.includes("'stack-adapter': '데이터 어댑터'"));
    assert.ok(appJs.text.includes("adr: 'ADR 기록기'"));
    assert.ok(appJs.text.includes('const catchupLines = loading'));
    assert.ok(appJs.text.includes('const minutes = safeArray(detail?.minutes);'));
    assert.ok(appJs.text.includes('const catchupList = safeArray(catchup);'));
    assert.ok(appJs.text.includes("catchupList.length ? catchupList : ['회의를 선택하면 U1 캐치업이 표시됩니다.']"));
    assert.ok(appJs.text.includes("const catchupLabel = `U1 캐치업 요약: ${catchupLines.join(' / ')}`"));
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label=${catchupLabel}'));
    assert.ok(appJs.text.includes('role="list" aria-label=${`U1 캐치업 ${catchupLines.length}줄 요약`}'));
    assert.ok(appJs.text.includes('className="catchup-line" role="listitem"'));
    assert.ok(appJs.text.includes('<div className="catchup-line" role="listitem">${line}</div>${'));
    assert.ok(appJs.text.includes('<div className="meeting-title" title=${`회의 타입: ${meetingTypeLabel(meeting.type)}`'));
    assert.ok(appJs.text.includes('<div className="meeting-title" title=${`회의 타입: ${meetingTypeLabel(run.type)} · 상태: ${meetingStatusLabel(run.status)}`'));
    assert.ok(appJs.text.includes('className="error" role="alert" aria-live="assertive"'));
    assert.ok(appJs.text.includes('className="notice" role="status" aria-live="polite"'));
    assert.ok(appJs.text.includes('회의 상세를 불러오는 중입니다.'));
    assert.ok(appJs.text.includes('이미 진행 중인 같은 타입 회의가 있습니다'));
    assert.ok(appJs.text.includes('이미 처리된 결정입니다. 최신 상태로 갱신했습니다.'));
    assert.ok(appJs.text.includes('분당 질의 한도에 도달했습니다'));
    assert.ok(appJs.text.includes('질문을 입력하세요.'));
    assert.ok(appJs.text.includes('지원하지 않는 결정 처리 요청입니다.'));
    assert.ok(appJs.text.includes('지원하지 않는 요청 방식입니다.'));
    assert.ok(appJs.text.includes('회의를 찾을 수 없습니다. 목록을 새로고침하세요.'));
    assert.ok(appJs.text.includes('요청한 회의실 리소스를 찾을 수 없습니다.'));
    assert.ok(appJs.text.includes('invalid_agent:'));
    assert.ok(appJs.text.includes('지원하지 않는 에이전트입니다. 목록에서 에이전트를 선택하세요.'));
    assert.ok(appJs.text.includes('회의실 서버에 연결할 수 없습니다'));
    assert.ok(appJs.text.includes("setError('');"));
    assert.ok(appJs.text.includes("payload.run.status === 'completed'"));
    assert.equal(appJs.text.includes('await refreshSelected(payload.run.sessionId)'), false);
    assert.equal(appJs.text.includes('await refreshSelected(nextId)'), false);
    assert.ok(appJs.text.includes('async function refreshBase(options = {})'));
    assert.ok(appJs.text.includes('const selectDefault = options.selectDefault === true;'));
    assert.ok(appJs.text.includes('if ((selectDefault || !selectedId) && (list.activeRuns?.[0] || list.meetings?.[0]))'));
    assert.ok(appJs.text.includes('function clearDailyRoomData'));
    assert.ok(appJs.text.includes('clearDailyRoomData();'));
    assert.ok(appJs.text.includes('refreshBase({ selectDefault: true }).catch((error) => setError(error.message));'));
    assert.ok(appJs.text.includes('function handleMeetingStarted(run)'));
    assert.ok(appJs.text.includes('if (run?.id == null)'));
    assert.ok(appJs.text.includes('setError(MEETING_START_MALFORMED_MESSAGE);'));
    assert.ok(appJs.text.includes('onStarted=${handleMeetingStarted}'));
    assert.ok(appJs.text.includes('function refreshAfterDecisionUpdate()'));
    assert.ok(appJs.text.includes('onUpdated=${refreshAfterDecisionUpdate}'));
    assert.equal(appJs.text.includes('onStarted=${(run) => { setSelectedId(run.id); refreshBase(); }}'), false);
    assert.equal(appJs.text.includes('onUpdated=${() => { refreshBase(); refreshSelected(); }}'), false);
    assert.ok(appJs.text.includes('if (!selectedId) return;'));
    assert.ok(appJs.text.includes('}, [selectedId]);'));
    assert.equal(appJs.text.includes('}, [selectedId, token]);'), false);
    assert.ok(appJs.text.includes('setDetailLoading(false);'));
    assert.ok(appJs.text.includes("setNotice('');"));
    assert.ok(appJs.text.includes('const baseRequestSeq = useRef(0);'));
    assert.ok(appJs.text.includes('const detailRequestSeq = useRef(0);'));
    assert.ok(appJs.text.includes('if (baseRequestSeq.current !== requestId) return;'));
    assert.ok(appJs.text.includes('if (detailRequestSeq.current !== requestId) return;'));
    assert.ok(appJs.text.includes('const catchupPayload = await api(token, `/api/catchup/${id}`);\n      if (detailRequestSeq.current !== requestId) return;\n      setDetail(payload);'));
    assert.ok(appJs.text.includes('if (detailRequestSeq.current === requestId) setDetailLoading(false);'));
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
    assert.ok(appJs.text.includes('minuteRoleClass(minute)'));
    assert.ok(appJs.text.includes('function SegmentStatus'));
    assert.ok(appJs.text.includes('function segmentReasonLabel'));
    assert.ok(appJs.text.includes('function marketHoursStateLabel'));
    assert.ok(appJs.text.includes("const value = String(reason || '');"));
    assert.ok(appJs.text.includes("if (!value) return '사유 없음';"));
    assert.ok(appJs.text.includes("weekend: '주말'"));
    assert.ok(appJs.text.includes("kis_market_closed: '장 마감'"));
    assert.ok(appJs.text.includes("crypto_24h: '24시간 운영'"));
    assert.ok(appJs.text.includes("}[value] || '사유 확인 필요';"));
    assert.equal(appJs.text.includes("} || reason || '사유 없음';"), false);
    assert.ok(appJs.text.includes('function segmentStatusText(segment = {})'));
    assert.ok(appJs.text.includes('function segmentStatusVisibleText(segment = {})'));
    assert.ok(appJs.text.includes("const summary = segmentRows.map(segmentStatusText).join(' / ');"));
    assert.ok(appJs.text.includes("const pills = segmentRows.flatMap((segment, index) => ["));
    assert.ok(appJs.text.includes("aria-label=${`시장 세그먼트 상태: ${summary}`}"));
    assert.ok(appJs.text.includes('const segmentRows = safeArray(segments);'));
    assert.ok(appJs.text.includes("index < segmentRows.length - 1 ? '\\n' : ''"));
    assert.ok(appJs.text.includes('reasonLabel'));
    assert.ok(appJs.text.includes('segment-pill'));
    assert.ok(appJs.text.includes('세그먼트 상태 로딩 중'));
    assert.ok(appJs.text.includes("state === 'open'"));
    assert.ok(appJs.text.includes("'장중'"));
    assert.ok(appJs.text.includes("'장 마감'"));
    assert.ok(appJs.text.includes("'개장 전'"));
    assert.ok(appJs.text.includes("'24시간 운영'"));
    assert.ok(appJs.text.includes('`${marketLabel(segment.market)} 회의 대상, 시장 상태 ${marketHoursStateLabel(segment)}`'));
    assert.ok(appJs.text.includes('`회의 대상(${marketHoursStateLabel(segment)})`'));
    assert.equal(appJs.text.includes('`${marketLabel(segment.market)} 활성`'), false);
    assert.equal(appJs.text.includes(": '활성'"), false);
    assert.equal(appJs.text.includes('`${marketLabel(segment.market)} active`'), false);
    assert.ok(appJs.text.includes('결정론 발언 · LLM 비용 0'));
    assert.ok(appJs.text.includes('LLM 발언 사용 · 비용 가드 적용'));
    assert.ok(appJs.text.includes('근거 JSON 보기'));
    assert.ok(appJs.text.includes('C 마스터 확인'));
    assert.ok(appJs.text.includes('마스터 액션 대기'));
    assert.ok(appJs.text.includes('title=${`등급: ${decisionGradeLabel(decision.grade)}`'));
    assert.ok(appJs.text.includes('title=${`상태: ${decisionStatusLabel(decision.status)}`'));
    assert.ok(appJs.text.includes('data-raw-grade=${decision.grade ||'));
    assert.ok(appJs.text.includes('role="group"'));
    assert.ok(appJs.text.includes('aria-label=${`결정 #${decision.id} 상태 요약: 등급 ${decisionGradeLabel(decision.grade)} · 상태 ${decisionStatusLabel(decision.status)} · 기한 ${due.label}`}'));
    assert.ok(appJs.text.includes('<span aria-hidden="true"> · </span>'));
    assert.equal(appJs.text.includes('title=${`원문 등급:'), false);
    assert.equal(appJs.text.includes('title=${`원문 상태:'), false);
    assert.ok(appJs.text.includes('const decisionRows = safeArray(decisions);'));
    assert.ok(appJs.text.includes('전체 결정 대기함'));
    assert.ok(appJs.text.includes('전체 회의 기준 · 선택 회의 캐치업과 별도'));
    assert.ok(appJs.text.includes(`<h2>전체 결정 대기함</h2>
      \${'\\n'}`));
    assert.ok(appJs.text.includes(`<div id="decision-scope-note" className="meta">전체 회의 기준 · 선택 회의 캐치업과 별도</div>
      \${'\\n'}`));
    assert.ok(appJs.text.includes('role="region" aria-label="전체 회의 결정 대기함"'));
    assert.ok(appJs.text.includes('aria-describedby="decision-scope-note"'));
    assert.ok(appJs.text.includes('전체 회의 기준 마스터 액션 대기 결정 ${decisionRows.length}건'));
    assert.ok(appJs.text.includes('전체 회의 기준 마스터 액션 대기 결정 없음'));
    assert.ok(appJs.text.includes('decisionRows.flatMap((decision, index)'));
    assert.ok(appJs.text.includes("index < decisionRows.length - 1 ? '\\n' : ''"));
    assert.equal(appJs.text.includes('role="region" aria-label="결정 대기함"'), false);
    assert.equal(appJs.text.includes('pending_master 결정 ${decisions.length}건'), false);
    assert.ok(appJs.text.includes('감사 메모'));
    assert.ok(appJs.text.includes('const actionInFlightRef = useRef(false);'));
    assert.ok(appJs.text.includes('if (actionInFlightRef.current) return;'));
    assert.ok(appJs.text.includes('actionInFlightRef.current = true;'));
    assert.ok(appJs.text.includes('actionInFlightRef.current = false;'));
    assert.ok(appJs.text.includes("busy === 'confirm' ? '확정 중' : '확정'"));
    assert.ok(appJs.text.includes("busy === 'defer' ? '보류 중' : '보류'"));
    assert.ok(appJs.text.includes('결정 #${decision.id} 확정'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 보류'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 확정 처리 중'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 보류 처리 중'));
    assert.ok(appJs.text.includes("aria-busy=${busy === 'confirm'}"));
    assert.ok(appJs.text.includes("aria-busy=${busy === 'defer'}"));
    assert.ok(appJs.text.includes('결정 #${decision.id} 감사 메모'));
    assert.ok(appJs.text.includes('결정 #${decision.id} 근거 JSON 보기'));
    assert.ok(appJs.text.includes('title=${`결정 #${decision.id} · 안건: ${agendaLabel(decision.agendaKey)}`'));
    assert.ok(appJs.text.includes('>결정 #${decision.id} · ${agendaLabel(decision.agendaKey)}</div>'));
    assert.equal(appJs.text.includes('>#${decision.id} · ${agendaLabel(decision.agendaKey)}</div>'), false);
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${decision.decision} />'));
    assert.ok(appJs.text.includes('<${EvidenceDetails} decision=${decision} />'));
    assert.ok(appJs.text.includes(`<button aria-label=\${busy === 'confirm' ? \`결정 #\${decision.id} 확정 처리 중\` : \`결정 #\${decision.id} 확정\`} aria-busy=\${busy === 'confirm'} onClick=\${() => act('confirm')} disabled=\${Boolean(busy)}>\${busy === 'confirm' ? '확정 중' : '확정'}</button>
          \${'\\n'}
          <button aria-label=\${busy === 'defer' ? \`결정 #\${decision.id} 보류 처리 중\` : \`결정 #\${decision.id} 보류\`}`));
    assert.ok(appJs.text.includes('role="listitem"'));
    assert.ok(appJs.text.includes('aria-label=${`결정 #${decision.id} · ${agendaLabel(decision.agendaKey)}'));
    assert.ok(appJs.text.includes('role="list" aria-live="polite" aria-describedby="decision-scope-note" aria-label=${`전체 회의 기준 마스터 액션 대기 결정 ${decisionRows.length}건`}'));
    assert.ok(appJs.text.includes('setMeetings(safeArray(list.meetings));'));
    assert.ok(appJs.text.includes('setActiveRuns(safeArray(list.activeRuns));'));
    assert.ok(appJs.text.includes('setSegments(safeArray(list.segments));'));
    assert.ok(appJs.text.includes('setPending(safeArray(pendingPayload.decisions));'));
    assert.ok(appJs.text.includes('자문 전용 · LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도'));
    assert.ok(appJs.text.includes('htmlFor="meeting-agent-select">에이전트'));
    assert.ok(appJs.text.includes(`htmlFor="meeting-agent-select">에이전트</label>
            \${'\\n'}
            <select id="meeting-agent-select"`));
    assert.ok(appJs.text.includes('htmlFor="meeting-agent-question">질문'));
    assert.ok(appJs.text.includes(`htmlFor="meeting-agent-question">질문</label>
            \${'\\n'}
            <textarea`));
    assert.ok(appJs.text.includes(`placeholder="회의실 컨텍스트 기반 자문 질문"
            />
            \${'\\n'}
            <div id="ask-helper" className="ask-helper">`));
    assert.ok(appJs.text.includes('function agentLabel'));
    assert.ok(appJs.text.includes('const AGENT_OPTIONS = Object.freeze(['));
    assert.ok(appJs.text.includes("luna: 'Luna'"));
    assert.ok(appJs.text.includes("nemesis: 'Nemesis'"));
    assert.ok(appJs.text.includes("chronos: 'Chronos'"));
    assert.ok(appJs.text.includes("sentinel: 'Sentinel'"));
    assert.ok(appJs.text.includes("'adaptive-risk': 'Adaptive Risk'"));
    assert.ok(appJs.text.includes("hephaestos: 'Hephaestos'"));
    assert.ok(appJs.text.includes("hanul: 'Hanul'"));
    assert.ok(appJs.text.includes("budget: 'Budget'"));
    assert.ok(appJs.text.includes("scout: 'Scout'"));
    assert.ok(appJs.text.includes("kairos: 'Kairos'"));
    assert.ok(appJs.text.includes("'stock-flow': 'Stock Flow'"));
    assert.ok(appJs.text.includes("sweeper: 'Sweeper'"));
    assert.ok(appJs.text.includes("reporter: 'Reporter'"));
    assert.ok(appJs.text.includes("const ASK_AGENT_STORAGE_KEY = 'lunaMeetingRoomAskAgent';"));
    assert.ok(appJs.text.includes("const ASK_QUESTION_STORAGE_KEY = 'lunaMeetingRoomAskQuestion';"));
    assert.ok(appJs.text.includes('function readSessionValue(key, fallback ='));
    assert.ok(appJs.text.includes('function writeSessionValue(key, value)'));
    assert.ok(appJs.text.includes('function normalizeAgentName(value)'));
    assert.ok(appJs.text.includes('${AGENT_OPTIONS.map((name) => html`<option value=${name}>${agentLabel(name)}</option>${'));
    assert.equal(appJs.text.includes("['luna', 'aria', 'sophia', 'argos', 'hermes', 'oracle', 'zeus', 'athena'].map"), false);
    assert.ok(appJs.text.includes('<option value=${name}>${agentLabel(name)}</option>'));
    assert.ok(appJs.text.includes('title="질의 대상 에이전트"'));
    assert.equal(appJs.text.includes('aria-label="질의 대상 에이전트"'), false);
    assert.equal(appJs.text.includes('aria-label="회의실 컨텍스트 기반 자문 질문"'), false);
    assert.ok(appJs.text.includes('aria-describedby="ask-helper ask-safety-note"'));
    assert.ok(appJs.text.includes("useState(() => normalizeAgentName(readSessionValue(ASK_AGENT_STORAGE_KEY, 'luna')))"));
    assert.ok(appJs.text.includes("useState(() => readSessionValue(ASK_QUESTION_STORAGE_KEY, ''))"));
    assert.ok(appJs.text.includes('writeSessionValue(ASK_AGENT_STORAGE_KEY, nextAgent);'));
    assert.ok(appJs.text.includes('writeSessionValue(ASK_QUESTION_STORAGE_KEY, value);'));
    assert.ok(appJs.text.includes('function submitAsk(event)'));
    assert.ok(appJs.text.includes('event?.preventDefault?.();'));
    assert.ok(appJs.text.includes('function handleQuestionKeyDown(event)'));
    assert.ok(appJs.text.includes("if ((event.metaKey || event.ctrlKey) && event.key === 'Enter')"));
    assert.ok(appJs.text.includes('onKeyDown=${handleQuestionKeyDown}'));
    assert.ok(appJs.text.includes('<h2 id="meeting-ask-form-title">@멘션 질의</h2>'));
    assert.ok(appJs.text.includes('<form className="card-body" aria-labelledby="meeting-ask-form-title" onSubmit=${submitAsk}>'));
    assert.ok(appJs.text.includes('type="submit"'));
    assert.ok(appJs.text.includes('function updateAgent'));
    assert.ok(appJs.text.includes('function updateQuestion'));
    assert.ok(appJs.text.includes('const askRequestSeq = useRef(0);'));
    assert.ok(appJs.text.includes('const askInFlightRef = useRef(false);'));
    assert.ok(appJs.text.includes('function clearAskResponseState()'));
    assert.ok(appJs.text.includes('clearAskResponseState();'));
    assert.ok(appJs.text.includes('}, [token]);'));
    assert.ok(appJs.text.includes('askInFlightRef.current = false;'));
    assert.ok(appJs.text.includes('if (askInFlightRef.current || !question.trim()) return;'));
    assert.ok(appJs.text.includes('askInFlightRef.current = true;'));
    assert.ok(appJs.text.includes('function resetAskStateForInputChange()'));
    assert.ok(appJs.text.includes('askRequestSeq.current += 1;'));
    assert.ok(appJs.text.includes('updateAgent(event.target.value)'));
    assert.ok(appJs.text.includes('updateQuestion(event.target.value)'));
    assert.ok(appJs.text.includes('function updateAgent(value)'));
    assert.ok(appJs.text.includes('function updateQuestion(value)'));
    assert.ok((appJs.text.match(/resetAskStateForInputChange\(\);/g) || []).length >= 2);
    assert.ok((appJs.text.match(/setAnswer\(null\);/g) || []).length >= 2);
    assert.ok(appJs.text.includes('const requestId = askRequestSeq.current + 1;'));
    assert.ok(appJs.text.includes('const requestAgent = agent;'));
    assert.ok(appJs.text.includes('const requestQuestion = question;'));
    assert.ok(appJs.text.includes('if (askRequestSeq.current === requestId)'));
    assert.ok(appJs.text.includes('setAnswer(nextAnswer);'));
    assert.ok(appJs.text.includes('setError(error.message);'));
    assert.ok(appJs.text.includes('setBusy(false);'));
    assert.ok(appJs.text.includes('const hasQuestionDraft = Boolean(question.trim());'));
    assert.ok(appJs.text.includes('const askHelperText = hasQuestionDraft'));
    assert.ok(appJs.text.includes('const emptyAnswerText = hasQuestionDraft'));
    assert.ok(appJs.text.includes('질의 보내기를 누르거나 Ctrl/⌘+Enter로 전송할 수 있습니다.'));
    assert.ok(appJs.text.includes('질문을 입력하면 전송 버튼이 활성화됩니다. Ctrl/⌘+Enter로도 전송할 수 있습니다.'));
    assert.ok(appJs.text.includes('Ctrl/⌘+Enter도 사용할 수 있습니다.'));
    assert.ok(appJs.text.includes('<h2 id="meeting-ask-form-title">@멘션 질의</h2>'));
    assert.ok(appJs.text.includes(`<h2 id="meeting-ask-form-title">@멘션 질의</h2>
        \${'\\n'}
        <form className="card-body"`));
    assert.ok(appJs.text.includes('<div id="ask-safety-note" className="ask-safety-note">'));
    assert.ok(appJs.text.includes(`</div>
          \${'\\n'}
          <div id="ask-safety-note" className="ask-safety-note">`));
    assert.ok(appJs.text.includes('자문 전용 · LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도'));
    assert.ok(appJs.text.includes(`</form>
      </div>
      \${'\\n'}
      <div className="card">`));
    assert.ok(appJs.text.includes('질문을 입력하면 활성화됩니다.'));
    assert.ok(appJs.text.includes('선택한 에이전트에게 자문 질문을 보냅니다.'));
    assert.ok(appJs.text.includes('아직 응답 없음 · 응답은 이 영역에 표시됩니다.'));
    assert.ok(appJs.text.includes('아직 응답 없음 · 질문을 입력한 뒤 질의 보내기를 누르세요.'));
    assert.equal(appJs.text.includes('아직 응답 없음 · 질의 보내기를 눌러 응답을 확인하세요.'), false);
    assert.ok(appJs.text.includes('function EvidenceDetails'));
    assert.ok(appJs.text.includes('open ? html`<pre>'));
    assert.ok(appJs.text.includes('setAnswer(null);'));
    assert.ok(appJs.text.includes('className="answer" role="status" aria-live="polite" aria-busy=${busy} aria-label="에이전트 질의 응답"'));
    assert.ok(appJs.text.includes('질의 중 · 에이전트 응답을 기다리는 중입니다.'));
    assert.ok(appJs.text.includes('상태 ${answerStatusLabel(answer.ok)} · 응답:'));
    assert.ok(appJs.text.includes('<h2>응답</h2>'));
    assert.ok(appJs.text.includes(`<h2>응답</h2>
        \${'\\n'}
        <div className="card-body">`));
    assert.ok(appJs.text.includes('<div className="meta">에이전트 ${agentLabel(answer.agent || agent)} · 응답 방식 ${providerLabel(answer.provider)} · 상태 ${answerStatusLabel(answer.ok)} · 응답: </div>'));
    assert.ok(appJs.text.includes(`상태 \${answerStatusLabel(answer.ok)} · 응답: </div>
              \${'\\n'}
              <div className="answer-content">`));
    assert.ok(appJs.text.includes('className="answer-content"'));
    assert.ok(appJs.text.includes('function answerStatusLabel'));
    assert.ok(appJs.text.includes('function providerLabel'));
    assert.ok(appJs.text.includes("if (normalized === 'rule_based' || normalized === 'rule-based' || normalized === 'deterministic') return '규칙 기반';"));
    assert.ok(appJs.text.includes('aria-label=${busy ? `${agentLabel(agent)}에게 자문 질문 진행 중` : `${agentLabel(agent)}에게 자문 질문 보내기`}'));
    assert.ok(appJs.text.includes('aria-busy=${busy}'));
    assert.equal(appJs.text.includes('aria-label=${`${agent}에게 자문 질문 보내기`}'), false);
    assert.ok(appJs.text.includes('에이전트 ${agentLabel(answer.agent || agent)} · 응답 방식 ${providerLabel(answer.provider)}'));
    assert.equal(appJs.text.includes("|| 'n/a'} · 상태"), false);
    assert.equal(appJs.text.includes('answer.route'), false);
    assert.equal(appJs.text.includes('제공자 ${providerLabel(answer.provider || answer.route?.provider)}'), false);
    assert.ok(appJs.text.includes('상태 ${answerStatusLabel(answer.ok)}'));
    assert.equal(appJs.text.includes('ok=${String(answer.ok)}'), false);
    assert.equal(appJs.text.includes('advisory only'), false);
    assert.equal(appJs.text.includes('advisory 질문'), false);
    assert.ok(html.text.includes('.ask-helper'));
    assert.ok(html.text.includes('.notice'));
    assert.ok(html.text.includes('.decision-state'));
    assert.ok(html.text.includes('.catchup [role="list"]'));
    assert.ok(html.text.includes('.polling-status'));
    assert.ok(html.text.includes('details:not([open]) > :not(summary)'));
    assert.ok(html.text.includes('display: none;'));
    assert.ok(html.text.includes('summary {'));
    assert.ok(html.text.includes('min-height: 40px;'));
    assert.ok(html.text.includes('.check { display: flex; gap: 8px; align-items: center; min-height: 40px;'));
    assert.ok(html.text.includes('.check input { width: 20px; height: 20px;'));
    assert.ok(html.text.includes('.manual-start-note'));
    assert.ok(html.text.includes('font-weight: 700;'));
    assert.ok(html.text.includes('@media (max-width: 1080px)'));
    assert.ok(html.text.includes('.grid, .ask-grid { grid-template-columns: 1fr; }'));
    assert.ok(html.text.includes('.meeting-list-row .meeting-item'));
    assert.ok(html.text.includes('.due.unknown'));
    assert.ok(appJs.text.includes("label: '기한 확인 필요'"));
    assert.ok(appJs.text.includes('label: `정상 ${formatTime(value)}`'));
    assert.equal(appJs.text.includes("label: 'due n/a'"), false);
    assert.equal(appJs.text.includes('label: `due ${formatTime(value)}`'), false);
    assert.ok(appJs.text.includes("run.status === 'running'"));
    assert.ok(appJs.text.includes('const pollingIntervalMs = hasRunningRun ? 3000 : 30000'));
    assert.ok(appJs.text.includes('폴링: 실행 중 회의 감지 · 3초마다 갱신'));
    assert.ok(appJs.text.includes('폴링: 대기 · 30초마다 갱신'));
    assert.equal(appJs.text.includes('폴링: idle'), false);
    assert.ok(appJs.text.includes('role="status" aria-live="polite" aria-label=${`회의실 폴링 상태: ${pollingLabel}`}'));
    assert.ok(appJs.text.includes('>${pollingLabel}</div>\n    ${\'\\n\'}'));
    assert.equal(appJs.text.includes('aria-label="회의실 폴링 상태"'), false);
    assert.ok(appJs.text.includes('<label className="meta" htmlFor="meeting-type-select">회의 타입</label>\n      ${\'\\n\'}'));
    assert.ok(appJs.text.includes('</select>\n        ${\'\\n\'}'));
    assert.ok(appJs.text.includes("index < segmentRows.length - 1 ? '\\n' : ''"));
    assert.ok(appJs.text.includes('<${StartMeeting} token=${token} segments=${segments} onStarted=${handleMeetingStarted} setError=${setError} />\n        ${\'\\n\'}'));
    assert.ok(appJs.text.includes('<${Timeline} detail=${detail} catchup=${catchup} loading=${detailLoading} />\n      ${\'\\n\'}'));
    assert.ok(appJs.text.includes('<h2>회의 목록</h2>\n      ${\'\\n\'}'));
    assert.ok(appJs.text.includes('</div>\n          ${\'\\n\'}\n        `)}'));
    assert.ok(appJs.text.includes('<span className="role-chip" role="listitem"'));
    assert.ok(appJs.text.includes('</span>\n            ${\'\\n\'}'));
    assert.ok(appJs.text.includes("' adr'"));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${minute.content}'));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${decision.decision}'));
    assert.ok(appJs.text.includes('<${MarkdownLite} text=${answer.text || answer.error ||'));
    const truncatedCircuit = _testOnly.normalizeLegacyMinuteContent('활성 서킷 [ { "market": "crypto", "symbol": "RENDER/USDT", "circuit": "low_profit_symbol" }, ...[truncated]\n실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다.');
    assert.ok(truncatedCircuit.includes('활성 서킷: 상세 근거는 감사 로그에 보존'));
    assert.equal(truncatedCircuit.includes('원문 DB'), false);
    assert.equal(truncatedCircuit.includes('JSON 숨김'), false);
    assert.ok(truncatedCircuit.includes('실거래와 파라미터 변경은 이 화면에서 적용하지 않습니다.'));
    assert.equal(truncatedCircuit.includes('실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다'), false);
    assert.equal(truncatedCircuit.includes('"market"'), false);
    assert.equal(truncatedCircuit.includes('low_profit_symbol'), false);
    const premarketDataMinute = _testOnly.normalizeLegacyMinuteContent([
      '미국 프리마켓 게이트/레짐',
      '게이트/레짐/포지션/예정 이벤트를 read-only로 점검합니다.',
      '{',
      '  "gate": { "market": "overseas", "score": "47.07", "deployment": "reduced", "signals": { "signals": [{ "available": true }, { "available": false }] } },',
      '  "regime": { "market": "overseas", "current_regime": "sideways", "confidence": 0.47, "source": "hmm" },',
      '  "positions": [{ "symbol": "AAPL" }]',
      '}',
    ].join('\n'));
    assert.ok(premarketDataMinute.includes('증거 요약'));
    assert.ok(premarketDataMinute.includes('게이트=미국 reduced 47.1점 · 신호 1/2개 사용'));
    assert.ok(premarketDataMinute.includes('레짐=미국 수평(0.47) · 출처=HMM'));
    assert.ok(premarketDataMinute.includes('보유 포지션=1건(AAPL)'));
    assert.equal(premarketDataMinute.includes('"gate"'), false);
    assert.equal(premarketDataMinute.includes('"strategySignals"'), false);
    assert.equal(premarketDataMinute.includes('read-only'), false);
    const debriefDataMinute = _testOnly.normalizeLegacyMinuteContent([
      'G6 대조표 날짜=2026-06-12 degraded=true',
      'morning=없음 reason=same_day_morning_session_missing',
      'signals=0, preflight=0, active_circuit=1',
      'gate_transitions=[',
      '{',
      '"market": "domestic",',
      '"samples": 32,',
      '"deployment_states": 2,',
      '"deployments": ["halt", "reduced"]',
      '}',
      ']',
      'regime_transitions=[',
      '{',
      '"market": "domestic",',
      '"samples": 32,',
      '"regime_states": 1,',
      '"regimes": ["bull"]',
      '}',
      ']',
      'kis_trades=0',
      '미발화 행=0: []',
      'errors=[',
      '"function pg_catalog.timezone(unknown, bigint) does not exist"',
      ']',
    ].join('\n'));
    assert.ok(debriefDataMinute.includes('G6 대조표 날짜=2026-06-12 · 데이터 보강 필요'));
    assert.ok(debriefDataMinute.includes('아침 회의=없음 · 사유=동일 날짜 아침 회의 없음'));
    assert.ok(debriefDataMinute.includes('전략 신호=0건, 프리플라이트=0건, 활성 서킷=1건'));
    assert.ok(debriefDataMinute.includes('게이트 전이: 국내 32표본 · 배치상태 2종(halt, reduced)'));
    assert.ok(debriefDataMinute.includes('레짐 전이: 국내 32표본 · 레짐 1종(상승)'));
    assert.ok(debriefDataMinute.includes('KIS 체결=0건'));
    assert.ok(debriefDataMinute.includes('미발화 행=0건'));
    assert.ok(debriefDataMinute.includes('오류: 1건 · 상세는 감사 로그에 보존'));
    assert.equal(debriefDataMinute.includes('원문 DB'), false);
    assert.equal(debriefDataMinute.includes('degraded=true'), false);
    assert.equal(debriefDataMinute.includes('reason=same_day_morning_session_missing'), false);
    assert.equal(debriefDataMinute.includes('morning 회의'), false);
    assert.equal(debriefDataMinute.includes('active_circuit='), false);
    assert.equal(debriefDataMinute.includes('gate_transitions='), false);
    assert.equal(debriefDataMinute.includes('regime_transitions='), false);
    assert.equal(debriefDataMinute.includes('kis_trades='), false);
    assert.equal(debriefDataMinute.includes('function pg_catalog.timezone'), false);
    assert.equal(debriefDataMinute.includes('"market"'), false);
    const escapedStaticPath = await request(baseUrl, '/%2e%2e%2fserver/index.ts');
    assert.equal(escapedStaticPath.status, 403);

    const meetings = await request(baseUrl, '/api/meetings');
    assert.equal(meetings.payload.meetings.length, 1);
    assert.ok(meetings.payload.scheduleStatus.includes('정례 실행 상태:'));
    assert.ok(meetings.payload.scheduleStatus.includes('최신 아침 통합 회의: #1'));
    assert.ok(meetings.payload.scheduleStatus.includes('최신 전체 회의: #1 아침 통합 회의'));
    const storedCryptoSegment = meetings.payload.meetings[0].segments.find((row) => row.market === 'crypto');
    assert.equal(storedCryptoSegment.label, '암호화폐 24시간 점검');
    assert.equal(storedCryptoSegment.reasonLabel, '24시간 운영');
    assert.equal(storedCryptoSegment.marketLabel, '암호화폐');
    assert.equal(JSON.stringify(meetings.payload.meetings[0].segments).includes('crypto 24h 점검'), false);
    assert.ok(Array.isArray(meetings.payload.segments));
    assert.equal(meetings.payload.segments.find((row) => row.market === 'domestic')?.skipped, true);
    assert.equal(meetings.payload.segments.find((row) => row.market === 'domestic')?.reason, 'weekend');
    assert.equal(meetings.payload.segments.find((row) => row.market === 'domestic')?.reasonLabel, '주말');
    assert.equal(meetings.payload.segments.find((row) => row.market === 'crypto')?.label, '암호화폐 24시간 점검');

    const detail = await request(baseUrl, '/api/meetings/1');
    assert.equal(detail.payload.minutes.length, 5);
    assert.equal(detail.payload.minutes[0].content, '회의 시작');
    assert.ok(detail.payload.minutes[1].content.includes('**BTC**'));
    assert.ok(detail.payload.minutes[1].content.includes('암호화폐 요약'));
    assert.ok(detail.payload.minutes[1].content.includes('| 항목 | 값 |'));
    assert.ok(detail.payload.minutes[1].content.includes('<script>alert(1)</script>'));
    assert.ok(detail.payload.minutes[1].content.includes('게이트=reduced 점수=55.3'));
    assert.ok(detail.payload.minutes[1].content.includes('레짐=하락 출처=HMM'));
    assert.equal(detail.payload.minutes[1].content.includes('score='), false);
    assert.equal(detail.payload.minutes[1].content.includes('source='), false);
    assert.equal(detail.payload.minutes[1].content.includes('레짐=bear'), false);
    assert.equal(detail.payload.minutes[1].content.includes('출처=hmm'), false);
    assert.equal(detail.payload.minutes[1].content.includes('crypto 요약'), false);
    assert.equal(detail.payload.minutes[1].content.includes('활성 서킷: 57건'), false);
    assert.ok(detail.payload.minutes[1].content.includes('활성 서킷: 2건(저수익 1·쿨다운 1)'));
    assert.ok(detail.payload.minutes[1].content.includes('대표 심볼=RENDER/USDT, SOL/USDT'));
    assert.equal(detail.payload.minutes[1].content.includes('"market":"crypto"'), false);
    assert.equal(detail.payload.minutes[1].content.includes('low_profit_symbol'), false);
    assert.ok(detail.payload.minutes[1].content.includes('활성 서킷: 최신 데이터 영역 기준으로 봅니다'));
    assert.equal(detail.payload.minutes[1].content.includes('과거 발언의 중복 서킷 숫자 숨김'), false);
    assert.equal(detail.payload.minutes[1].content.includes('legacy'), false);
    assert.equal(detail.payload.minutes[1].content.includes('distinct'), false);
    assert.equal(/[{}]/.test(detail.payload.minutes[2].content), false);
    assert.ok(detail.payload.minutes[2].content.includes('C15 검토: 컴포넌트=C15 레짐 엔진 HMM'));
    assert.equal(detail.payload.minutes[2].content.includes('C15 결정 대기:'), false);
    assert.equal(detail.payload.minutes[2].content.includes('regime-engine-hmm'), false);
    assert.ok(detail.payload.minutes[2].content.includes('상태=활성'));
    assert.ok(detail.payload.minutes[2].content.includes('모드=미정→미정'));
    assert.ok(detail.payload.minutes[2].content.includes('Brier: HMM이 폴백보다 낮음'));
    assert.ok(detail.payload.minutes[2].content.includes('비교 기준=동일봉 종가'));
    assert.ok(detail.payload.minutes[2].content.includes('그릴 커버리지=예'));
    assert.ok(detail.payload.minutes[2].content.includes('결정 추적=예'));
    assert.ok(detail.payload.minutes[2].content.includes('완료 회의 수=10'));
    assert.ok(detail.payload.minutes[2].content.includes('임시 기준=예'));
    assert.ok(detail.payload.minutes[2].content.includes('미충족: 임시 기준'));
    assert.ok(detail.payload.minutes[2].content.includes('C15 MAPEK: 자문 기록 후 마스터 확인 대기'));
    assert.equal(detail.payload.minutes[2].content.includes('C15 결정 대기: C15 MAPEK'), false);
    assert.equal(detail.payload.minutes[2].content.includes('상태=active'), false);
    assert.equal(detail.payload.minutes[2].content.includes('mapek: advisory'), false);
    assert.equal(detail.payload.minutes[2].content.includes('unknown→unknown'), false);
    assert.equal(detail.payload.minutes[2].content.includes('placeholder 기준=true'), false);
    assert.equal(detail.payload.minutes[2].content.includes('placeholder 기준'), false);
    assert.equal(detail.payload.minutes[2].content.includes('compareAgainst='), false);
    assert.equal(detail.payload.minutes[2].content.includes('same_bar_close'), false);
    assert.equal(detail.payload.minutes[2].content.includes('next-bar 수익률 차이'), false);
    assert.equal(detail.payload.minutes[2].content.includes('HMM<폴백'), false);
    assert.equal(detail.payload.minutes[2].content.includes('grillCoverage='), false);
    assert.ok(detail.payload.minutes[3].content.includes('ADR 기록: C 마스터 확인 / 마스터 액션 대기'));
    assert.equal(detail.payload.minutes[3].content.includes('ADR recorded: c_master/pending_master'), false);
    assert.equal((detail.payload.minutes[4].content.match(/이러한 결과를 기반으로/g) || []).length, 0);
    assert.equal((detail.payload.minutes[4].content.match(/최종 결론/g) || []).length, 0);
    assert.ok(detail.payload.minutes[4].content.includes('요약 결론입니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('반복 결론 문단'));
    assert.ok(detail.payload.minutes[4].content.includes('요약 표시했습니다.'));
    assert.equal(detail.payload.minutes[4].content.includes('[표시 보정]'), false);
    assert.equal(detail.payload.minutes[4].content.includes('원문은 감사 로그에 보존됩니다.'), false);
    assert.equal(detail.payload.minutes[4].content.includes('원문은 DB 회의록에 보존됩니다.'), false);
    assert.ok(detail.payload.minutes[4].content.includes('회의 데이터 요약과 섀도 스택'));
    assert.equal(detail.payload.minutes[4].content.includes('회의 데이터 요약와'), false);
    assert.ok(detail.payload.minutes[4].content.includes('최신 게이트/레짐/신호/서킷이 반대로 바뀌면 무효다.'));
    assert.ok(detail.payload.minutes[4].content.includes('동유형 ADR/레지스트리 근거를 확인해야 한다.'));
    assert.ok(detail.payload.minutes[4].content.includes('비용 가드: 최대 호출 6회 도달로 발언 생략'));
    assert.ok(detail.payload.minutes[4].content.includes('암호화폐 시장은 현재 하락세에 있다.'));
    assert.ok(detail.payload.minutes[4].content.includes('레짐은 각각 상승(0.41), 수평(0.47), 하락(0.74) 상태입니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('레짐은 국내 상승, 미국 수평, 암호화폐 하락 상태입니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('회의 데이터 요약을 기준으로 미국이 수평 상태입니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('비교 기준=게이트 비활성 가상 비교'));
    assert.ok(detail.payload.minutes[4].content.includes('halt/reduced 회피 개선폭: 비교 데이터가 없습니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('C15 검토 점검'));
    assert.equal(detail.payload.minutes[4].content.includes('[Aria]'), false);
    const sameSpeakerPrefixMinute = _testOnly.normalizeMinute({
      id: 99,
      sessionId: 1,
      seq: 99,
      agendaKey: 'agent:aria',
      speaker: 'aria',
      role: 'analysis',
      content: '[aria] C15 결정 대기 점검',
      meta: {},
      createdAt: '2026-06-11T00:00:04.000Z',
    });
    assert.ok(sameSpeakerPrefixMinute.content.includes('C15 검토 점검'));
    assert.equal(sameSpeakerPrefixMinute.content.includes('Aria 자문:'), false);
    assert.equal(sameSpeakerPrefixMinute.content.includes('[Aria]'), false);
    assert.equal(detail.payload.minutes[4].content.includes('C15 결정 대기:'), false);
    assert.equal(detail.payload.minutes[4].content.includes('bull(0.41)'), false);
    assert.equal(detail.payload.minutes[4].content.includes('sideways(0.47)'), false);
    assert.equal(detail.payload.minutes[4].content.includes('bear(0.74)'), false);
    assert.equal(detail.payload.minutes[4].content.includes('국내 bull'), false);
    assert.equal(detail.payload.minutes[4].content.includes('미국 sideways'), false);
    assert.equal(detail.payload.minutes[4].content.includes('암호화폐 bear'), false);
    assert.equal(detail.payload.minutes[4].content.includes('회의 데이터 요약를'), false);
    assert.equal(detail.payload.minutes[4].content.includes('미국가'), false);
    assert.equal(detail.payload.minutes[4].content.includes('gate_off_virtual'), false);
    assert.equal(detail.payload.minutes[4].content.includes('halt_reduced_avoidance_delta'), false);
    assert.equal(detail.payload.minutes[4].content.includes('[aria]'), false);
    assert.equal(detail.payload.minutes[4].content.includes('T14:43:59'), false);
    assert.equal(_testOnly.normalizeLegacyMinuteContent('close'), '회의 종료');
    assert.equal(
      _testOnly.normalizeLegacyMinuteContent('meeting decision confirm via web: no note'),
      '결정 확정 처리 · 경로=웹 · 메모 없음',
    );
    assert.equal(
      _testOnly.normalizeLegacyMinuteContent('meeting decision defer via telegram: need more data'),
      '결정 보류 처리 · 경로=텔레그램 · 메모=need more data',
    );
    assert.equal(_testOnly.normalizeLegacyMinuteContent('MR-B confirm: no note'), '결정 확정 처리 · 경로=웹 · 메모 없음');
    assert.equal(_testOnly.normalizeLegacyMinuteContent('주말 회의는 海外와 crypto 시장만 확인합니다.'), '주말 회의는 미국과 암호화폐 시장만 확인합니다.');
    const premarketTranslatedStatus = _testOnly.normalizeLegacyMinuteContent(
      '미국 국내 시장은 현재 halt 상태이며, 33개의 이벤트가 진행 중입니다.\n미국 시장은 현재 진행이 감소된 상태이며, 47개의 이벤트가 진행 중입니다.',
    );
    assert.ok(premarketTranslatedStatus.includes('국내 시장은 현재 halt 상태이며, 점수는 33점입니다.'));
    assert.ok(premarketTranslatedStatus.includes('미국 시장은 현재 reduced 상태이며, 점수는 47점입니다.'));
    assert.equal(premarketTranslatedStatus.includes('미국 국내 시장'), false);
    assert.equal(premarketTranslatedStatus.includes('진행이 감소된 상태'), false);
    assert.equal(premarketTranslatedStatus.includes('개의 이벤트가 진행 중입니다'), false);
    const premarketActiveSegmentPercent = _testOnly.normalizeLegacyMinuteContent(
      '국내 시장은 현재 중단 상태로, 33%의 활성 세그먼트가 유지되고 있습니다.\n미국 시장은 현재 감소 상태로, 47%의 활성 세그먼트가 유지되고 있습니다.',
    );
    assert.ok(premarketActiveSegmentPercent.includes('국내 시장은 현재 halt 상태이며, 점수는 33점입니다.'));
    assert.ok(premarketActiveSegmentPercent.includes('미국 시장은 현재 reduced 상태이며, 점수는 47점입니다.'));
    assert.equal(premarketActiveSegmentPercent.includes('중단 상태로'), false);
    assert.equal(premarketActiveSegmentPercent.includes('감소 상태로'), false);
    assert.equal(premarketActiveSegmentPercent.includes('%의 활성 세그먼트'), false);
    const premarketSituationIntro = _testOnly.normalizeLegacyMinuteContent(
      '미국 프리마켓 게이트/레짐에 대한 현재 상황은 다음과 같습니다.\n\n현재 상황을 종합하면, 미국 프리마켓 게이트/레짐은 국내 시장에서 halt 상태를 유지하고 있습니다.',
    );
    assert.ok(premarketSituationIntro.includes('미국 프리마켓 게이트/레짐 현황입니다.'));
    assert.ok(premarketSituationIntro.includes('요약하면, 미국 프리마켓 게이트/레짐은 국내 시장에서 halt 상태를 유지하고 있습니다.'));
    assert.equal(premarketSituationIntro.includes('현재 상황은 다음과 같습니다'), false);
    assert.equal(premarketSituationIntro.includes('현재 상황을 종합하면'), false);
    const pendingScopeAndCircuitMinute = _testOnly.normalizeLegacyMinuteContent(
      '전략군 24시간 신호 1건(진입 0건)입니다. 현재 14건의 활성 서킷이 유지되고 있습니다. 결정 대기 중인 건은 5건입니다.',
    );
    assert.ok(pendingScopeAndCircuitMinute.includes('활성 서킷 14건이 유지되고 있습니다.'));
    assert.ok(pendingScopeAndCircuitMinute.includes('C15 검토 대기 5건입니다.'));
    assert.equal(pendingScopeAndCircuitMinute.includes('입니다, 활성 서킷'), false);
    assert.equal(pendingScopeAndCircuitMinute.includes('현재 14건의 활성 서킷'), false);
    assert.equal(pendingScopeAndCircuitMinute.includes('결정 대기 중인 건은'), false);
    const deterministicAnalysisWording = _testOnly.normalizeLegacyMinuteContent(
      '계산된 회의 데이터 요약만 사용한 자문 분석입니다.\n실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다.',
    );
    assert.ok(deterministicAnalysisWording.includes('회의 데이터만 근거로 작성한 자문입니다.'));
    assert.ok(deterministicAnalysisWording.includes('실거래와 파라미터 변경은 이 화면에서 적용하지 않습니다.'));
    assert.equal(deterministicAnalysisWording.includes('계산된 회의 데이터 요약만 사용한 자문 분석입니다'), false);
    assert.equal(deterministicAnalysisWording.includes('실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다'), false);
    const duplicatedDeterministicTitle = _testOnly.normalizeLegacyMinuteContent(
      '미국 프리마켓 게이트/레짐\n회의 데이터만 근거로 작성한 자문입니다.\n미국 프리마켓 게이트/레짐\n게이트/레짐/포지션/예정 이벤트를 읽기 전용으로 점검합니다.',
    );
    assert.equal((duplicatedDeterministicTitle.match(/미국 프리마켓 게이트\/레짐/g) || []).length, 1);
    assert.ok(duplicatedDeterministicTitle.startsWith('회의 데이터만 근거로 작성한 자문입니다.'));
    const duplicatedDeterministicTitleWithAgent = _testOnly.normalizeMinute({
      id: 1,
      session_id: 1,
      seq: 1,
      agenda_key: 'us_premarket',
      speaker: 'aria',
      role: 'analysis',
      content: '[aria] 미국 프리마켓 게이트/레짐\n회의 데이터만 근거로 작성한 자문입니다.\n미국 프리마켓 게이트/레짐\n게이트/레짐/포지션/예정 이벤트를 읽기 전용으로 점검합니다.',
      meta: {},
      created_at: '2026-06-12T00:00:00.000Z',
    });
    assert.equal((duplicatedDeterministicTitleWithAgent.content.match(/미국 프리마켓 게이트\/레짐/g) || []).length, 1);
    assert.equal(/Aria 자문:|\[Aria\]|\[aria\]/.test(duplicatedDeterministicTitleWithAgent.content), false);
    const premarketGenericConclusion = _testOnly.normalizeLegacyMinuteContent(
      '현재 상황을 종합하면, 미국 프리마켓 게이트/레짐은 국내 시장에서 halt 상태를 유지하고 있으며, 미국 시장과 암호화폐 시장은 reduced 상태를 유지하고 있습니다. 따라서, 현 시점에서 추가적인 조치가 필요합니다.\n\n결과적으로, 현 시점에서 추가적인 조치가 필요하며, 국내 시장의 halt 상태를 유지하고 미국 시장과 암호화폐 시장의 reduced 상태를 지속적으로 모니터링하는 것이 필요합니다.',
    );
    assert.ok(premarketGenericConclusion.includes('요약하면, 미국 프리마켓 게이트/레짐은 국내 시장에서 halt 상태를 유지하고 있으며'));
    assert.ok(premarketGenericConclusion.includes('후속 조치는 마스터 확인 후 기록합니다.'));
    assert.equal((premarketGenericConclusion.match(/후속 조치는 마스터 확인 후 기록합니다/g) || []).length, 1);
    assert.equal(premarketGenericConclusion.includes('결과적으로'), false);
    assert.equal(premarketGenericConclusion.includes('현재 상황을 종합하면'), false);
    assert.equal((premarketGenericConclusion.match(/현 시점에서 추가적인 조치/g) || []).length, 0);
    const premarketEventSummary = _testOnly.normalizeLegacyMinuteContent(
      '4. 국내 시장의 전략은 현재 상승 추세를 보이고 있으며, 0.38의 강도에 해당합니다.\n5. 미국 시장의 전략은 현재 중립적인 상태이며, 0.\n6. 암호화폐 시장의 전략은 현재 하락 추세를 보이고 있으며, 0.\n7. 전략군 24시간 동안 1건의 이벤트가 발생했습니다.\n8. 현재 활성 서킷은 14건이며, 결정 대기 중인 이벤트는 5건입니다.\n\n따라서, 현재 미국 보유/예정 이벤트의 진행 상황은 국내 시장의 halt 상태, 미국 시장의 reduced 상태, 암호화폐 시장의 reduced 상태, 국내 시장의 전략이 상승 추세, 미국 시장의 전략이 중립적, 암호화폐 시장의 전략이 하락 추세, 전략군 24시간 동안 1건의 이벤트가 발생, 활성 서킷 14건, 결정 대기 중인 이벤트 5건입니다.',
    );
    assert.ok(premarketEventSummary.includes('국내 레짐은 상승(0.38)입니다.'));
    assert.ok(premarketEventSummary.includes('미국 레짐은 수평입니다.'));
    assert.ok(premarketEventSummary.includes('암호화폐 레짐은 하락입니다.'));
    assert.ok(premarketEventSummary.includes('전략군 24시간 신호 1건입니다.'));
    assert.ok(premarketEventSummary.includes('결정 대기: 상단 캐치업 기준입니다.'));
    assert.ok(premarketEventSummary.includes('요약은 위 게이트·레짐·전략·서킷 항목 기준입니다.'));
    assert.equal(premarketEventSummary.includes('시장의 전략'), false);
    assert.equal(premarketEventSummary.includes('이벤트가 발생'), false);
    assert.equal(premarketEventSummary.includes('결정 대기 중인 이벤트'), false);
    const premarketEntryTerm = _testOnly.normalizeLegacyMinuteContent(
      '게이트/레짐/포지션/예정 이벤트를 read-only로 점검합니다.\n전략군 24시간 동안 1건의 입장(Entry 0)이 발생하였으며, 현재 14건의 활성 서킷이 유지되고 있습니다.',
    );
    assert.ok(premarketEntryTerm.includes('읽기 전용으로 점검합니다.'));
    assert.ok(premarketEntryTerm.includes('전략군 24시간 신호 1건(진입 0건)입니다'));
    assert.equal(premarketEntryTerm.includes('상세 JSON'), false);
    assert.equal(premarketEntryTerm.includes('읽기 전용로'), false);
    assert.equal(premarketEntryTerm.includes('입장(Entry 0)'), false);
    assert.equal(premarketEntryTerm.includes('입니다, 현재'), false);
    const truncatedRegimeSentence = _testOnly.normalizeLegacyMinuteContent(
      'C2 레짐에 따르면, 국내 시장은 상승 추세를 유지하고 있으며, 0.38의 점수가 기록되고 있습니다. 미국 시장은 중립적인 추세를 유지하고 있으며, 0. 암호화폐 시장은 하락 추세를 유지하고 있으며, 0.',
    );
    assert.ok(truncatedRegimeSentence.includes('국내 시장은 상승 레짐입니다.'));
    assert.ok(truncatedRegimeSentence.includes('미국 시장은 수평 레짐입니다.'));
    assert.ok(truncatedRegimeSentence.includes('암호화폐 시장은 하락 레짐입니다.'));
    assert.equal(truncatedRegimeSentence.includes('0. 암호화폐'), false);
    assert.equal(detail.payload.minutes[4].content.includes('DB minute'), false);
    assert.equal(detail.payload.minutes[4].content.includes('plan-note'), false);
    assert.equal(detail.payload.minutes[4].content.includes('shadow stack'), false);
    assert.equal(detail.payload.minutes[4].content.includes('registry evidence'), false);
    assert.equal(detail.payload.minutes[4].content.includes('gate/regime/signal/circuit'), false);
    assert.equal(detail.payload.minutes[4].content.includes('cost_guard_skipped'), false);
    assert.equal(detail.payload.minutes[4].content.includes('max calls'), false);
    assert.equal(detail.payload.minutes[4].content.includes('crypto 시장'), false);
    assert.ok(detail.payload.minutes[4].content.includes('국내: halt(32)'));
    assert.ok(detail.payload.minutes[4].content.includes('암호화폐: reduced(55)'));
    assert.ok(detail.payload.minutes[4].content.includes('미국: full(72)'));
    assert.ok(detail.payload.minutes[4].content.includes('halt 상태(32점)'));
    assert.equal(_testOnly.sessionStatusLabel('raw_status'), '상태 미상');
    assert.equal(_testOnly.agendaLabel('decision:raw_component'), '안건');
    assert.equal(_testOnly.agendaLabel('debrief:g6-plan-vs-actual'), '국내 마감 G6 대조표');
    assert.equal(_testOnly.agendaLabel('premarket:overseas-gate-regime'), '미장 전 게이트·레짐 점검');
    assert.equal(_testOnly.agendaLabel('premarket:overseas-watch'), '미장 전 감시 목록 점검');
    assert.equal(_testOnly.agendaLabel('weekly:shadow-stack-review'), '주간 섀도 스택 리뷰');
    assert.equal(_testOnly.componentLabel('raw-component'), '컴포넌트 미상');
    assert.equal(_testOnly.legacyMetricLabel('raw_metric_key'), '지표');
    assert.equal(_testOnly.agentDisplayLabel('raw-agent'), '에이전트 미상');
    assert.ok(detail.payload.minutes[4].content.includes('암호화폐 시장은 reduced(55점)'));
    assert.ok(detail.payload.minutes[4].content.includes('미국 시장은 현재 halt 상태'));
    assert.ok(detail.payload.minutes[4].content.includes('세그먼트 모두 halt 상태'));
    assert.ok(detail.payload.minutes[4].content.includes('BTC 실현 볼륨 프록시'));
    assert.ok(detail.payload.minutes[4].content.includes('진입 없음'));
    assert.ok(detail.payload.minutes[4].content.includes('현재는 진입한 거래가 없습니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('이는 배치 halt 상태를 나타냅니다.'));
    assert.ok(detail.payload.minutes[4].content.includes('전략군은 현재 진입하지 않았으며'));
    assert.ok(detail.payload.minutes[4].content.includes('전략군 진입을 고려'));
    assert.ok(detail.payload.minutes[4].content.includes('결정 대기: 상단 캐치업 기준입니다'));
    assert.equal(detail.payload.minutes[4].content.includes('결정 대기: 상단 캐치업 기준으로 확인하세요'), false);
    assert.equal(detail.payload.minutes[4].content.includes('과거 발언 숫자 숨김'), false);
    assert.equal(detail.payload.minutes[4].content.includes('상단 U1 캐치업 기준'), false);
    assert.equal(detail.payload.minutes[4].content.includes('legacy'), false);
    assert.equal(detail.payload.minutes[4].content.includes('최신 데이터 minute'), false);
    assert.equal(detail.payload.minutes[4].content.includes("'할당' 상태"), false);
    assert.equal(detail.payload.minutes[4].content.includes('프로ksi'), false);
    assert.equal(detail.payload.minutes[4].content.includes('프로끼'), false);
    assert.equal(detail.payload.minutes[4].content.includes('저평가 상태'), false);
    assert.equal(detail.payload.minutes[4].content.includes('해외'), false);
    assert.equal(detail.payload.minutes[4].content.includes('입장한 거래'), false);
    assert.equal(detail.payload.minutes[4].content.includes('입장하지'), false);
    assert.equal(detail.payload.minutes[4].content.includes('현재 5개의 결정이 대기 중'), false);
    assert.equal(detail.payload.minutes[4].content.includes('결정 대기는 5건 남아있다'), false);
    assert.equal(detail.payload.minutes[4].content.includes('결정 대기는 5건이 대기 중'), false);
    assert.equal(detail.payload.minutes[4].content.includes('확인하세요. ,'), false);
    assert.equal(detail.payload.minutes[4].content.includes('봅니다이며'), false);
    assert.equal(detail.payload.minutes[4].content.includes('기준입니다.국내'), false);
    assert.equal(detail.payload.minutes[4].content.includes('분석 결과는 다음과 같이 요약'), false);
    assert.ok(detail.payload.minutes[4].content.includes('중단 제안은 한국어 라벨로 유지'));
    const debriefAnalysisMinute = _testOnly.normalizeLegacyMinuteContent([
      '안녕하세요. 현재 C15 결정 대기 상황입니다.',
      '"암호화폐에서는 62건의 샘플을 기반으로 \'줄인\' 상태에 있습니다."',
      '국내에서는 강세 상태에 있지만, 미국에서는 중립 상태이며, 암호화폐에서는 약세 상태에 있습니다.',
      '미국와 암호화폐에 대한 분석 결과를 고려하십시오.',
      '전략군 24시간 동안 0건의 거래가 발생했습니다.',
      '전략군 24시간 동안 거래가 발생하지 않았습니다.',
      '**전략군 24시간** : 0건의 거래가 발생했습니다.',
      '결정 대기 중인 서킷은 5건입니다.',
      '결과적으로, 국내 마감 G6 대조표의 분석 결과는 다음과 같이 요약할 수 있습니다.',
      '따라서, 국내 마감 G6 대조표에 대한 다음 조치를 취해야 합니다: 국내 마감 G6 대조표에 대한 추가 분석을 수행하고, 미국과 암호화폐에 대한 분석 결과를 고려하여 최종 결정을 내릴 수 있도록 하십시오.',
      '활성 서킷: 최신 데이터 영역 기준으로 봅니다. 이 있습니다.',
      '이러한 정보를 참고하여 C15 결정 대기의 최종 결정을 내릴 수 있습니다.',
    ].join('\n'));
    assert.ok(debriefAnalysisMinute.includes('reduced 상태'));
    assert.ok(debriefAnalysisMinute.includes('국내에서는 상승 상태'));
    assert.ok(debriefAnalysisMinute.includes('미국에서는 수평 상태'));
    assert.ok(debriefAnalysisMinute.includes('암호화폐에서는 하락 상태'));
    assert.ok(debriefAnalysisMinute.includes('미국과 암호화폐'));
    assert.ok(debriefAnalysisMinute.includes('전략군 24시간 신호 0건입니다.'));
    assert.ok(debriefAnalysisMinute.includes('**전략군 24시간** : 신호 0건입니다.'));
    assert.ok(debriefAnalysisMinute.includes('결정 대기: 상단 캐치업 기준입니다'));
    assert.equal(debriefAnalysisMinute.includes('안녕하세요'), false);
    assert.equal(debriefAnalysisMinute.includes('결정 대기: 상단 캐치업 기준으로 확인하세요'), false);
    assert.equal(debriefAnalysisMinute.includes('과거 발언 숫자 숨김'), false);
    assert.equal(debriefAnalysisMinute.includes('줄인'), false);
    assert.equal(debriefAnalysisMinute.includes('강세 상태'), false);
    assert.equal(debriefAnalysisMinute.includes('중립 상태'), false);
    assert.equal(debriefAnalysisMinute.includes('약세 상태'), false);
    assert.equal(debriefAnalysisMinute.includes('미국와'), false);
    assert.equal(debriefAnalysisMinute.includes('0건의 거래가 발생'), false);
    assert.equal(debriefAnalysisMinute.includes('거래가 발생하지 않았'), false);
    assert.equal(debriefAnalysisMinute.includes('서킷은 5건'), false);
    assert.ok(debriefAnalysisMinute.includes('후속 조치는 마스터 확인 후 기록합니다.'));
    assert.equal(debriefAnalysisMinute.includes('이 있습니다'), false);
    assert.equal(debriefAnalysisMinute.includes('결과적으로'), false);
    assert.equal(debriefAnalysisMinute.includes('확인하세요. ,'), false);
    assert.equal(debriefAnalysisMinute.includes('봅니다이며'), false);
    assert.equal(debriefAnalysisMinute.includes('기준입니다.국내'), false);
    assert.equal(debriefAnalysisMinute.includes('분석 결과는 다음과 같이 요약'), false);
    assert.equal(debriefAnalysisMinute.includes('다음 조치를 취해야'), false);
    assert.equal(debriefAnalysisMinute.includes('최종 결정을 내릴 수 있도록'), false);
    assert.equal(debriefAnalysisMinute.includes('최종 결정을 내릴 수 있습니다'), false);
    const inlineDebriefAnalysisMinute = _testOnly.normalizeLegacyMinuteContent(
      '결정 대기 중인 서킷은 5건입니다. 결과적으로, 국내 마감 G6 대조표의 분석 결과는 다음과 같이 요약할 수 있습니다. 국내에서는 강세 상태에 있습니다. 따라서, 국내 마감 G6 대조표에 대한 다음 조치를 취해야 합니다: 국내 마감 G6 대조표에 대한 추가 분석을 수행하고, 최종 결정을 내릴 수 있도록 하십시오.',
    );
    assert.ok(inlineDebriefAnalysisMinute.includes('결정 대기: 상단 캐치업 기준입니다. 국내에서는 상승 상태'));
    assert.equal(inlineDebriefAnalysisMinute.includes('확인하세요.국내'), false);
    assert.equal(inlineDebriefAnalysisMinute.includes('분석 결과는 다음과 같이 요약'), false);
    const compactGatePunctuationMinute = _testOnly.normalizeLegacyMinuteContent(
      '활성 서킷: 최신 데이터 영역 기준으로 확인하세요이며, 결정 대기 중인 서킷은 5건입니다.국내에서는 강세 상태에 있습니다.',
    );
    assert.ok(compactGatePunctuationMinute.includes('활성 서킷: 최신 데이터 영역 기준으로 봅니다. 결정 대기: 상단 캐치업 기준입니다. 국내에서는 상승 상태'));
    assert.equal(compactGatePunctuationMinute.includes('봅니다이며'), false);
    assert.equal(compactGatePunctuationMinute.includes('기준입니다.국내'), false);
    assert.equal(
      _testOnly.normalizeLegacyMinuteContent('국내 마감 G6 대조표에 대한 분석 결과입니다.'),
      '국내 마감 G6 대조표 분석입니다.',
    );
    const regeneratedMarkdown = renderMeetingMinutesMarkdown({
      session: { id: 117, type: 'domestic_debrief', status: 'closed', chair: 'luna' },
      minutes: [{ seq: 1, agendaKey: 'debrief:g6-plan-vs-actual', role: 'data', speaker: 'stack-adapter', content: 'G6 대조표' }],
      decisions: [{ grade: 'c_master', status: 'pending_master', agendaKey: 'debrief:g6-plan-vs-actual', decision: '확인 대기', dueAt: '2026-06-12T00:00:00.000Z' }],
      dryRun: false,
      llmCalls: 0,
      skippedLlmCalls: 0,
    });
    assert.ok(regeneratedMarkdown.startsWith('# Luna Meeting Room — 국내 장후 회의'));
    assert.equal(regeneratedMarkdown.includes('# Luna Meeting Room — domestic_debrief'), false);
    assert.ok(regeneratedMarkdown.includes('- 상태: 완료'));
    assert.ok(regeneratedMarkdown.includes('- 드라이런: 아니오'));
    assert.ok(regeneratedMarkdown.includes('- LLM 호출: 0회'));
    assert.equal(regeneratedMarkdown.includes('- status:'), false);
    assert.equal(regeneratedMarkdown.includes('- dry_run:'), false);
    assert.equal(regeneratedMarkdown.includes('- llm_calls:'), false);
    assert.ok(regeneratedMarkdown.includes('## 회의 데이터 요약'));
    assert.ok(regeneratedMarkdown.includes('## 회의록'));
    assert.ok(regeneratedMarkdown.includes('## 결정 기록(ADR)'));
    assert.equal(regeneratedMarkdown.includes('## Plan Note'), false);
    assert.equal(regeneratedMarkdown.includes('## Minutes'), false);
    assert.equal(regeneratedMarkdown.includes('## ADR'), false);
    const emptyRegeneratedMarkdown = renderMeetingMinutesMarkdown({
      session: { id: 999, type: 'morning', status: 'closed' },
      minutes: [],
      decisions: [],
      dryRun: true,
    });
    assert.ok(emptyRegeneratedMarkdown.includes('회의 데이터 요약 없음'));
    assert.ok(emptyRegeneratedMarkdown.includes('- 회의록 없음'));
    assert.equal(emptyRegeneratedMarkdown.includes('plan-note 없음'), false);
    const partialRegeneratedMarkdown = renderMeetingMinutesMarkdown({
      session: { id: 1000, type: 'morning', status: 'closed' },
      planNote: { briefMarkdown: '요약' },
      minutes: [{ content: '' }],
      decisions: [{}],
      dryRun: false,
    });
    assert.ok(partialRegeneratedMarkdown.includes('### 회의록. 안건 — 기록 / 시스템'));
    assert.ok(partialRegeneratedMarkdown.includes('내용 없음'));
    assert.ok(partialRegeneratedMarkdown.includes('결정 내용 없음 (기한: 기한 미정)'));
    assert.equal(partialRegeneratedMarkdown.includes('undefined'), false);
    assert.equal(partialRegeneratedMarkdown.includes('n/a'), false);
    assert.equal(partialRegeneratedMarkdown.includes('due:'), false);
    assert.equal(regeneratedMarkdown.includes('MR-A output is advisory/shadow only'), false);
    assert.ok(regeneratedMarkdown.includes('MR-A 산출물은 자문/섀도 전용입니다.'));
    assert.ok(regeneratedMarkdown.includes('국내 마감 G6 대조표'));
    assert.equal(regeneratedMarkdown.includes('debrief:g6-plan-vs-actual'), false);
    assert.ok(regeneratedMarkdown.includes('C 마스터 확인/마스터 액션 대기'));
    assert.equal(regeneratedMarkdown.includes('c_master/pending_master'), false);
    const regeneratedFromDb = await loadMeetingMinutesResult(117, {
      queryFn: async (sql) => {
        if (sql.includes('FROM luna_meeting_sessions')) {
          return [{
            id: 117,
            type: 'domestic_debrief',
            status: 'closed',
            chair: 'luna',
            segments: [{ market: 'domestic', active: false, reason: 'kis_market_closed' }],
            started_at: '2026-06-12T00:00:00.000Z',
            closed_at: '2026-06-12T00:05:00.000Z',
            summary: 'domestic_debrief 회의 완료: 안건 1건, ADR 1건, LLM 0회',
          }];
        }
        if (sql.includes('FROM luna_meeting_minutes')) {
          return [
            {
              id: 1171,
              session_id: 117,
              seq: 1,
              agenda_key: 'debrief:g6-plan-vs-actual',
              speaker: 'stack-adapter',
              role: 'data',
              content: [
                'gate_transitions=[{"market":"domestic","status":"halt"}]',
                'regime_transitions=[{"market":"domestic","dominant":"bull"}]',
                'errors=[]',
                'segments: [{"market":"domestic","active":false}]',
                '분석 결과는 다음과 같이 요약할 수 있습니다.',
                '따라서 최종 결정을 내릴 수 있도록 하십시오.',
              ].join('\n'),
              meta: {},
              created_at: '2026-06-12T00:00:01.000Z',
            },
            {
              id: 1172,
              session_id: 117,
              seq: 2,
              agenda_key: 'debrief:g6-plan-vs-actual',
              speaker: 'adr',
              role: 'decision',
              content: 'ADR recorded: c_master/pending_master',
              meta: {},
              created_at: '2026-06-12T00:00:02.000Z',
            },
          ];
        }
        if (sql.includes('FROM luna_meeting_decisions')) {
          return [{
            id: 1173,
            session_id: 117,
            agenda_key: 'debrief:g6-plan-vs-actual',
            decision: 'ADR recorded: c_master/pending_master',
            grade: 'c_master',
            status: 'pending_master',
            due_at: '2026-06-13T00:00:00.000Z',
            evidence: {},
            created_at: '2026-06-12T00:00:03.000Z',
          }];
        }
        return [];
      },
    });
    const regeneratedFromDbMarkdown = renderMeetingMinutesMarkdown(regeneratedFromDb);
    const regeneratedLeakText = `${regeneratedFromDb.planNote.briefMarkdown}\n${regeneratedFromDbMarkdown}`;
    assert.ok(regeneratedLeakText.includes('DB 기준 회의록 재생성: 회의 #117'));
    assert.ok(regeneratedLeakText.includes('요약: 국내 장후 회의 완료: 안건 1건, ADR 1건, LLM 0회'));
    assert.equal(regeneratedLeakText.includes('DB 기준 회의록 재생성: session #117'), false);
    assert.equal(regeneratedLeakText.includes('summary: 국내 장후 회의 완료:'), false);
    assert.equal(regeneratedLeakText.includes('summary: domestic_debrief 회의 완료:'), false);
    assert.equal(regeneratedFromDbMarkdown.includes('# Luna Meeting Room — domestic_debrief'), false);
    assert.ok(regeneratedLeakText.includes('세그먼트: 국내 비활성(장 마감)'));
    assert.ok(regeneratedLeakText.includes('국내 마감 G6 대조표'));
    assert.ok(regeneratedLeakText.includes('C 마스터 확인/마스터 액션 대기'));
    assert.equal(regeneratedLeakText.includes('segments: [{'), false);
    assert.equal(regeneratedLeakText.includes('gate_transitions=['), false);
    assert.equal(regeneratedLeakText.includes('regime_transitions=['), false);
    assert.equal(regeneratedLeakText.includes('errors=[]'), false);
    assert.equal(regeneratedLeakText.includes('"market":"domestic"'), false);
    assert.equal(regeneratedLeakText.includes('분석 결과는 다음과 같이 요약'), false);
    assert.equal(regeneratedLeakText.includes('최종 결정을 내릴 수 있도록'), false);
    assert.equal(regeneratedLeakText.includes('ADR recorded: c_master/pending_master'), false);
    const catchup = await request(baseUrl, '/api/catchup/1');
    assert.equal(catchup.payload.lines.length, 3);
    const catchupText = catchup.payload.lines.join(' / ');
    assert.ok(catchup.payload.lines[0].includes('확정 0건, 보류 0건, 대기 2건'));
    assert.ok(catchup.payload.lines[1].includes('C15 레짐 엔진 HMM:'));
    assert.ok(catchup.payload.lines[1].includes('국내 장전 계획: 자문 기록 후 마스터 확인 대기'));
    assert.equal(catchup.payload.lines[1].includes('C15 결정 대기:'), false);
    assert.equal(catchup.payload.lines[1].includes('C15 레짐 엔진 HMM: C15 레짐 엔진 HMM'), false);
    assert.equal(catchupText.includes('advisory 기록'), false);
    assert.equal(catchupText.includes('crypto 24h 점검'), false);
    assert.equal(catchupText.includes('market:crypto'), false);
    assert.equal(catchupText.includes('market:domestic'), false);
    assert.equal(catchupText.includes('regime-engine-hmm'), false);
    assert.ok(catchup.payload.lines[2].includes('회의록 5행'));
    assert.ok(catchup.payload.lines[2].includes('최신 상태 완료'));
    assert.equal(catchup.payload.lines[2].includes('n/a'), false);
    assert.equal(catchup.payload.lines[2].includes('minutes'), false);
    assert.equal(catchup.payload.lines[2].includes('최신 상태 closed'), false);
    assertNoUserVisibleRawLeaks(
      userVisibleMeetingApiText(detail.payload, catchup.payload.lines),
      'meeting detail/catchup user-visible API text',
    );
    assert.deepEqual(
      repeatedSentenceHits('동일 문장 반복을 잡습니다. 동일 문장 반복을 잡습니다. 동일 문장 반복을 잡습니다.'),
      [{ sentence: '동일 문장 반복을 잡습니다.', count: 3 }],
    );
    assertNoRepeatedSentenceRunsInBlocks(
      userVisibleMeetingApiBlocks(detail.payload, catchup.payload.lines),
      'meeting detail/catchup user-visible API text',
    );

    const pending = await request(baseUrl, '/api/decisions/pending');
    assert.deepEqual(pending.payload.decisions.map((row) => row.id), [11, 12]);
    assert.equal(pending.payload.decisions[0].decision, '자문 기록 후 마스터 확인 대기');
    assert.equal(pending.payload.decisions[0].decision.includes('C15 결정 대기:'), false);
    assert.equal(pending.payload.decisions[0].decision.includes('C15 레짐 엔진 HMM:'), false);
    assert.equal(pending.payload.decisions[0].decision.includes('regime-engine-hmm'), false);
    assert.equal(detail.payload.decisions[0].decision, '자문 기록 후 마스터 확인 대기');

    const premarketPrefixDecisions = [
      { id: 31, sessionId: 31, agendaKey: 'premarket:overseas-gate-regime', decision: '미국 프리마켓 게이트/레짐: 자문 기록 후 마스터 확인 대기', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-13T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:04.000Z' },
      { id: 32, sessionId: 31, agendaKey: 'premarket:overseas-watch', decision: '미국 보유/예정 이벤트 점검: 자문 기록 후 마스터 확인 대기', grade: 'c_master', status: 'pending_master', dueAt: '2026-06-13T00:00:00.000Z', evidence: { fixture: true }, createdAt: '2026-06-11T00:00:05.000Z' },
    ];
    const premarketPrefixStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
      ...deps,
      meetingStore: {
        listMeetings: async () => [{
          id: 31,
          type: 'us_premarket',
          status: 'closed',
          chair: 'luna',
          startedAt: '2026-06-11T00:00:00.000Z',
          closedAt: '2026-06-11T00:05:00.000Z',
          summary: 'us_premarket 회의 완료: 안건 2건, ADR 2건, LLM 0회',
          segments: [],
        }],
        getMeeting: async () => ({
          ok: true,
          session: {
            id: 31,
            type: 'us_premarket',
            status: 'closed',
            chair: 'luna',
            startedAt: '2026-06-11T00:00:00.000Z',
            closedAt: '2026-06-11T00:05:00.000Z',
            summary: 'us_premarket 회의 완료: 안건 2건, ADR 2건, LLM 0회',
            segments: [],
          },
          minutes: [
            { id: 31, sessionId: 31, seq: 1, agendaKey: 'premarket:overseas-gate-regime', speaker: 'luna', role: 'decision', content: '미국 프리마켓 게이트/레짐: 자문 기록 후 마스터 확인 대기', meta: {}, createdAt: '2026-06-11T00:00:04.000Z' },
            { id: 32, sessionId: 31, seq: 2, agendaKey: 'premarket:overseas-watch', speaker: 'luna', role: 'decision', content: '미국 보유/예정 이벤트 점검: 자문 기록 후 마스터 확인 대기', meta: {}, createdAt: '2026-06-11T00:00:05.000Z' },
          ],
          decisions: premarketPrefixDecisions,
        }),
        listPendingDecisions: async () => premarketPrefixDecisions,
      },
    });
    const premarketPrefixBase = `http://127.0.0.1:${premarketPrefixStarted.server.address().port}`;
    try {
      const premarketCatchup = await request(premarketPrefixBase, '/api/catchup/31');
      const premarketPending = await request(premarketPrefixBase, '/api/decisions/pending');
      const premarketDetail = await request(premarketPrefixBase, '/api/meetings/31');
      const premarketCatchupText = premarketCatchup.payload.lines.join(' / ');
      assert.ok(premarketCatchupText.includes('미장 전 게이트·레짐 점검: 자문 기록 후 마스터 확인 대기'));
      assert.ok(premarketCatchupText.includes('미장 전 감시 목록 점검: 자문 기록 후 마스터 확인 대기'));
      assert.equal(premarketCatchupText.includes('미장 전 게이트·레짐 점검: 미국 프리마켓 게이트/레짐:'), false);
      assert.equal(premarketCatchupText.includes('미장 전 감시 목록 점검: 미국 보유/예정 이벤트 점검:'), false);
      assert.deepEqual(premarketPending.payload.decisions.map((row) => row.decision), [
        '자문 기록 후 마스터 확인 대기',
        '자문 기록 후 마스터 확인 대기',
      ]);
      assert.deepEqual(premarketDetail.payload.minutes.map((row) => row.content), [
        '자문 기록 후 마스터 확인 대기',
        '자문 기록 후 마스터 확인 대기',
      ]);
    } finally {
      await closeServer(premarketPrefixStarted.server);
    }

    const invalidDecisionAction = await request(baseUrl, '/api/decisions/11', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ action: 'approve' }),
    });
    assert.equal(invalidDecisionAction.status, 400);
    assert.equal(invalidDecisionAction.payload.message, '지원하지 않는 결정 처리 요청입니다.');

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

    const meetingsBeforeRun = await request(baseUrl, '/api/meetings');
    assert.equal(meetingsBeforeRun.payload.activeRuns.length, 0);
    const meetingIdsBeforeRun = meetingsBeforeRun.payload.meetings.map((row) => Number(row.id));

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
    assert.equal(duplicate.payload.message, '이미 진행 중인 같은 타입 회의가 있습니다.');
    releaseRun();
    const completedRun = await waitForRun(baseUrl, start.payload.run.id);
    assert.equal(completedRun.status, 'completed');
    assert.equal(completedRun.sessionId, 2);
    assert.equal(runSessionOptions[0]?.noLlm, true);
    const meetingsAfterRun = await request(baseUrl, '/api/meetings');
    assert.equal(meetingsAfterRun.payload.activeRuns.length, 0);
    assert.equal(meetingsAfterRun.payload.meetings.length, meetingsBeforeRun.payload.meetings.length + 1);
    assert.equal(meetingsAfterRun.payload.meetings[0].id, 2);
    assert.equal(Number(meetingsAfterRun.payload.meetings[0].id), completedRun.sessionId);
    assert.deepEqual(
      meetingsAfterRun.payload.meetings.slice(1).map((row) => Number(row.id)),
      meetingIdsBeforeRun,
    );
    const completedRunDetail = await request(baseUrl, `/api/meetings/${start.payload.run.id}`);
    assert.equal(completedRunDetail.payload.run.status, 'completed');
    assert.equal(completedRunDetail.payload.run.sessionId, 2);
    const completedMeetingDetail = await request(baseUrl, '/api/meetings/2');
    assert.equal(completedMeetingDetail.payload.minutes.length, 1);
    const completedMeetingCatchup = await request(baseUrl, '/api/catchup/2');
    assert.ok(completedMeetingCatchup.payload.lines[0].includes('확정 0건, 보류 0건, 대기 0건'));

    const missingMeeting = await request(baseUrl, '/api/meetings/999999');
    assert.equal(missingMeeting.status, 404);
    assert.equal(missingMeeting.payload.message, '회의 999999를 찾을 수 없습니다.');
    const wrongStartMethod = await request(baseUrl, '/api/meetings/start');
    assert.equal(wrongStartMethod.status, 405);
    assert.equal(wrongStartMethod.payload.message, '지원하지 않는 요청 방식입니다.');
    assert.equal(wrongStartMethod.payload.error, 'method_not_allowed');
    assert.equal(wrongStartMethod.headers.get('allow'), 'POST');
    assert.equal(wrongStartMethod.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(wrongStartMethod.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(wrongStartMethod.headers.get('x-frame-options'), 'DENY');
    assert.ok(wrongStartMethod.headers.get('permissions-policy')?.includes('camera=()'));
    assert.ok(wrongStartMethod.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    const invalidMeetingId = await request(baseUrl, '/api/meetings/not-a-meeting-id');
    assert.equal(invalidMeetingId.status, 404);
    assert.equal(invalidMeetingId.payload.message, '회의 not-a-meeting-id를 찾을 수 없습니다.');
    assert.equal(invalidMeetingId.payload.error, 'meeting_not_found');
    const invalidCatchupId = await request(baseUrl, '/api/catchup/start');
    assert.equal(invalidCatchupId.status, 404);
    assert.equal(invalidCatchupId.payload.message, '회의 start를 찾을 수 없습니다.');
    const wrongDecisionMethod = await request(baseUrl, '/api/decisions/11');
    assert.equal(wrongDecisionMethod.status, 405);
    assert.equal(wrongDecisionMethod.payload.message, '지원하지 않는 요청 방식입니다.');
    const wrongAskMethod = await request(baseUrl, '/api/agents/ask');
    assert.equal(wrongAskMethod.status, 405);
    assert.equal(wrongAskMethod.payload.message, '지원하지 않는 요청 방식입니다.');

    const emptyQuestion = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '' }),
    });
    assert.equal(emptyQuestion.status, 400);
    assert.equal(emptyQuestion.payload.message, '질문을 입력하세요.');

    const invalidJson = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.payload.message, '요청 형식이 올바르지 않습니다.');

    const invalidAgent = await request(baseUrl, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'unknown-agent', question: '테스트' }),
    });
    assert.equal(invalidAgent.status, 400);
    assert.equal(invalidAgent.payload.error, 'invalid_agent');
    assert.equal(invalidAgent.payload.message, '지원하지 않는 에이전트입니다. 목록에서 에이전트를 선택하세요.');

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
    assert.ok(ask1.payload.text.includes('회의 데이터 요약'));
    assert.equal(ask1.payload.text.includes('회의 회의 데이터 요약'), false);
    assert.ok(ask1.payload.text.includes('국내와 미국은'));
    assert.ok(ask1.payload.text.includes('암호화폐는'));
    assert.ok(ask1.payload.text.includes('게이트가 halt 상태'));
    assert.ok(ask1.payload.text.includes('게이트가 reduced 상태'));
    assert.ok(ask1.payload.text.includes('각각 halt, reduced, reduced 상태'));
    assert.ok(ask1.payload.text.includes('국내는 halt 상태'));
    assert.ok(ask1.payload.text.includes('암호화폐는 full 상태'));
    assert.equal(ask1.payload.text.includes('중단, 감소'), false);
    assert.equal(ask1.payload.text.includes('진행이 중단된 상태'), false);
    assert.equal(ask1.payload.text.includes('중단된 상태'), false);
    assert.equal(ask1.payload.text.includes('중단 상태'), false);
    assert.equal(ask1.payload.text.includes('최대 상태'), false);
    assert.equal(ask1.payload.text.includes('완전한 상태'), false);
    assert.equal(ask1.payload.text.includes('미국는'), false);
    assert.equal(ask1.payload.route, undefined);
    assert.equal(ask1.payload.text.includes('plan-note'), false);
    assert.equal(ask1.payload.text.includes('domestic'), false);
    assert.equal(ask1.payload.text.includes('overseas'), false);
    assert.equal(ask1.payload.text.includes('crypto'), false);
    assert.equal(ask1.payload.text.includes('국내과'), false);
    assert.equal(ask1.payload.text.includes('정지 상태'), false);
    assert.equal(ask1.payload.text.includes('감소한 상태'), false);
    assert.equal(ask1.payload.text.includes('감소한 상태로'), false);
    assert.ok(ask2.payload.text.includes('Aria 자문: 비용 없는 규칙 기반 자문입니다.'));
    assert.equal(ask2.payload.text.includes('[Aria]'), false);
    assert.ok(ask2.payload.text.includes('기술 관점 우선 확인:'));
    assert.ok(ask2.payload.text.includes('즉시 눈에 띄는 경보 없음'));
    assert.equal(ask2.payload.text.includes('전역 결정 대기 2건'), false);
    assert.ok(ask2.payload.text.includes('권장 다음 행동:'));
    assert.equal(ask2.payload.text.includes('질문을 확인했습니다'), false);
    assert.equal(ask2.payload.text.includes('질문은 기록만 합니다'), false);
    assert.equal(ask2.payload.text.includes('LLM 비활성'), false);
    assert.equal(ask2.payload.text.includes('noLLM route'), false);
    assert.equal(ask2.payload.provider, 'rule_based');
    assert.equal(ask2.payload.route, undefined);
    assert.equal(ask3.status, 429);
    assert.equal(ask3.payload.message, '분당 질의 한도에 도달했습니다. 1분 후 다시 시도하세요.');
  } finally {
    await closeServer(started.server);
  }

  const expandedNoLlmStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    resolveAgentLLMRouteFn: (agent) => ({
      primary: `investment.${agent}`,
      selectorKey: `investment.${agent}`,
      fallbacks: [],
      noLLM: true,
    }),
  });
  const expandedNoLlmBase = `http://127.0.0.1:${expandedNoLlmStarted.server.address().port}`;
  try {
    const noLlmAsk = await request(expandedNoLlmBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'hephaestos', question: '체결 관점 요약' }),
    });
    assert.equal(noLlmAsk.status, 200);
    assert.ok(noLlmAsk.payload.text.includes('Hephaestos 자문: 비용 없는 규칙 기반 자문입니다.'));
    assert.equal(noLlmAsk.payload.text.includes('[Hephaestos]'), false);
    assert.ok(noLlmAsk.payload.text.includes('체결 관점 우선 확인:'));
    assert.ok(noLlmAsk.payload.text.includes('즉시 눈에 띄는 경보 없음'));
    assert.equal(noLlmAsk.payload.text.includes('전역 결정 대기 2건'), false);
    assert.ok(noLlmAsk.payload.text.includes('권장 다음 행동:'));
    assert.equal(noLlmAsk.payload.text.includes('질문을 확인했습니다'), false);
    assert.equal(noLlmAsk.payload.text.includes('질문은 기록만 합니다'), false);
    assert.equal(noLlmAsk.payload.text.includes('LLM 비활성'), false);
    assert.equal(noLlmAsk.payload.text.includes('[hephaestos]'), false);
    assert.equal(noLlmAsk.payload.text.includes('noLLM route'), false);
    assert.equal(noLlmAsk.payload.provider, 'rule_based');
    assert.equal(noLlmAsk.payload.route, undefined);
  } finally {
    await closeServer(expandedNoLlmStarted.server);
  }

  let decisionScopeHubCalled = false;
  const decisionScopeStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: {
      listMeetings: async () => [{
        id: 7,
        type: 'us_premarket',
        status: 'closed',
        chair: 'luna',
        startedAt: '2026-06-12T13:00:03.000Z',
        closedAt: '2026-06-12T13:00:04.000Z',
        summary: 'fixture',
        segments: [],
      }],
      getMeeting: async () => ({
        ok: true,
        session: {
          id: 7,
          type: 'us_premarket',
          status: 'closed',
          chair: 'luna',
          startedAt: '2026-06-12T13:00:03.000Z',
          closedAt: '2026-06-12T13:00:04.000Z',
          summary: 'fixture',
          segments: [],
        },
        minutes: [],
        decisions: [
          { id: 701, status: 'pending_master', decision: '대기 1', agendaKey: 'premarket:overseas-gate-regime' },
          { id: 702, status: 'pending_master', decision: '대기 2', agendaKey: 'premarket:overseas-watch' },
          { id: 703, status: 'confirmed', decision: '확정', agendaKey: 'session' },
        ],
      }),
      listPendingDecisions: async () => Array.from({ length: 16 }, (_unused, index) => ({
        id: 800 + index,
        sessionId: index < 2 ? 7 : 1,
        agendaKey: 'market:domestic',
        decision: '자문 기록 후 마스터 확인 대기',
        grade: 'c_master',
        status: 'pending_master',
        dueAt: '2026-06-12T00:00:00.000Z',
        evidence: {},
        createdAt: '2026-06-11T00:00:00.000Z',
      })),
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      decisionScopeHubCalled = true;
      return { ok: true, provider: 'fixture', text: '선택 회의 캐치업의 결정 대기는 5건입니다.' };
    },
  });
  const decisionScopeBase = `http://127.0.0.1:${decisionScopeStarted.server.address().port}`;
  try {
    const decisionScopeAsk = await request(decisionScopeBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        agent: 'luna',
        question: '전체 결정 대기함과 선택 회의 캐치업의 대기 숫자가 왜 달라?',
        selectedMeetingId: 7,
      }),
    });
    assert.equal(decisionScopeAsk.status, 200);
    assert.equal(decisionScopeAsk.payload.provider, 'rule_based');
    assert.equal(decisionScopeAsk.payload.skipped, true);
    assert.equal(decisionScopeHubCalled, false);
    assert.ok(decisionScopeAsk.payload.text.includes('전체 결정 대기함 16건'));
    assert.ok(decisionScopeAsk.payload.text.includes('선택 회의 #7 미장 전 회의 캐치업 대기 2건'));
    assert.ok(decisionScopeAsk.payload.text.includes('오른쪽 전체 결정 대기함은 회의 전체 범위'));
    assert.ok(decisionScopeAsk.payload.text.includes('상단 U1 캐치업은 현재 선택한 회의 범위'));
    assert.equal(decisionScopeAsk.payload.text.includes('pending_master'), false);
    assert.equal(decisionScopeAsk.payload.text.includes('c_master'), false);
    assert.equal(decisionScopeAsk.payload.text.includes('5건'), false);
  } finally {
    await closeServer(decisionScopeStarted.server);
  }

  let decisionDueHubCalled = false;
  const decisionDueTodayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const decisionDueYesterdayKst = new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const decisionDueIso = (dateKey: string, time: string) => new Date(`${dateKey}T${time}+09:00`).toISOString();
  const decisionDueRows = [
    ...Array.from({ length: 9 }, (_unused, index) => ({
      id: 900 + index,
      sessionId: 1,
      sessionType: 'morning',
      agendaKey: index === 0 ? 'market:domestic' : 'decision:regime-engine-hmm',
      decision: '자문 기록 후 마스터 확인 대기',
      grade: 'c_master',
      status: 'pending_master',
      dueAt: decisionDueIso(decisionDueYesterdayKst, '23:43:59.419'),
      evidence: {},
      createdAt: '2026-06-11T00:00:00.000Z',
    })),
    ...Array.from({ length: 7 }, (_unused, index) => ({
      id: 950 + index,
      sessionId: 7,
      sessionType: 'us_premarket',
      agendaKey: index === 0 ? 'premarket:overseas-gate-regime' : 'premarket:overseas-watch',
      decision: '자문 기록 후 마스터 확인 대기',
      grade: 'c_master',
      status: 'pending_master',
      dueAt: decisionDueIso(decisionDueTodayKst, '16:00:03.783'),
      evidence: {},
      createdAt: '2026-06-12T00:00:00.000Z',
    })),
  ];
  const decisionDueStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: {
      listMeetings: async () => [],
      getMeeting: async () => ({ ok: true, session: {}, minutes: [], decisions: [] }),
      listPendingDecisions: async () => decisionDueRows,
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      decisionDueHubCalled = true;
      return { ok: true, provider: 'fixture', text: '오늘 처리할 마스터 결정은 5건입니다.' };
    },
  });
  const decisionDueBase = `http://127.0.0.1:${decisionDueStarted.server.address().port}`;
  try {
    const decisionDueAsk = await request(decisionDueBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        agent: 'luna',
        question: '오늘 처리해야 할 마스터 결정은 몇 건이고 뭐부터 봐야 해?',
      }),
    });
    assert.equal(decisionDueAsk.status, 200);
    assert.equal(decisionDueAsk.payload.provider, 'rule_based');
    assert.equal(decisionDueAsk.payload.skipped, true);
    assert.equal(decisionDueHubCalled, false);
    assert.ok(decisionDueAsk.payload.text.includes('전체 대기 16건'));
    assert.ok(decisionDueAsk.payload.text.includes('기한 경과 9건'));
    assert.ok(decisionDueAsk.payload.text.includes('오늘 기한 7건'));
    assert.ok(decisionDueAsk.payload.text.includes('우선 확인: 회의 #1 국내 장전 계획'));
    assert.ok(decisionDueAsk.payload.text.includes('기한 경과 항목을 먼저'));
    assert.equal(decisionDueAsk.payload.text.includes('pending_master'), false);
    assert.equal(decisionDueAsk.payload.text.includes('c_master'), false);
    assert.equal(decisionDueAsk.payload.text.includes('오늘 처리할 마스터 결정은 5건'), false);
  } finally {
    await closeServer(decisionDueStarted.server);
  }

  let scheduleHubCalled = false;
  const scheduleStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# schedule fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      scheduleHubCalled = true;
      return { ok: true, provider: 'fixture', text: '주말 회의는 海外와 암호화폐 시장만 확인합니다.' };
    },
  });
  const scheduleBase = `http://127.0.0.1:${scheduleStarted.server.address().port}`;
  try {
    const scheduleAsk = await request(scheduleBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '주말 회의는 어떤 시장만 확인해?' }),
    });
    assert.equal(scheduleAsk.status, 200);
    assert.equal(scheduleAsk.payload.provider, 'rule_based');
    assert.equal(scheduleAsk.payload.skipped, true);
    assert.equal(scheduleHubCalled, false);
    assert.ok(scheduleAsk.payload.text.includes('정례 05:00 주말 morning은 국내·미국을 주말로 스킵'));
    assert.ok(scheduleAsk.payload.text.includes('수동 시작은 현재 화면의 세그먼트 상태를 기준'));
    assert.ok(scheduleAsk.payload.text.includes('현재 회의 대상 세그먼트가 안건으로 포함'));
    assert.ok(scheduleAsk.payload.text.includes('정례 실행 상태:'));
    assert.ok(scheduleAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.ok(scheduleAsk.payload.text.includes('미국 회의 대상(장중)'));
    assert.ok(scheduleAsk.payload.text.includes('암호화폐 회의 대상(24시간 운영)'));
    assert.equal(scheduleAsk.payload.text.includes('海外'), false);
    const mixedScheduleAsk = await request(scheduleBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '지금 토요일 새벽인데 미장 전 회의를 수동으로 시작해도 돼?' }),
    });
    assert.equal(mixedScheduleAsk.status, 200);
    assert.equal(mixedScheduleAsk.payload.provider, 'rule_based');
    assert.equal(scheduleHubCalled, false);
    assert.ok(mixedScheduleAsk.payload.text.includes('운영 기준:'));
    assert.ok(mixedScheduleAsk.payload.text.includes('정례 실행 상태:'));
    assert.ok(mixedScheduleAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.equal(mixedScheduleAsk.payload.text.includes('운영 총괄 관점 우선 확인:'), false);
  } finally {
    await closeServer(scheduleStarted.server);
  }

  let scheduleOpsHubCalled = false;
  const scheduleOpsStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# schedule ops fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: false, skipped: true, reason: 'weekend' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    meetingStore: {
      ...deps.meetingStore,
      listMeetings: async () => [],
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      scheduleOpsHubCalled = true;
      return { ok: true, provider: 'fixture', text: '정례 실패는 담당자에게 문의하세요.' };
    },
  });
  const scheduleOpsBase = `http://127.0.0.1:${scheduleOpsStarted.server.address().port}`;
  try {
    const scheduleOpsAsk = await request(scheduleOpsBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '05:00 정례 회의가 실패하면 어디서 확인하고 무엇을 보면 돼?' }),
    });
    assert.equal(scheduleOpsAsk.status, 200);
    assert.equal(scheduleOpsAsk.payload.provider, 'rule_based');
    assert.equal(scheduleOpsAsk.payload.skipped, true);
    assert.equal(scheduleOpsHubCalled, false);
    assert.ok(scheduleOpsAsk.payload.text.includes('05:00 정례 실패 확인 순서:'));
    assert.ok(scheduleOpsAsk.payload.text.includes('새 아침 통합 회의가 생성됐는지 확인'));
    assert.ok(scheduleOpsAsk.payload.text.includes('launchctl print gui/$(id -u)/ai.luna.meeting-morning-0500 명령'));
    assert.ok(scheduleOpsAsk.payload.text.includes('/Users/alexlee/.ai-agent-system/logs/luna-meeting-morning.log'));
    assert.ok(scheduleOpsAsk.payload.text.includes('/Users/alexlee/.ai-agent-system/logs/luna-meeting-morning-error.log'));
    assert.ok(scheduleOpsAsk.payload.text.includes('정례 실행 상태:'));
    assert.ok(scheduleOpsAsk.payload.text.includes('secret이나 토큰 값을 붙여 공유하지 말고'));
    assert.equal(scheduleOpsAsk.payload.text.includes('`launchctl print'), false);
    assert.equal(scheduleOpsAsk.payload.text.includes('`/Users/alexlee/.ai-agent-system/logs'), false);
    assert.equal(scheduleOpsAsk.payload.text.includes('HUB_AUTH_TOKEN'), false);
    assert.equal(scheduleOpsAsk.payload.text.includes('Bearer'), false);
  } finally {
    await closeServer(scheduleOpsStarted.server);
  }

  let meetingTargetScheduleHubCalled = false;
  const meetingTargetScheduleStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# meeting target schedule fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      meetingTargetScheduleHubCalled = true;
      return { ok: true, provider: 'fixture', text: '미장 전 회의 분석만 확인하세요.' };
    },
  });
  const meetingTargetScheduleBase = `http://127.0.0.1:${meetingTargetScheduleStarted.server.address().port}`;
  try {
    const meetingTargetScheduleAsk = await request(meetingTargetScheduleBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '토요일인데 왜 미장 전 회의는 회의 대상이야?' }),
    });
    assert.equal(meetingTargetScheduleAsk.status, 200);
    assert.equal(meetingTargetScheduleAsk.payload.provider, 'rule_based');
    assert.equal(meetingTargetScheduleHubCalled, false);
    assert.ok(meetingTargetScheduleAsk.payload.text.includes('운영 기준:'));
    assert.ok(meetingTargetScheduleAsk.payload.text.includes('수동 시작은 현재 화면의 세그먼트 상태를 기준'));
    assert.ok(meetingTargetScheduleAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.ok(meetingTargetScheduleAsk.payload.text.includes('미국 회의 대상(장중)'));
    assert.ok(meetingTargetScheduleAsk.payload.text.includes('거래·파라미터는 변경하지 않습니다.'));
    assert.equal(meetingTargetScheduleAsk.payload.text.includes('운영 총괄 관점 우선 확인:'), false);
  } finally {
    await closeServer(meetingTargetScheduleStarted.server);
  }

  let meetingFreshnessHubCalled = false;
  const meetingFreshnessStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: {
      ...store,
      listMeetings: async () => [
        { id: 143, type: 'us_premarket', status: 'closed', startedAt: '2026-06-12T13:00:03.000Z', summary: '미장 전 회의 완료' },
        { id: 119, type: 'morning', status: 'closed', startedAt: '2026-06-12T11:15:44.000Z', summary: '아침 통합 회의 완료' },
      ],
    },
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# meeting freshness fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      meetingFreshnessHubCalled = true;
      return { ok: true, provider: 'fixture', text: '미장 전 회의 분석만 확인하세요.' };
    },
  });
  const meetingFreshnessBase = `http://127.0.0.1:${meetingFreshnessStarted.server.address().port}`;
  try {
    const meetingFreshnessAsk = await request(meetingFreshnessBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '최신 회의가 왜 어제 미장 전 회의야?' }),
    });
    assert.equal(meetingFreshnessAsk.status, 200);
    assert.equal(meetingFreshnessAsk.payload.provider, 'rule_based');
    assert.equal(meetingFreshnessHubCalled, false);
    assert.ok(meetingFreshnessAsk.payload.text.includes('정례 실행 상태:'));
    assert.ok(meetingFreshnessAsk.payload.text.includes('최신 아침 통합 회의: #119'));
    assert.ok(meetingFreshnessAsk.payload.text.includes('최신 전체 회의: #143 미장 전 회의'));
    assert.ok(meetingFreshnessAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.equal(meetingFreshnessAsk.payload.text.includes('운영 총괄 관점 우선 확인:'), false);
  } finally {
    await closeServer(meetingFreshnessStarted.server);
  }

  let morningManualHubCalled = false;
  const morningManualStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# morning manual fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      morningManualHubCalled = true;
      return { ok: true, provider: 'fixture', text: '아침 통합 회의 안건에는 전역 결정 대기함의 5건이 포함됩니다.' };
    },
  });
  const morningManualBase = `http://127.0.0.1:${morningManualStarted.server.address().port}`;
  try {
    const morningManualScheduleAsk = await request(morningManualBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '지금 아침 통합 회의를 수동 시작하면 어떤 안건이 포함돼?' }),
    });
    assert.equal(morningManualScheduleAsk.status, 200);
    assert.equal(morningManualScheduleAsk.payload.provider, 'rule_based');
    assert.equal(morningManualHubCalled, false);
    assert.ok(morningManualScheduleAsk.payload.text.includes('수동 시작 범위: 현재 회의 대상 세그먼트가 안건으로 포함'));
    assert.ok(morningManualScheduleAsk.payload.text.includes('수동 시작 의미: 회의록과 ADR을 새로 남기는 동작'));
    assert.ok(morningManualScheduleAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.ok(morningManualScheduleAsk.payload.text.includes('미국 회의 대상(장중)'));
    assert.ok(morningManualScheduleAsk.payload.text.includes('암호화폐 회의 대상(24시간 운영)'));
    assert.equal(morningManualScheduleAsk.payload.text.includes('전역 결정 대기함의 5건'), false);
  } finally {
    await closeServer(morningManualStarted.server);
  }

  let startButtonHubCalled = false;
  const startButtonStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# start button fixture',
      segments: [
        { market: 'domestic', active: false, skipped: true, reason: 'weekend' },
        { market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' },
        { market: 'crypto', active: true, skipped: false, reason: 'crypto_24h' },
      ],
    }),
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      startButtonHubCalled = true;
      return { ok: true, provider: 'fixture', text: '전역 결정 대기함 16건을 먼저 처리하세요.' };
    },
  });
  const startButtonBase = `http://127.0.0.1:${startButtonStarted.server.address().port}`;
  try {
    const startButtonAsk = await request(startButtonBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '회의 시작 버튼이 활성인데 지금 눌러도 돼?' }),
    });
    assert.equal(startButtonAsk.status, 200);
    assert.equal(startButtonAsk.payload.provider, 'rule_based');
    assert.equal(startButtonHubCalled, false);
    assert.ok(startButtonAsk.payload.text.includes('수동 시작 의미: 회의록과 ADR을 새로 남기는 동작'));
    assert.ok(startButtonAsk.payload.text.includes('거래·파라미터는 변경하지 않습니다'));
    assert.ok(startButtonAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.ok(startButtonAsk.payload.text.includes('미국 회의 대상(장중)'));
    assert.ok(startButtonAsk.payload.text.includes('암호화폐 회의 대상(24시간 운영)'));
    assert.equal(startButtonAsk.payload.text.includes('전역 결정 대기함 16건을 먼저 처리'), false);
    const disabledDomesticAsk = await request(startButtonBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '국내 장후 회의가 왜 비활성이지?' }),
    });
    assert.equal(disabledDomesticAsk.status, 200);
    assert.equal(disabledDomesticAsk.payload.provider, 'rule_based');
    assert.equal(startButtonHubCalled, false);
    assert.ok(disabledDomesticAsk.payload.text.includes('비활성 표시 해석: 괄호 사유가 붙은 회의 타입은 현재 직접 시작할 수 없고'));
    assert.ok(disabledDomesticAsk.payload.text.includes('현재 수동 실행 화면 기준: 국내 비활성(주말)'));
    assert.equal(disabledDomesticAsk.payload.text.includes('G0 게이트'), false);
    assert.equal(disabledDomesticAsk.payload.text.includes('halt(33)'), false);
  } finally {
    await closeServer(startButtonStarted.server);
  }

  const latestPreviousMorning = [{
    id: 119,
    type: 'morning',
    status: 'closed',
    startedAt: '2026-06-12T11:15:44.000Z',
  }];
  const beforeWeekendSchedule = _testOnly.buildScheduleExecutionStatus(
    latestPreviousMorning,
    new Date('2026-06-12T16:09:00.000Z'),
  );
  assert.ok(beforeWeekendSchedule.includes('오늘 05:00 KST 전이라 아직 실행 전입니다.'));
  assert.ok(beforeWeekendSchedule.includes('최신 아침 통합 회의: #119'));
  assert.equal(beforeWeekendSchedule.includes('morning 회의'), false);

  const missingAfterWeekendSchedule = _testOnly.buildScheduleExecutionStatus(
    latestPreviousMorning,
    new Date('2026-06-12T21:30:00.000Z'),
  );
  assert.ok(missingAfterWeekendSchedule.includes('오늘 05:00 KST가 지났지만 오늘 아침 통합 회의 기록은 아직 없습니다.'));

  const completedWeekendSchedule = _testOnly.buildScheduleExecutionStatus(
    [{
      id: 201,
      type: 'morning',
      status: 'closed',
      startedAt: '2026-06-12T20:05:00.000Z',
    }, ...latestPreviousMorning],
    new Date('2026-06-12T21:30:00.000Z'),
  );
  assert.ok(completedWeekendSchedule.includes('오늘 아침 통합 회의 #201'));
  assert.ok(completedWeekendSchedule.includes('완료 상태로 기록됐습니다.'));

  let premarketHubCalled = false;
  let premarketPlanNoteType = null;
  const premarketStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    buildMeetingPlanNoteFn: async ({ type }) => {
      premarketPlanNoteType = type;
      return {
        ok: true,
        briefMarkdown: '# premarket fixture',
        gates: [
          { market: 'overseas', deployment: 'reduced', score: 47 },
          { market: 'crypto', deployment: 'full', score: 72 },
        ],
        regimes: [{ market: 'overseas', current_regime: 'sideways' }],
        strategySignals: [{ signal_type: 'exit' }],
        circuitLocks: [{ circuit: 'low_profit_symbol', symbol: 'AAPL' }],
        segments: [{ market: 'overseas', active: true, skipped: false, reason: 'kis_market_open' }],
      };
    },
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      premarketHubCalled = true;
      return { ok: true, provider: 'fixture', text: '전역 결정 대기함만 확인하세요.' };
    },
  });
  const premarketBase = `http://127.0.0.1:${premarketStarted.server.address().port}`;
  try {
    const premarketAsk = await request(premarketBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '미장 전 회의 기준으로 지금 무엇을 확인해야 해?' }),
    });
    assert.equal(premarketAsk.status, 200);
    assert.equal(premarketAsk.payload.provider, 'rule_based');
    assert.equal(premarketAsk.payload.skipped, true);
    assert.equal(premarketHubCalled, false);
    assert.equal(premarketPlanNoteType, 'us_premarket');
    assert.ok(premarketAsk.payload.text.includes('운영 총괄 관점 우선 확인: 시장 게이트 미국 reduced 47점 · 암호화폐 full 72점'));
    assert.ok(premarketAsk.payload.text.includes('레짐 미국 수평'));
    assert.ok(premarketAsk.payload.text.includes('최근 전략 신호 1건(진입 0건)'));
    assert.ok(premarketAsk.payload.text.includes('활성 서킷 1건'));
    assert.ok(premarketAsk.payload.text.includes('미장 전 회의는 미국 게이트·레짐을 먼저 보고'));
    assert.equal(premarketAsk.payload.text.includes('전역 결정 대기함만 확인'), false);
    assert.equal(premarketAsk.payload.text.includes('us_premarket'), false);
    assert.equal(premarketAsk.payload.text.includes('route'), false);
  } finally {
    await closeServer(premarketStarted.server);
  }

  let telegramHubCalled = false;
  const telegramStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      telegramHubCalled = true;
      return { ok: true, provider: 'fixture', text: '텔레그램 버튼으로 확정하면 웹도 바로 갱신됩니다.' };
    },
  });
  const telegramBase = `http://127.0.0.1:${telegramStarted.server.address().port}`;
  try {
    const telegramAsk = await request(telegramBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '텔레그램 버튼으로 확정하면 웹 결정 대기함도 바로 갱신돼?' }),
    });
    assert.equal(telegramAsk.status, 200);
    assert.equal(telegramAsk.payload.provider, 'rule_based');
    assert.equal(telegramAsk.payload.skipped, true);
    assert.equal(telegramHubCalled, false);
    assert.ok(telegramAsk.payload.text.includes('회의실 승인 경로를 거쳐 웹과 같은 결정 처리 경로'));
    assert.ok(telegramAsk.payload.text.includes('폴링 또는 새로고침으로 갱신'));
    assert.ok(telegramAsk.payload.text.includes('자동 검증과 운영 경로 검증은 통과'));
    assert.ok(telegramAsk.payload.text.includes('실제 Telegram 앱 버튼 클릭은 첫 실사용 시 한 번 더 확인'));
    assert.equal(telegramAsk.payload.text.includes('Hub callback'), false);
    assert.equal(telegramAsk.payload.text.includes('HTTP 검증'), false);
    assert.equal(telegramAsk.payload.text.includes('callback_data'), false);
    assert.equal(telegramAsk.payload.text.includes('callback_query'), false);
    assert.equal(telegramAsk.payload.text.includes('changed_via'), false);
    assert.equal(telegramAsk.payload.text.includes('route'), false);

    telegramHubCalled = false;
    const genericSyncAsk = await request(telegramBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '웹 폴링 동기화 상태만 설명해줘' }),
    });
    assert.equal(genericSyncAsk.status, 200);
    assert.equal(genericSyncAsk.payload.provider, 'fixture');
    assert.equal(genericSyncAsk.payload.skipped, undefined);
    assert.equal(telegramHubCalled, true);
  } finally {
    await closeServer(telegramStarted.server);
  }

  const pendingAwareStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: createMemoryStore(),
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# fixture plan-note',
      pendingDecisions: [{ component: 'regime-engine-hmm' }],
      gates: [
        { market: 'domestic', deployment: 'halt', score: 33 },
        { market: 'overseas', deployment: 'reduced', score: 47 },
      ],
      regimes: [{ market: 'domestic', current_regime: 'bear' }],
      strategySignals: [{ signal_type: 'entry' }],
      circuitLocks: [{ circuit: 'low_profit_symbol' }],
    }),
    resolveAgentLLMRouteFn: () => ({
      primary: 'investment.aria',
      selectorKey: 'investment.aria',
      fallbacks: [],
      noLLM: true,
    }),
  });
  const pendingAwareBase = `http://127.0.0.1:${pendingAwareStarted.server.address().port}`;
  try {
    const pendingAwareAsk = await request(pendingAwareBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'aria', question: '현재 결정 대기함 핵심' }),
    });
    assert.equal(pendingAwareAsk.status, 200);
    assert.ok(pendingAwareAsk.payload.text.includes('Aria 자문: 비용 없는 규칙 기반 자문입니다.'));
    assert.equal(pendingAwareAsk.payload.text.includes('[Aria]'), false);
    assert.ok(pendingAwareAsk.payload.text.includes('전역 결정 대기 2건'));
    assert.ok(pendingAwareAsk.payload.text.includes('근거 상세와 활성 서킷 근거'));
    assert.equal(pendingAwareAsk.payload.text.includes('근거 JSON과 활성 서킷 근거'), false);
    assert.ok(pendingAwareAsk.payload.text.includes('권장 다음 행동:'));
    assert.equal(pendingAwareAsk.payload.text.includes('질문을 확인했습니다'), false);
    assert.equal(pendingAwareAsk.payload.text.includes('noLLM route'), false);
    assert.equal(pendingAwareAsk.payload.provider, 'rule_based');
    const gateIntentAsk = await request(pendingAwareBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'aria', question: '시장 게이트 기준으로 먼저 볼 것은?' }),
    });
    assert.equal(gateIntentAsk.status, 200);
    assert.ok(gateIntentAsk.payload.text.includes('기술 관점 우선 확인: 시장 게이트 국내 halt 33점 · 미국 reduced 47점'));
    assert.ok(gateIntentAsk.payload.text.includes('전역 결정 대기 2건'));
    assert.ok(gateIntentAsk.payload.text.includes('먼저 halt/reduced 시장의 근거'));
    assert.equal(gateIntentAsk.payload.text.includes('질문을 확인했습니다'), false);
    const noStrategySignalStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
      ...deps,
      meetingStore: {
        ...createMemoryStore(),
        listPendingDecisions: async () => [],
      },
      buildMeetingPlanNoteFn: async () => ({
        ok: true,
        briefMarkdown: '# fixture plan-note',
        pendingDecisions: [],
        gates: [{ market: 'domestic', deployment: 'halt', score: 33 }],
        regimes: [{ market: 'domestic', current_regime: 'bear' }],
        strategySignals: [],
        circuitLocks: [],
      }),
      resolveAgentLLMRouteFn: () => ({ noLLM: true }),
    });
    try {
      const noStrategyBase = `http://127.0.0.1:${noStrategySignalStarted.server.address().port}`;
      const noStrategyAsk = await request(noStrategyBase, '/api/agents/ask', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ agent: 'aria', question: '전략 신호 관점에서 유의할 것은?' }),
      });
      assert.equal(noStrategyAsk.status, 200);
      assert.ok(noStrategyAsk.payload.text.includes('기술 관점 우선 확인: 최근 전략 신호 0건(진입 0건)'));
      assert.ok(noStrategyAsk.payload.text.includes('전략 신호가 부족하면'));
    } finally {
      await closeServer(noStrategySignalStarted.server);
    }
    const nonEntryStrategyStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
      ...deps,
      meetingStore: {
        ...createMemoryStore(),
        listPendingDecisions: async () => [],
      },
      buildMeetingPlanNoteFn: async () => ({
        ok: true,
        briefMarkdown: '# fixture plan-note',
        pendingDecisions: [],
        gates: [{ market: 'domestic', deployment: 'halt', score: 33 }],
        regimes: [{ market: 'domestic', current_regime: 'bear' }],
        strategySignals: [{ signal_type: 'exit' }],
        circuitLocks: [],
      }),
      resolveAgentLLMRouteFn: () => ({ noLLM: true }),
    });
    try {
      const nonEntryStrategyBase = `http://127.0.0.1:${nonEntryStrategyStarted.server.address().port}`;
      const nonEntryStrategyAsk = await request(nonEntryStrategyBase, '/api/agents/ask', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ agent: 'aria', question: '전략 신호 관점에서 유의할 것은?' }),
      });
      assert.equal(nonEntryStrategyAsk.status, 200);
      assert.ok(nonEntryStrategyAsk.payload.text.includes('기술 관점 우선 확인: 최근 전략 신호 1건(진입 0건)'));
      assert.ok(nonEntryStrategyAsk.payload.text.includes('최근 전략 신호 중 진입이 없으므로 신규 진입보다 청산·무효화·관찰 신호인지 먼저 확인하세요.'));
      assert.equal(nonEntryStrategyAsk.payload.text.includes('entry가 없으므로'), false);
      assert.equal(nonEntryStrategyAsk.payload.text.includes('exit/invalidate'), false);
    } finally {
      await closeServer(nonEntryStrategyStarted.server);
    }
  } finally {
    await closeServer(pendingAwareStarted.server);
  }

  const circuitIntentStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    meetingStore: {
      ...createMemoryStore(),
      listPendingDecisions: async () => [],
    },
    buildMeetingPlanNoteFn: async () => ({
      ok: true,
      briefMarkdown: '# fixture plan-note',
      pendingDecisions: [],
      gates: [{ market: 'domestic', deployment: 'halt', score: 33 }],
      regimes: [],
      strategySignals: [],
      circuitLocks: [{ circuit: 'low_profit_symbol', symbol: 'BTC/USDT' }],
    }),
    resolveAgentLLMRouteFn: () => ({ noLLM: true }),
  });
  try {
    const circuitIntentBase = `http://127.0.0.1:${circuitIntentStarted.server.address().port}`;
    const circuitIntentAsk = await request(circuitIntentBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'aria', question: '서킷 잠금 관점에서 먼저 볼 항목은?' }),
    });
    assert.equal(circuitIntentAsk.status, 200);
    assert.ok(circuitIntentAsk.payload.text.includes('기술 관점 우선 확인: 활성 서킷 1건'));
    assert.ok(circuitIntentAsk.payload.text.includes('활성 서킷의 심볼·사유·잠금 해제 시각을 먼저 확인'));
    assert.equal(circuitIntentAsk.payload.text.includes('symbol·reason·lock_until'), false);
  } finally {
    await closeServer(circuitIntentStarted.server);
  }

  const askFailureStarted = await startMeetingRoomWebServer({ port: 0, host: '127.0.0.1' }, {
    ...deps,
    resolveAgentLLMRouteFn: () => ({ provider: 'fixture', model: 'fixture-model' }),
    callViaHubFn: async () => {
      throw new Error('fixture hub internal stack provider=openai model=x');
    },
  });
  const askFailureBase = `http://127.0.0.1:${askFailureStarted.server.address().port}`;
  try {
    const failedAsk = await request(askFailureBase, '/api/agents/ask', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ agent: 'luna', question: '실패 안내 점검' }),
    });
    assert.equal(failedAsk.status, 200);
    assert.equal(failedAsk.payload.ok, false);
    assert.equal(failedAsk.payload.error, '에이전트 응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.');
    assert.equal(failedAsk.payload.error.includes('provider=openai'), false);
    assert.equal(failedAsk.payload.errorCode, 'agent_ask_failed');
    assert.equal(failedAsk.payload.route, undefined);
  } finally {
    await closeServer(askFailureStarted.server);
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
    assert.equal(unauthorized.payload.message, '토큰이 없거나 올바르지 않습니다.');
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
      dashboardNewTabNoopener: true,
      keyboardFocusVisible: true,
      mobileOneColumnContract: true,
      pendingDueOrder: true,
      startDuplicateGuard: true,
      startReentryGuard: true,
      completedRunSwitchesToSessionDetail: true,
      completedRunIncreasesMeetingListCount: true,
      meetingLaunchdPersistentLogs: true,
      failedRunShowsError: true,
      confirmAuditAndIdempotency: true,
      decisionActionReentryGuard: true,
      idempotentDecisionNotice: true,
      deferAudit: true,
      deferLeavesPendingQueue: true,
      catchupConfirmedDeferredPendingCounts: true,
      catchupLinesA11y: true,
      catchupInternalTermsLocalized: true,
      catchupPremarketDecisionPrefixDeduped: true,
      cryptoMarketLabelLocalized: true,
      askRateLimit: true,
      askSafetyNotice: true,
      askAdvisoryTermKoreanLabel: true,
      askFormKoreanLabels: true,
      askInputGuidance: true,
      askKeyboardSubmitShortcut: true,
      askFormLandmarkLabel: true,
      askStatePreservedAcrossTabSwitch: true,
      askDraftRestoresAfterReload: true,
      askClearsStaleAnswerOnSubmit: true,
      askClearsStaleAnswerOnInputChange: true,
      askIgnoresStaleAsyncResponse: true,
      askClearsStateOnTokenChange: true,
      askReentryAndEmptyQuestionGuard: true,
      askInputClearsStaleError: true,
      askAnswerLiveRegion: true,
      askBusyStatus: true,
      askResponseMetadataLabels: true,
      agentPrefixDisplayNormalized: true,
      deterministicAnalysisTitleDeduped: true,
      sessionSummaryTypeLocalized: true,
      regeneratedMarkdownTypeLocalized: true,
      regeneratedMarkdownMetadataLocalized: true,
      regeneratedMarkdownPlanNoteLocalized: true,
      regeneratedMarkdownSectionLabelsLocalized: true,
      regeneratedMarkdownEmptyFallbackLocalized: true,
      regeneratedMarkdownMissingFieldsLocalized: true,
      askNoLlmRouteLocalized: true,
      askWeekendScheduleRuleBased: true,
      askPremarketMeetingRuleBased: true,
      askTelegramSyncRuleBased: true,
      askFailureFriendlyError: true,
      pollingCadenceConfigured: true,
      pollingStatusVisible: true,
      pollingStatusKoreanLabel: true,
      tokenAuth: true,
      tokenStorageFailOpen: true,
      headerTokenA11y: true,
      dailyRoomTokenChangeClearsStaleData: true,
      tablistSemantics: true,
      tabPanelAriaControlsTargets: true,
      tabKeyboardNavigation: true,
      tabSelectedStateOnly: true,
      startMeetingA11y: true,
      startClosedSegmentUiGuard: true,
      meetingListPressedState: true,
      meetingListRegionA11y: true,
      timelineArticleA11y: true,
      timelineMinuteTermLocalized: true,
      timelineRoleLegend: true,
      dynamicRegionA11y: true,
      localhostBinding: true,
      staticServingAndXssBaseline: true,
      staticPathEscapeBlocked: true,
      markdownLiteBoldHeadingListTable: true,
      markdownListTextBoundary: true,
      markdownTableMobileWrapGuard: true,
      markdownLiteNoInnerHtml: true,
      legacyRawJsonMinuteNormalized: true,
      userVisibleApiRawLeakGuard: true,
      userVisibleRepeatedSentenceGuard: true,
      legacyCircuitJsonMinuteSummarized: true,
      legacyCircuitCountMasked: true,
      legacyAdvisoryTermLocalized: true,
      legacyMapekComponentLocalized: true,
      legacyDbMinuteTermLocalized: true,
      legacyRegimeValuesLocalized: true,
      legacyOverseasMarketLocalized: true,
      legacyInternalEvidenceTermsLocalized: true,
      legacyCostGuardTermsLocalized: true,
      friendlyUiErrors: true,
      friendlyApiFallbackErrors: true,
      closedSegmentReasonVisible: true,
      closedSegmentReasonA11y: true,
      activeSegmentStatusKoreanLabel: true,
      segmentReasonKoreanLabel: true,
      segmentReasonRuntimeCodesLocalized: true,
      segmentReasonUnknownCodeHidden: true,
      segmentStatusTextSeparated: true,
      llmToggleDefaultNoCost: true,
      llmModeLiveRegion: true,
      evidenceDisclosureKoreanLabel: true,
      evidencePreMobileOverflowGuard: true,
      collapsedEvidenceDoesNotCreateScrollSpace: true,
      collapsedEvidenceDoesNotRenderJsonDom: true,
      decisionActionKoreanLabels: true,
      decisionControlsAccessibleNames: true,
      decisionRegionA11y: true,
      decisionStatusRawTokenHidden: true,
      serverRecoveryClearsError: true,
      authFailureClearsCachedData: true,
      dailyRoomResetClearsLoadingAndNotice: true,
      dailyRoomIgnoresStaleAsyncRefresh: true,
      dueBadges: true,
      dueBadgeA11y: true,
      dueFallbackKoreanLabel: true,
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

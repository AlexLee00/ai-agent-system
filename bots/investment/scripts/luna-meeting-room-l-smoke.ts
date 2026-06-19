#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LUNA_MEETING_ROOM_L_CONFIRM,
  findOverdueAdrCandidates,
  runMeetingRoomLOps,
} from '../services/meeting-room/server/meeting-room-l-ops.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function fixedNow() {
  return '2026-06-19T06:00:00.000Z';
}

function queryFixture({
  sessions = [],
  decisions = [],
  locks = [],
  events = [],
  existingAgendaKeys = [],
} = {}) {
  return async (sql: string) => {
    if (/FROM luna_meeting_sessions/i.test(sql)) return sessions;
    if (/FROM luna_meeting_decisions/i.test(sql) && /due_at/i.test(sql) && /pending_master/i.test(sql)) {
      return decisions.filter((row: any) => row.status === 'pending_master');
    }
    if (/FROM luna_meeting_decisions/i.test(sql) && /agenda_key = ANY/i.test(sql)) {
      return existingAgendaKeys.map((agenda_key: string) => ({ agenda_key }));
    }
    if (/FROM luna_circuit_locks/i.test(sql)) return locks;
    if (/FROM circuit_breaker_events/i.test(sql)) return events;
    return [];
  };
}

async function main() {
  const outputDir = tmpDir('luna-mr-l');
  fs.writeFileSync(path.join(outputDir, 'existing.md'), '# existing\n\n- 회의 ID: 901\n');

  const sessions = [
    { id: 901, type: 'morning', status: 'closed', started_at: fixedNow(), closed_at: fixedNow(), summary: 'has markdown', minute_count: 1 },
    { id: 902, type: 'domestic_debrief', status: 'closed', started_at: fixedNow(), closed_at: fixedNow(), summary: 'missing markdown', minute_count: 3 },
    { id: 903, type: 'weekly', status: 'closed', started_at: fixedNow(), closed_at: fixedNow(), summary: 'no minutes', minute_count: 0 },
  ];
  let regenerated = 0;
  const debriefDry = await runMeetingRoomLOps({
    dryRun: true,
    limit: 10,
    outputDir,
    skipAdr: true,
    skipCircuit: true,
  }, {
    queryFn: queryFixture({ sessions }),
    regenerateMeetingMinutesMarkdown: async () => {
      throw new Error('dry_run_should_not_regenerate');
    },
  });
  assert.equal(debriefDry.ok, true);
  assert.deepEqual(debriefDry.debrief.candidates.map((row: any) => row.id).sort(), [902, 903]);

  const blocked = await runMeetingRoomLOps({
    apply: true,
    dryRun: false,
    outputDir,
  }, { queryFn: queryFixture({ sessions }) });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'confirm_required');

  const debriefApply = await runMeetingRoomLOps({
    apply: true,
    dryRun: false,
    confirm: LUNA_MEETING_ROOM_L_CONFIRM,
    outputDir,
    skipAdr: true,
    skipCircuit: true,
  }, {
    queryFn: queryFixture({ sessions }),
    regenerateMeetingMinutesMarkdown: async (sessionId: any) => {
      regenerated += 1;
      return { ok: true, session: { id: sessionId }, markdownPath: path.join(outputDir, `${sessionId}.md`) };
    },
  });
  assert.equal(debriefApply.ok, true);
  assert.equal(regenerated, 2);
  assert.equal(debriefApply.debrief.generated, 2);

  const overdueDecision = {
    id: 7701,
    session_id: 77,
    agenda_key: 'market:domestic',
    decision: '국내 확인 대기',
    grade: 'c_master',
    status: 'pending_master',
    due_at: '2026-06-18T00:00:00.000Z',
    evidence: {},
    created_at: '2026-06-17T00:00:00.000Z',
  };
  const alreadyReagended = {
    ...overdueDecision,
    id: 7702,
    evidence: { mr_l: { reagenda: [{ dateKst: '2026-06-19' }] } },
  };
  const overdue = await findOverdueAdrCandidates({ now: fixedNow(), limit: 10 }, {
    queryFn: queryFixture({ decisions: [overdueDecision, alreadyReagended, { ...overdueDecision, id: 7703, status: 'confirmed' }] }),
  });
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].decisionId, 7701);
  assert.equal(overdue[0].dateKst, '2026-06-19');

  const adrApply = await runMeetingRoomLOps({
    apply: true,
    dryRun: false,
    confirm: LUNA_MEETING_ROOM_L_CONFIRM,
    now: fixedNow(),
    skipDebrief: true,
    skipCircuit: true,
  }, {
    queryFn: queryFixture({ decisions: [overdueDecision] }),
    runMeetingSession: async (_options: any) => {
      assert.equal(_options.type, 'adhoc');
      assert.equal(_options.agendas[0].kind, 'adr_overdue_reagenda');
      return { session: { id: 8801 }, decisions: [{ id: 7701 }], markdownPath: '/tmp/adr.md' };
    },
  });
  assert.equal(adrApply.adr.overdue.length, 1);
  assert.equal(adrApply.adr.reappeared, 1);

  let lUpdateParam: any = null;
  const insertedMinutes: any[] = [];
  const runResult = await runMeetingSession({
    type: 'adhoc',
    apply: true,
    dryRun: false,
    noLlm: true,
    now: fixedNow(),
    outputPath: path.join(outputDir, 'adr-reagenda.md'),
    planNote: {
      briefMarkdown: '# ADR fixture',
      segments: [],
      pendingDecisions: [],
      circuitLocks: [],
    },
    agendas: [{
      key: 'adr-overdue:7701',
      kind: 'adr_overdue_reagenda',
      title: '기한 초과 ADR 재상정: market:domestic',
      market: 'any',
      evidence: {
        type: 'adr_overdue_reagenda',
        decisionId: 7701,
        originalAgendaKey: 'market:domestic',
        dateKst: '2026-06-19',
      },
      defaultGrade: 'c_master',
      defaultStatus: 'pending_master',
    }],
  }, {
    queryFn: async (sql: string, params: any[] = []) => {
      if (/FROM luna_meeting_decisions/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
        assert.equal(params[0], 7701);
        return [{ ...overdueDecision, evidence: { mr_l: { reagenda: [] } } }];
      }
      if (/UPDATE luna_meeting_decisions/i.test(sql)) {
        assert.ok(sql.includes('mr_l'));
        lUpdateParam = JSON.parse(params[1]);
        return [{ ...overdueDecision, evidence: { mr_l: { reagenda: lUpdateParam } } }];
      }
      if (/SELECT COALESCE\(MAX\(seq\)/i.test(sql)) return [{ next_seq: 99 }];
      return [];
    },
    runFn: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO luna_meeting_sessions/i.test(sql)) return { rows: [{ id: 991 }] };
      if (/INSERT INTO luna_meeting_minutes/i.test(sql)) {
        insertedMinutes.push({ sql, params });
        return { rowCount: 1 };
      }
      if (/INSERT INTO luna_meeting_decisions/i.test(sql)) throw new Error('should_not_insert_duplicate_decision');
      return { rowCount: 1, rows: [] };
    },
    postAlarm: async () => ({ ok: true }),
    executeInvestmentSkill: async () => ({ ok: false }),
  });
  assert.equal(runResult.decisions[0].id, 7701);
  assert.equal(lUpdateParam[0].dateKst, '2026-06-19');
  assert.ok(insertedMinutes.some((row) => String(row.params[3] || '').includes('기한 초과 ADR 재상정')));

  const lock = {
    id: 41,
    market: 'crypto',
    symbol: 'BTC/USDT',
    side: 'long',
    level: 'symbol',
    circuit: 'low_profit_symbol',
    reason: 'cumulative_r_below_zero',
    evidence: {},
    lock_until: null,
    evaluated_at: fixedNow(),
  };
  const event = {
    id: 42,
    symbol: 'ETH/USDT',
    level: 2,
    action: 'halt',
    paper_mode: false,
    halted: true,
    feedback: {},
    market_mode: {},
    payload: { market: 'crypto' },
    event_at: fixedNow(),
    inserted_at: fixedNow(),
  };
  const circuitDry = await runMeetingRoomLOps({
    dryRun: true,
    skipDebrief: true,
    skipAdr: true,
    now: fixedNow(),
  }, {
    queryFn: queryFixture({ locks: [lock], events: [event] }),
  });
  assert.equal(circuitDry.circuit.candidates.length, 2);

  const circuitApply = await runMeetingRoomLOps({
    apply: true,
    dryRun: false,
    confirm: LUNA_MEETING_ROOM_L_CONFIRM,
    skipDebrief: true,
    skipAdr: true,
    now: fixedNow(),
  }, {
    queryFn: queryFixture({ locks: [lock], events: [event] }),
    runMeetingSession: async (options: any) => {
      assert.equal(options.type, 'adhoc');
      assert.equal(options.agendas.length, 2);
      assert.ok(options.agendas.every((agenda: any) => agenda.kind === 'circuit_locks'));
      return { session: { id: 9902 }, decisions: [{ id: 1 }, { id: 2 }], markdownPath: '/tmp/circuit.md' };
    },
  });
  assert.equal(circuitApply.circuit.triggered, 2);

  const circuitDedup = await runMeetingRoomLOps({
    dryRun: true,
    skipDebrief: true,
    skipAdr: true,
    now: fixedNow(),
  }, {
    queryFn: queryFixture({
      locks: [lock],
      events: [event],
      existingAgendaKeys: ['circuit:lock:41', 'circuit:event:42'],
    }),
  });
  assert.equal(circuitDedup.circuit.candidates.length, 0);

  const sourceText = [
    fs.readFileSync(path.join(ROOT, 'services/meeting-room/server/meeting-room-l-ops.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'services/meeting-room/server/orchestrator/meeting-session.ts'), 'utf8'),
  ].join('\n');
  assert.equal(/placeOrder|createOrder|modifyOrder|cancelOrder|runtime-config|parameter_store/i.test(sourceText), false);

  const result = {
    smoke: 'luna-meeting-room-l',
    ok: true,
    scenarios: {
      debriefBackfill: true,
      confirmGuard: true,
      overdueAdrReagenda: true,
      duplicateDecisionPreserved: true,
      circuitAdhocTrigger: true,
      circuitDedup: true,
      advisoryOnlySafety: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna meeting room l smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-meeting-room-l-smoke 실패:', error);
  process.exitCode = 1;
});

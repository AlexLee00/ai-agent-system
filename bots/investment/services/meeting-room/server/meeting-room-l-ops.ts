// @ts-nocheck

import fs from 'fs';
import path from 'path';
import * as db from '../../../shared/db.ts';
import { MEETING_ROOM_DEFAULTS } from '../config/meeting.config.ts';
import { regenerateMeetingMinutesMarkdown } from './minutes.ts';
import { runMeetingSession } from './orchestrator/meeting-session.ts';

export const LUNA_MEETING_ROOM_L_CONFIRM = 'luna-meeting-room-l-shadow';

function safeJson(value: any, fallback: any = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function iso(value: any = Date.now()) {
  return new Date(value).toISOString();
}

function kstDateKey(now: any = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeLimit(value: any, fallback = 20) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function canWrite(options: any = {}) {
  return options.apply === true
    && options.dryRun !== true
    && String(options.confirm || '').trim() === LUNA_MEETING_ROOM_L_CONFIRM;
}

function meetingMarkdownContainsSession(outputDir: string, sessionId: any) {
  const id = String(sessionId || '').trim();
  if (!id || !fs.existsSync(outputDir)) return false;
  const needles = [`회의 ID: ${id}`, `회의 #${id}`];
  for (const fileName of fs.readdirSync(outputDir)) {
    if (!fileName.endsWith('.md')) continue;
    const filePath = path.join(outputDir, fileName);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      if (needles.some((needle) => text.includes(needle))) return true;
    } catch {
      // Ignore unreadable historical output files.
    }
  }
  return false;
}

function decisionAlreadyReagendedToday(row: any = {}, now: any = Date.now()) {
  const evidence = safeJson(row.evidence);
  const entries = Array.isArray(evidence?.mr_l?.reagenda) ? evidence.mr_l.reagenda : [];
  const today = kstDateKey(now);
  return entries.some((item: any) => item?.dateKst === today);
}

export async function findDebriefBackfillCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const outputDir = path.resolve(options.outputDir || MEETING_ROOM_DEFAULTS.outputDir);
  const limit = normalizeLimit(options.limit, 20);
  const rows = await queryFn(
    `SELECT s.id, s.type, s.status, s.started_at, s.closed_at, s.summary,
            COUNT(m.id)::int AS minute_count
       FROM luna_meeting_sessions s
       LEFT JOIN luna_meeting_minutes m ON m.session_id = s.id
      WHERE s.status = 'closed'
        AND s.closed_at IS NOT NULL
      GROUP BY s.id, s.type, s.status, s.started_at, s.closed_at, s.summary
      ORDER BY s.closed_at DESC
      LIMIT $1`,
    [limit],
  );
  return (rows || [])
    .map((row: any) => {
      const hasMarkdown = meetingMarkdownContainsSession(outputDir, row.id);
      return {
        id: row.id,
        type: row.type,
        startedAt: row.started_at,
        closedAt: row.closed_at,
        summary: row.summary,
        minuteCount: Number(row.minute_count || 0),
        hasMarkdown,
        reason: Number(row.minute_count || 0) <= 0
          ? 'minutes_missing'
          : hasMarkdown ? 'already_generated' : 'markdown_missing',
      };
    })
    .filter((row: any) => row.minuteCount <= 0 || row.hasMarkdown !== true);
}

export async function findOverdueAdrCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const now = options.now || Date.now();
  const rows = await queryFn(
    `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
       FROM luna_meeting_decisions
      WHERE status = 'pending_master'
        AND due_at IS NOT NULL
        AND due_at < NOW()
      ORDER BY due_at ASC, created_at ASC
      LIMIT $1`,
    [limit],
  );
  return (rows || [])
    .map((row: any) => ({ ...row, evidence: safeJson(row.evidence) }))
    .filter((row: any) => !decisionAlreadyReagendedToday(row, now))
    .map((row: any) => ({
      id: row.id,
      decisionId: row.id,
      sessionId: row.session_id,
      agendaKey: `adr-overdue:${row.id}`,
      originalAgendaKey: row.agenda_key,
      decision: row.decision,
      grade: row.grade,
      status: row.status,
      dueAt: row.due_at,
      evidence: row.evidence,
      dateKst: kstDateKey(now),
    }));
}

function buildOverdueAdrAgenda(row: any = {}) {
  return {
    key: row.agendaKey,
    kind: 'adr_overdue_reagenda',
    title: `기한 초과 ADR 재상정: ${row.originalAgendaKey || row.agendaKey}`,
    market: 'any',
    evidence: {
      type: 'adr_overdue_reagenda',
      decisionId: row.decisionId || row.id,
      sessionId: row.sessionId,
      originalAgendaKey: row.originalAgendaKey,
      decision: row.decision,
      dueAt: row.dueAt,
      dateKst: row.dateKst,
      evidence: row.evidence || {},
      advisoryOnly: true,
      shadowOnly: true,
    },
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  };
}

function normalizeCircuitLock(row: any = {}) {
  return {
    source: 'luna_circuit_locks',
    sourceId: row.id,
    agendaKey: `circuit:lock:${row.id}`,
    market: row.market,
    symbol: row.symbol,
    side: row.side,
    level: row.level,
    circuit: row.circuit,
    reason: row.reason,
    evidence: safeJson(row.evidence),
    occurredAt: row.evaluated_at,
    lockUntil: row.lock_until,
    advisoryOnly: true,
    shadowOnly: true,
  };
}

function normalizeCircuitEvent(row: any = {}) {
  const payload = safeJson(row.payload);
  return {
    source: 'circuit_breaker_events',
    sourceId: row.id,
    agendaKey: `circuit:event:${row.id}`,
    market: payload.market || payload.runtimeMarket || 'crypto',
    symbol: row.symbol,
    level: String(row.level ?? 'unknown'),
    circuit: row.action || 'circuit_breaker',
    reason: row.halted ? 'halted' : 'circuit_event',
    evidence: { feedback: safeJson(row.feedback), marketMode: safeJson(row.market_mode), payload },
    occurredAt: row.event_at,
    advisoryOnly: true,
    shadowOnly: true,
  };
}

async function filterExistingCircuitAgendas(candidates: any[] = [], queryFn: any) {
  const keys = candidates.map((row) => row.agendaKey).filter(Boolean);
  if (!keys.length) return candidates;
  const rows = await queryFn(
    `SELECT agenda_key
       FROM luna_meeting_decisions
      WHERE agenda_key = ANY($1::text[])`,
    [keys],
  );
  const existing = new Set((rows || []).map((row: any) => row.agenda_key || row.agendaKey));
  return candidates.filter((row) => !existing.has(row.agendaKey));
}

export async function findCircuitMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const lookbackHours = normalizeLimit(options.circuitLookbackHours, 24);
  const cutoff = new Date(Date.parse(String(options.now || new Date())) - lookbackHours * 3_600_000).toISOString();
  const lockRows = await queryFn(
    `SELECT id, market, symbol, side, level, circuit, reason, evidence, lock_until, evaluated_at
       FROM luna_circuit_locks
      WHERE locked IS TRUE
        AND shadow_only IS TRUE
        AND (lock_until IS NULL OR lock_until > NOW())
        AND evaluated_at >= $1::timestamptz
      ORDER BY evaluated_at DESC
      LIMIT $2`,
    [cutoff, limit],
  );
  const eventRows = await queryFn(
    `SELECT id, symbol, level, action, paper_mode, halted, feedback, market_mode, payload, event_at, inserted_at
       FROM circuit_breaker_events
      WHERE inserted_at >= $1::timestamptz
         OR event_at >= $1::timestamptz
      ORDER BY GREATEST(inserted_at, event_at) DESC
      LIMIT $2`,
    [cutoff, limit],
  );
  const candidates = [
    ...(lockRows || []).map(normalizeCircuitLock),
    ...(eventRows || []).map(normalizeCircuitEvent),
  ].slice(0, limit);
  return filterExistingCircuitAgendas(candidates, queryFn);
}

function buildCircuitAgenda(row: any = {}) {
  const subject = [row.market, row.symbol, row.circuit].filter(Boolean).join(' / ');
  return {
    key: row.agendaKey,
    kind: 'circuit_locks',
    title: `수시 서킷 점검: ${subject || row.agendaKey}`,
    market: row.market || 'any',
    evidence: [row],
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  };
}

function buildPlanNote(type: string, title: string, agendas: any[] = [], now: any = Date.now()) {
  return {
    ok: true,
    type,
    generatedAt: iso(now),
    segments: [],
    gates: [],
    regimes: [],
    strategySignals: [],
    circuitLocks: agendas.flatMap((agenda) => Array.isArray(agenda.evidence) ? agenda.evidence : []),
    pendingDecisions: agendas.map((agenda) => agenda.evidence).filter(Boolean),
    positions: [],
    calibration: [],
    readOnly: true,
    shadowOnly: true,
    briefMarkdown: [
      `# Luna Meeting Room L — ${title}`,
      `- 생성: ${iso(now)}`,
      `- 안건: ${agendas.length}건`,
      '- 회의 산출은 자문/섀도 전용이며 직접 적용하지 않습니다.',
    ].join('\n'),
  };
}

async function runAdhocMeetingForAgendas({ title, agendas, options, deps }: any) {
  if (!agendas.length) return null;
  const runMeeting = deps.runMeetingSession || runMeetingSession;
  return runMeeting({
    type: 'adhoc',
    chair: options.chair || 'luna',
    apply: true,
    dryRun: false,
    noLlm: options.noLlm === true,
    outputPath: options.outputPath || null,
    outputDir: options.outputDir,
    now: options.now,
    planNote: buildPlanNote('adhoc', title, agendas, options.now),
    agendas,
  }, deps);
}

export async function runMeetingRoomLOps(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun ?? !apply;
  const writable = canWrite({ ...options, dryRun });
  const errors = [];
  if (apply && !writable) {
    return {
      ok: false,
      blocked: true,
      reason: 'confirm_required',
      dryRun,
      apply,
      debrief: { candidates: [], generated: 0, skipped: [] },
      adr: { overdue: [], reappeared: 0, skipped: [] },
      circuit: { candidates: [], triggered: 0, skipped: [] },
      liveMutation: false,
      shadowOnly: true,
      errors,
    };
  }

  const result = {
    ok: true,
    dryRun,
    apply,
    debrief: { candidates: [], generated: 0, skipped: [] },
    adr: { overdue: [], reappeared: 0, skipped: [] },
    circuit: { candidates: [], triggered: 0, skipped: [] },
    liveMutation: false,
    shadowOnly: true,
    errors,
  };

  if (options.skipDebrief !== true) {
    try {
      const candidates = await findDebriefBackfillCandidates(options, deps);
      result.debrief.candidates = candidates;
      if (writable) {
        const regenerate = deps.regenerateMeetingMinutesMarkdown || regenerateMeetingMinutesMarkdown;
        for (const candidate of candidates) {
          if (candidate.hasMarkdown) {
            result.debrief.skipped.push({ id: candidate.id, reason: 'markdown_exists' });
            continue;
          }
          await regenerate(candidate.id, {
            outputDir: options.outputDir,
            preserveExisting: true,
            queryFn: deps.queryFn,
          });
          result.debrief.generated += 1;
        }
      }
    } catch (error) {
      errors.push({ step: 'debrief', error: error?.message || String(error) });
    }
  }

  if (options.skipAdr !== true) {
    try {
      const overdue = await findOverdueAdrCandidates(options, deps);
      result.adr.overdue = overdue;
      if (writable && overdue.length > 0) {
        const agendas = overdue.map(buildOverdueAdrAgenda);
        const meeting = await runAdhocMeetingForAgendas({ title: '기한 초과 ADR 재상정', agendas, options, deps });
        result.adr.reappeared = meeting?.decisions?.length || overdue.length;
        result.adr.meeting = meeting ? { id: meeting.session?.id || null, markdownPath: meeting.markdownPath || null } : null;
      }
    } catch (error) {
      errors.push({ step: 'adr', error: error?.message || String(error) });
    }
  }

  if (options.skipCircuit !== true) {
    try {
      const candidates = await findCircuitMeetingCandidates(options, deps);
      result.circuit.candidates = candidates;
      if (writable && candidates.length > 0) {
        const agendas = candidates.map(buildCircuitAgenda);
        const meeting = await runAdhocMeetingForAgendas({ title: '수시 서킷 점검', agendas, options, deps });
        result.circuit.triggered = meeting?.decisions?.length || candidates.length;
        result.circuit.meeting = meeting ? { id: meeting.session?.id || null, markdownPath: meeting.markdownPath || null } : null;
      }
    } catch (error) {
      errors.push({ step: 'circuit', error: error?.message || String(error) });
    }
  }

  result.ok = errors.length === 0;
  return result;
}

export const _testOnly = {
  kstDateKey,
  canWrite,
  buildOverdueAdrAgenda,
  buildCircuitAgenda,
  decisionAlreadyReagendedToday,
};

export default {
  runMeetingRoomLOps,
  findDebriefBackfillCandidates,
  findOverdueAdrCandidates,
  findCircuitMeetingCandidates,
};

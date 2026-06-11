#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../../../shared/db.ts';
import { resolveAgentLLMRoute } from '../../../shared/agent-llm-routing.ts';
import { callViaHub } from '../../../shared/hub-llm-client.ts';
import { isDirectExecution } from '../../../shared/cli-runtime.ts';
import { buildMeetingPlanNote, buildMarketSegments } from './adapters/stack-adapter.ts';
import { runMeetingSession } from './orchestrator/meeting-session.ts';
import { normalizeChair, normalizeMeetingType } from '../config/meeting.config.ts';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(SERVICE_ROOT, 'web');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7791;
const MAX_BODY_BYTES = 1_000_000;
const ASK_LIMIT_PER_MINUTE = 2;
const ASK_LIMIT_PER_DAY = 20;

class HttpError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeSession(row = {}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    chair: row.chair,
    segments: safeJson(row.segments, []),
    startedAt: row.started_at || row.startedAt,
    closedAt: row.closed_at || row.closedAt,
    summary: row.summary || '',
  };
}

function normalizeMinute(row = {}) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    seq: row.seq,
    agendaKey: row.agenda_key || row.agendaKey,
    speaker: row.speaker,
    role: row.role,
    content: row.content,
    meta: safeJson(row.meta),
    createdAt: row.created_at || row.createdAt,
  };
}

function normalizeDecision(row = {}) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    agendaKey: row.agenda_key || row.agendaKey,
    decision: row.decision,
    grade: row.grade,
    status: row.status,
    dueAt: row.due_at || row.dueAt,
    evidence: safeJson(row.evidence),
    createdAt: row.created_at || row.createdAt,
  };
}

function getDeps(deps = {}) {
  return {
    queryFn: deps.queryFn || db.query,
    runFn: deps.runFn || db.run,
    withTransactionFn: deps.withTransactionFn || db.withTransaction,
    runMeetingSessionFn: deps.runMeetingSessionFn || runMeetingSession,
    buildMeetingPlanNoteFn: deps.buildMeetingPlanNoteFn || buildMeetingPlanNote,
    resolveAgentLLMRouteFn: deps.resolveAgentLLMRouteFn || resolveAgentLLMRoute,
    callViaHubFn: deps.callViaHubFn || callViaHub,
    meetingStore: deps.meetingStore || null,
  };
}

async function listMeetings(limit, deps) {
  if (deps.meetingStore?.listMeetings) return deps.meetingStore.listMeetings(limit);
  const rows = await deps.queryFn(
    `SELECT id, type, status, chair, segments, started_at, closed_at, summary
       FROM luna_meeting_sessions
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows.map(normalizeSession);
}

async function getMeeting(id, deps) {
  if (deps.meetingStore?.getMeeting) return deps.meetingStore.getMeeting(id);
  const sessionRows = await deps.queryFn(
    `SELECT id, type, status, chair, segments, started_at, closed_at, summary
       FROM luna_meeting_sessions
      WHERE id = $1`,
    [id],
  );
  if (!sessionRows?.[0]) throw new HttpError(404, 'meeting_not_found', `meeting ${id} not found`);
  const minuteRows = await deps.queryFn(
    `SELECT id, session_id, seq, agenda_key, speaker, role, content, meta, created_at
       FROM luna_meeting_minutes
      WHERE session_id = $1
      ORDER BY seq ASC`,
    [id],
  );
  const decisionRows = await deps.queryFn(
    `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
       FROM luna_meeting_decisions
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [id],
  );
  return {
    ok: true,
    session: normalizeSession(sessionRows[0]),
    minutes: minuteRows.map(normalizeMinute),
    decisions: decisionRows.map(normalizeDecision),
  };
}

async function listPendingDecisions(deps) {
  if (deps.meetingStore?.listPendingDecisions) return deps.meetingStore.listPendingDecisions();
  const rows = await deps.queryFn(
    `SELECT d.id, d.session_id, d.agenda_key, d.decision, d.grade, d.status, d.due_at, d.evidence, d.created_at,
            s.type AS session_type, s.started_at AS session_started_at
       FROM luna_meeting_decisions d
       JOIN luna_meeting_sessions s ON s.id = d.session_id
      WHERE d.status = 'pending_master'
      ORDER BY d.due_at ASC NULLS LAST, d.created_at DESC
      LIMIT 100`,
  );
  return rows.map((row) => ({
    ...normalizeDecision(row),
    sessionType: row.session_type,
    sessionStartedAt: row.session_started_at,
  }));
}

async function hasOpenMeetingType(type, deps) {
  if (deps.meetingStore?.hasOpenMeetingType) return deps.meetingStore.hasOpenMeetingType(type);
  const rows = await deps.queryFn(
    `SELECT id
       FROM luna_meeting_sessions
      WHERE type = $1 AND status = 'open'
      LIMIT 1`,
    [type],
  );
  return Boolean(rows?.[0]);
}

function buildCatchupFromDetail(detail) {
  const decisions = detail.decisions || [];
  const confirmed = decisions.filter((row) => row.status === 'confirmed');
  const pending = decisions.filter((row) => row.status === 'pending_master');
  const next = pending.slice(0, 3).map((row) => `${row.agendaKey}: ${row.decision}`).join(' / ') || '없음';
  return [
    `결정됨 ${confirmed.length}건, 대기 중 ${pending.length}건`,
    `마스터 액션 필요: ${next}`,
    `회의 ${detail.session?.id || 'n/a'} · minutes ${(detail.minutes || []).length}행 · 최신 상태 ${detail.session?.status || 'n/a'}`,
  ];
}

function validateMeetingStart(type, now = new Date()) {
  const segments = buildMarketSegments(now);
  const domestic = segments.find((row) => row.market === 'domestic');
  const overseas = segments.find((row) => row.market === 'overseas');
  if (type === 'domestic_debrief' && domestic?.skipped) {
    throw new HttpError(409, 'segment_closed', 'domestic segment is closed', { segment: domestic });
  }
  if (type === 'us_premarket' && overseas?.skipped) {
    throw new HttpError(409, 'segment_closed', 'overseas segment is closed', { segment: overseas });
  }
  return segments;
}

async function updateDecision(id, action, note, deps) {
  if (deps.meetingStore?.updateDecision) return deps.meetingStore.updateDecision(id, action, note);
  return deps.withTransactionFn(async (tx) => {
    const rows = await tx.query(
      `SELECT id, session_id, agenda_key, status, evidence
         FROM luna_meeting_decisions
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const decision = rows?.[0];
    if (!decision) throw new HttpError(404, 'decision_not_found', `decision ${id} not found`);
    if (decision.status !== 'pending_master') {
      throw new HttpError(409, 'decision_not_pending', `decision ${id} is ${decision.status}`);
    }

    const stamp = nowIso();
    const audit = {
      mr_b: {
        action,
        note: String(note || '').slice(0, 1000),
        at: stamp,
        advisoryOnly: true,
      },
    };

    let updatedRows;
    if (action === 'confirm') {
      updatedRows = await tx.query(
        `UPDATE luna_meeting_decisions
            SET status = 'confirmed',
                evidence = evidence || $2::jsonb
          WHERE id = $1
          RETURNING id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at`,
        [id, JSON.stringify(audit)],
      );
    } else {
      updatedRows = await tx.query(
        `UPDATE luna_meeting_decisions
            SET status = 'deferred',
                due_at = COALESCE(due_at, NOW()) + INTERVAL '24 hours',
                evidence = evidence || $2::jsonb
          WHERE id = $1
          RETURNING id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at`,
        [id, JSON.stringify(audit)],
      );
    }

    const seqRows = await tx.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM luna_meeting_minutes
        WHERE session_id = $1`,
      [decision.session_id],
    );
    const nextSeq = Number(seqRows?.[0]?.next_seq || 1);
    await tx.run(
      `INSERT INTO luna_meeting_minutes (session_id, seq, agenda_key, speaker, role, content, meta)
       VALUES ($1,$2,$3,'meeting-room-web','system',$4,$5::jsonb)`,
      [
        decision.session_id,
        nextSeq,
        decision.agenda_key,
        `MR-B ${action}: ${note || 'no note'}`,
        JSON.stringify({ state: `decision_${action}`, decisionId: id, advisoryOnly: true }),
      ],
    );

    return {
      ok: true,
      action,
      logicalStatus: action === 'defer' ? 'deferred' : 'confirmed',
      decision: normalizeDecision(updatedRows?.[0]),
      auditMinuteSeq: nextSeq,
    };
  });
}

function createAskLimiter() {
  return { minuteBucket: '', minuteCount: 0, dayBucket: '', dayCount: 0 };
}

function checkAskRateLimit(limiter, now = new Date()) {
  const minuteBucket = now.toISOString().slice(0, 16);
  const dayBucket = now.toISOString().slice(0, 10);
  if (limiter.minuteBucket !== minuteBucket) {
    limiter.minuteBucket = minuteBucket;
    limiter.minuteCount = 0;
  }
  if (limiter.dayBucket !== dayBucket) {
    limiter.dayBucket = dayBucket;
    limiter.dayCount = 0;
  }
  if (limiter.minuteCount >= ASK_LIMIT_PER_MINUTE) {
    throw new HttpError(429, 'ask_rate_limited_minute', 'agent ask minute limit exceeded');
  }
  if (limiter.dayCount >= ASK_LIMIT_PER_DAY) {
    throw new HttpError(429, 'ask_rate_limited_day', 'agent ask daily limit exceeded');
  }
  limiter.minuteCount += 1;
  limiter.dayCount += 1;
}

async function askAgent(body, deps, limiter) {
  const agent = String(body.agent || 'luna').trim();
  const question = String(body.question || '').trim();
  if (!question) throw new HttpError(400, 'question_required', 'question is required');
  checkAskRateLimit(limiter);

  const route = deps.resolveAgentLLMRouteFn(agent, 'any', 'meeting_room');
  const planNote = await deps.buildMeetingPlanNoteFn({
    type: 'morning',
    queryFn: deps.queryFn,
  });
  if (route?.noLLM) {
    return {
      ok: true,
      skipped: true,
      agent,
      route,
      text: `[${agent}] noLLM route. 질문은 기록만 합니다: ${question}`,
    };
  }

  try {
    const result = await deps.callViaHubFn(
      agent,
      'You are a Luna meeting-room agent. Answer in Korean. Use only the provided meeting context. Advisory only.',
      [
        `Question: ${question}`,
        '',
        'Meeting context:',
        planNote.briefMarkdown || 'plan-note unavailable',
      ].join('\n'),
      {
        maxTokens: 512,
        market: 'any',
        taskType: 'meeting_room',
        callerTeam: 'luna',
        urgency: 'low',
        timeoutMs: 45_000,
      },
    );
    return {
      ok: result?.ok === true,
      agent,
      route,
      provider: result?.provider || null,
      text: result?.text || '',
      error: result?.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      agent,
      route,
      text: '',
      error: error?.message || String(error),
    };
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);
  const parsed = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname);
  const target = path.resolve(WEB_ROOT, `.${pathname}`);
  if (target !== WEB_ROOT && !target.startsWith(`${WEB_ROOT}${path.sep}`)) {
    jsonResponse(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    jsonResponse(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  if (!stat.isFile()) {
    jsonResponse(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  res.writeHead(200, {
    'content-type': contentType(target),
    'content-length': stat.size,
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

function assertAuthorized(req, token) {
  if (!token) return;
  const expected = `Bearer ${token}`;
  if (req.headers.authorization !== expected) {
    throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
  }
}

function parseArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function createMeetingRoomWebServer(options = {}, rawDeps = {}) {
  const deps = getDeps(rawDeps);
  const token = options.token ?? process.env.MEETING_ROOM_TOKEN ?? '';
  const activeRuns = new Map();
  const activeTypes = new Map();
  const askLimiter = createAskLimiter();

  async function handleApi(req, res) {
    assertAuthorized(req, token);
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parsed.pathname === '/api/health') {
      return jsonResponse(res, 200, { ok: true, service: 'luna-meeting-room-web', shadowOnly: true });
    }

    if (req.method === 'GET' && parsed.pathname === '/api/meetings') {
      const meetings = await listMeetings(parsed.searchParams.get('limit') || 20, deps);
      return jsonResponse(res, 200, {
        ok: true,
        meetings,
        activeRuns: Array.from(activeRuns.values()).map((run) => ({ ...run, promise: undefined })),
        segments: buildMarketSegments(new Date()),
      });
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'meetings' && parts[2]) {
      const id = parts[2];
      if (activeRuns.has(id)) {
        const run = activeRuns.get(id);
        return jsonResponse(res, 200, { ok: true, run: { ...run, promise: undefined } });
      }
      return jsonResponse(res, 200, await getMeeting(id, deps));
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'catchup' && parts[2]) {
      const detail = activeRuns.has(parts[2])
        ? { session: activeRuns.get(parts[2]), minutes: [], decisions: [] }
        : await getMeeting(parts[2], deps);
      return jsonResponse(res, 200, { ok: true, lines: buildCatchupFromDetail(detail), meeting: detail.session });
    }

    if (req.method === 'GET' && parsed.pathname === '/api/decisions/pending') {
      return jsonResponse(res, 200, { ok: true, decisions: await listPendingDecisions(deps) });
    }

    if (req.method === 'POST' && parsed.pathname === '/api/meetings/start') {
      const body = await readBody(req);
      const type = normalizeMeetingType(body.type || 'morning');
      const chair = normalizeChair(body.chair || 'luna');
      validateMeetingStart(type, new Date());
      if (activeTypes.has(type) || await hasOpenMeetingType(type, deps)) {
        throw new HttpError(409, 'meeting_already_open', `meeting type ${type} is already open`);
      }
      const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const run = { id: runId, type, chair, status: 'running', startedAt: nowIso(), shadowOnly: true };
      activeRuns.set(runId, run);
      activeTypes.set(type, runId);
      run.promise = Promise.resolve()
        .then(() => deps.runMeetingSessionFn({
          type,
          chair,
          apply: true,
          dryRun: false,
          noLlm: body.noLlm !== false,
          outputPath: body.outputPath || null,
        }, rawDeps))
        .then((result) => {
          Object.assign(run, {
            status: 'completed',
            completedAt: nowIso(),
            sessionId: result?.session?.id || null,
            minutes: result?.minutes?.length || 0,
            decisions: result?.decisions?.length || 0,
            markdownPath: result?.markdownPath || null,
          });
          activeTypes.delete(type);
          return result;
        })
        .catch((error) => {
          Object.assign(run, { status: 'failed', completedAt: nowIso(), error: error?.message || String(error) });
          activeTypes.delete(type);
          return null;
        });
      return jsonResponse(res, 202, { ok: true, run: { ...run, promise: undefined } });
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
      const body = await readBody(req);
      const action = String(body.action || '').trim();
      if (!['confirm', 'defer'].includes(action)) {
        throw new HttpError(400, 'invalid_action', 'action must be confirm or defer');
      }
      return jsonResponse(res, 200, await updateDecision(parts[2], action, body.note || '', deps));
    }

    if (req.method === 'POST' && parsed.pathname === '/api/agents/ask') {
      const body = await readBody(req);
      return jsonResponse(res, 200, await askAgent(body, deps, askLimiter));
    }

    jsonResponse(res, 404, { ok: false, error: 'not_found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if ((req.url || '/').startsWith('/api/')) return await handleApi(req, res);
      return serveStatic(req, res);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error?.statusCode || 500;
      jsonResponse(res, status, {
        ok: false,
        error: error?.code || 'internal_error',
        message: error?.message || String(error),
        details: error?.details || null,
      });
    }
  });

  return { server, activeRuns, activeTypes, askLimiter };
}

export function startMeetingRoomWebServer(options = {}, deps = {}) {
  const host = options.host || process.env.MEETING_ROOM_HOST || DEFAULT_HOST;
  const port = Number(options.port ?? process.env.MEETING_ROOM_PORT ?? DEFAULT_PORT);
  const created = createMeetingRoomWebServer(options, deps);
  return new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(port, host, () => {
      created.server.off('error', reject);
      resolve({ ...created, host, port: created.server.address()?.port || port });
    });
  });
}

if (isDirectExecution(import.meta.url)) {
  const host = parseArg('host', process.env.MEETING_ROOM_HOST || DEFAULT_HOST);
  const port = Number(parseArg('port', process.env.MEETING_ROOM_PORT || DEFAULT_PORT));
  const started = await startMeetingRoomWebServer({ host, port });
  console.log(`[luna-meeting-room-web] listening on http://${started.host}:${started.port}`);
  process.on('SIGTERM', () => started.server.close(() => process.exit(0)));
  process.on('SIGINT', () => started.server.close(() => process.exit(0)));
}

export default {
  createMeetingRoomWebServer,
  startMeetingRoomWebServer,
};

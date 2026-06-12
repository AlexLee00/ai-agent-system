// @ts-nocheck

import * as db from '../../../shared/db.ts';

function safeJson(value: any, fallback: any = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function httpError(statusCode: number, code: string, message: string, details: any = null) {
  const error: any = new Error(message || code);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function decisionActionLabel(action: string) {
  return action === 'defer' ? '보류' : '확정';
}

function changedViaLabel(changedVia: string) {
  return {
    telegram: '텔레그램',
    web: '웹',
  }[String(changedVia || '').trim()] || String(changedVia || '웹');
}

function decisionAuditContent(action: string, changedVia: string, note: string) {
  const noteText = String(note || '').trim();
  return `결정 ${decisionActionLabel(action)} 처리 · 경로=${changedViaLabel(changedVia)} · ${noteText ? `메모=${noteText}` : '메모 없음'}`;
}

export function normalizeMeetingDecision(row: any = {}) {
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

export async function applyMeetingDecisionAction(input: any = {}, deps: any = {}) {
  const id = String(input.id || '').trim();
  const action = String(input.action || '').trim();
  if (!id) throw httpError(400, 'decision_id_required', 'decision id is required');
  if (!['confirm', 'defer'].includes(action)) {
    throw httpError(400, 'invalid_action', 'action must be confirm or defer');
  }

  const withTransactionFn = deps.withTransactionFn || db.withTransaction;
  return withTransactionFn(async (tx: any) => {
    const rows = await tx.query(
      `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
         FROM luna_meeting_decisions
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const decision = rows?.[0];
    if (!decision) throw httpError(404, 'decision_not_found', `decision ${id} not found`);

    if (decision.status !== 'pending_master') {
      return {
        ok: true,
        action,
        logicalStatus: decision.status,
        idempotent: true,
        status: `already_${decision.status}`,
        decision: normalizeMeetingDecision(decision),
        auditMinuteSeq: null,
      };
    }

    const stamp = nowIso(input.now || Date.now());
    const changedVia = String(input.changedVia || 'web').trim() || 'web';
    const note = String(input.note || '').slice(0, 1000);
    const actor = input.actor && typeof input.actor === 'object' ? input.actor : {};
    const auditKey = changedVia === 'telegram' ? 'mr_c' : 'mr_b';
    const audit = {
      [auditKey]: {
        action,
        note,
        at: stamp,
        changed_via: changedVia,
        actor,
        callback: input.callback || null,
        advisoryOnly: true,
      },
    };

    const updatedRows = action === 'confirm'
      ? await tx.query(
          `UPDATE luna_meeting_decisions
              SET status = 'confirmed',
                  evidence = evidence || $2::jsonb
            WHERE id = $1
            RETURNING id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at`,
          [id, JSON.stringify(audit)],
        )
      : await tx.query(
          `UPDATE luna_meeting_decisions
              SET status = 'deferred',
                  due_at = COALESCE(due_at, NOW()) + INTERVAL '24 hours',
                  evidence = evidence || $2::jsonb
            WHERE id = $1
            RETURNING id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at`,
          [id, JSON.stringify(audit)],
        );

    const seqRows = await tx.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM luna_meeting_minutes
        WHERE session_id = $1`,
      [decision.session_id],
    );
    const nextSeq = Number(seqRows?.[0]?.next_seq || 1);
    await tx.run(
      `INSERT INTO luna_meeting_minutes (session_id, seq, agenda_key, speaker, role, content, meta)
       VALUES ($1,$2,$3,$4,'system',$5,$6::jsonb)`,
      [
        decision.session_id,
        nextSeq,
        decision.agenda_key,
        changedVia === 'telegram' ? 'meeting-room-telegram' : 'meeting-room-web',
        decisionAuditContent(action, changedVia, note),
        JSON.stringify({
          state: `decision_${action}`,
          decisionId: id,
          changed_via: changedVia,
          actor,
          callback: input.callback || null,
          advisoryOnly: true,
        }),
      ],
    );

    return {
      ok: true,
      action,
      logicalStatus: action === 'defer' ? 'deferred' : 'confirmed',
      idempotent: false,
      decision: normalizeMeetingDecision(updatedRows?.[0]),
      auditMinuteSeq: nextSeq,
    };
  });
}

export default {
  normalizeMeetingDecision,
  applyMeetingDecisionAction,
};

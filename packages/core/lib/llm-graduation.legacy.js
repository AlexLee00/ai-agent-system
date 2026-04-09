'use strict';

const pgPool = require('./pg-pool');
const {
  ensureAiFeedbackTables,
  createFeedbackSession,
  updateFeedbackSession,
  addFeedbackEvent,
} = require('./ai-feedback-store');
const {
  FEEDBACK_EVENT_TYPES,
  FEEDBACK_STATUSES,
} = require('./ai-feedback-core');

const SCHEMA        = 'claude';
const SHADOW_SCHEMA = 'reservation';

let _tableReady = false;

async function _ensureTable() {
  if (_tableReady) return;
  await ensureAiFeedbackTables(pgPool, { schema: SCHEMA });
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS graduation_candidates (
      id                  SERIAL PRIMARY KEY,
      team                TEXT NOT NULL,
      context             TEXT NOT NULL,
      pattern             JSONB NOT NULL,
      predicted_decision  TEXT NOT NULL,
      sample_count        INTEGER NOT NULL,
      match_rate          REAL NOT NULL,
      status              TEXT NOT NULL DEFAULT 'candidate',
      verified_at         TIMESTAMPTZ,
      approved_by         TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, context, predicted_decision)
    )
  `);
  await pgPool.run(SCHEMA, `
    ALTER TABLE graduation_candidates
      ADD COLUMN IF NOT EXISTS feedback_session_id BIGINT REFERENCES ai_feedback_sessions(id)
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_grad_team_ctx ON graduation_candidates(team, context, status)
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_grad_feedback_session ON graduation_candidates(feedback_session_id)
  `);
  _tableReady = true;
}

async function _ensureFeedbackSessionForCandidate(candidate) {
  if (candidate.feedback_session_id) return candidate.feedback_session_id;

  const session = await createFeedbackSession(pgPool, {
    schema: SCHEMA,
    session: {
      companyId: 'claude',
      userId: null,
      sourceType: 'llm_graduation',
      sourceRefType: 'graduation_candidate',
      sourceRefId: candidate.id,
      flowCode: 'llm_graduation',
      actionCode: 'candidate_detection',
      proposalId: String(candidate.id),
      aiInputText: candidate.context,
      aiInputPayload: {
        team: candidate.team,
        context: candidate.context,
      },
      aiOutputType: 'graduation_candidate',
      originalSnapshot: {
        candidate_id: candidate.id,
        team: candidate.team,
        context: candidate.context,
        predicted_decision: candidate.predicted_decision,
        sample_count: candidate.sample_count,
        match_rate: candidate.match_rate,
        status: candidate.status,
      },
      feedbackStatus: FEEDBACK_STATUSES.PENDING,
    },
  });

  await addFeedbackEvent(pgPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: session.id,
      eventType: FEEDBACK_EVENT_TYPES.PROPOSAL_GENERATED,
      afterValue: {
        predicted_decision: candidate.predicted_decision,
        sample_count: candidate.sample_count,
        match_rate: candidate.match_rate,
      },
      eventMeta: {
        team: candidate.team,
        context: candidate.context,
      },
    },
  });

  await pgPool.run(SCHEMA, `
    UPDATE graduation_candidates
    SET feedback_session_id=$2
    WHERE id=$1
  `, [candidate.id, session.id]);

  return session.id;
}

async function findGraduationCandidates(team, minSamples = 20, minMatchRate = 0.90) {
  await _ensureTable();

  const rows = await pgPool.query(SHADOW_SCHEMA, `
    SELECT
      team,
      context,
      llm_result->>'decision'                         AS decision,
      COUNT(*)                                         AS total,
      SUM(CASE WHEN match = true  THEN 1 ELSE 0 END)  AS matched
    FROM shadow_log
    WHERE team = $1
      AND llm_result IS NOT NULL
      AND match IS NOT NULL
      AND llm_result->>'decision' IS NOT NULL
    GROUP BY team, context, llm_result->>'decision'
    HAVING COUNT(*) >= $2
    ORDER BY total DESC
  `, [team, minSamples]);

  const candidates = [];
  for (const row of rows) {
    const total     = Number(row.total);
    const matched   = Number(row.matched);
    const matchRate = total > 0 ? matched / total : 0;

    if (matchRate < minMatchRate) continue;

    const candidate = await pgPool.get(SCHEMA, `
      INSERT INTO graduation_candidates
        (team, context, pattern, predicted_decision, sample_count, match_rate, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'candidate', NOW())
      ON CONFLICT (team, context, predicted_decision) DO UPDATE SET
        sample_count = EXCLUDED.sample_count,
        match_rate   = EXCLUDED.match_rate,
        updated_at   = NOW()
      WHERE graduation_candidates.status = 'candidate'
      RETURNING *
    `, [
      row.team,
      row.context,
      JSON.stringify({ context: row.context }),
      row.decision,
      total,
      matchRate,
    ]);

    if (candidate) {
      await _ensureFeedbackSessionForCandidate(candidate);
    }

    candidates.push({
      team:      row.team,
      context:   row.context,
      decision:  row.decision,
      total,
      matchRate: (matchRate * 100).toFixed(1) + '%',
    });
  }

  return candidates;
}

async function startVerification(candidateId) {
  await _ensureTable();
  const row = await pgPool.get(SCHEMA,
    `SELECT * FROM graduation_candidates WHERE id = $1`, [candidateId]
  );
  if (!row) throw new Error(`후보 없음: id=${candidateId}`);
  if (row.status !== 'candidate') throw new Error(`검증 불가 상태: ${row.status}`);

  await pgPool.run(SCHEMA, `
    UPDATE graduation_candidates
    SET status = 'verifying', verified_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [candidateId]);

  return { id: candidateId, team: row.team, context: row.context, decision: row.predicted_decision };
}

async function approveGraduation(candidateId, approvedBy = 'master') {
  await _ensureTable();
  if (approvedBy !== 'master') {
    throw new Error('졸업 승인은 마스터만 가능합니다 (approvedBy: "master" 필수)');
  }

  const row = await pgPool.get(SCHEMA,
    `SELECT * FROM graduation_candidates WHERE id = $1`, [candidateId]
  );
  if (!row) throw new Error(`후보 없음: id=${candidateId}`);
  if (!['verifying', 'candidate'].includes(row.status)) {
    throw new Error(`승인 불가 상태: ${row.status}`);
  }

  const feedbackSessionId = await _ensureFeedbackSessionForCandidate(row);

  await pgPool.run(SCHEMA, `
    UPDATE graduation_candidates
    SET status = 'graduated', approved_by = $1, updated_at = NOW()
    WHERE id = $2
  `, [approvedBy, candidateId]);

  if (feedbackSessionId) {
    await addFeedbackEvent(pgPool, {
      schema: SCHEMA,
      event: {
        feedbackSessionId,
        eventType: FEEDBACK_EVENT_TYPES.CONFIRMED,
        afterValue: {
          candidate_id: candidateId,
          status: 'graduated',
        },
        eventMeta: {
          approved_by: approvedBy,
        },
      },
    });
    await addFeedbackEvent(pgPool, {
      schema: SCHEMA,
      event: {
        feedbackSessionId,
        eventType: FEEDBACK_EVENT_TYPES.COMMITTED,
        afterValue: {
          candidate_id: candidateId,
          status: 'graduated',
        },
        eventMeta: {
          approved_by: approvedBy,
        },
      },
    });
    await updateFeedbackSession(pgPool, {
      schema: SCHEMA,
      sessionId: feedbackSessionId,
      patch: {
        feedbackStatus: FEEDBACK_STATUSES.COMMITTED,
        acceptedWithoutEdit: true,
        submittedSnapshot: {
          candidate_id: candidateId,
          team: row.team,
          context: row.context,
          predicted_decision: row.predicted_decision,
          status: 'graduated',
        },
      },
    });
  }

  return { id: candidateId, graduated: true, approvedBy };
}

async function isGraduated(team, context) {
  try {
    await _ensureTable();
    const row = await pgPool.get(SCHEMA, `
      SELECT predicted_decision, match_rate
      FROM graduation_candidates
      WHERE team = $1 AND context = $2 AND status = 'graduated'
      ORDER BY match_rate DESC
      LIMIT 1
    `, [team, context]);

    if (!row) return null;
    return { graduated: true, decision: row.predicted_decision, matchRate: row.match_rate };
  } catch { return null; }
}

async function weeklyValidation(team) {
  await _ensureTable();
  const graduated = await pgPool.query(SCHEMA, `
    SELECT * FROM graduation_candidates
    WHERE team = $1 AND status = 'graduated'
  `, [team]);

  const reverted = [];
  const cutoff   = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  for (const grad of graduated) {
    const rows = await pgPool.query(SHADOW_SCHEMA, `
      SELECT match
      FROM shadow_log
      WHERE team = $1 AND context = $2
        AND llm_result IS NOT NULL
        AND match IS NOT NULL
        AND created_at > $3
    `, [team, grad.context, cutoff]);

    if (rows.length < 5) continue;

    const mismatched  = rows.filter(r => r.match === false).length;
    const mismatchRate = mismatched / rows.length;

    if (mismatchRate >= 0.20) {
      await pgPool.run(SCHEMA, `
        UPDATE graduation_candidates
        SET status = 'reverted', updated_at = NOW()
        WHERE id = $1
      `, [grad.id]);

      reverted.push({
        id:            grad.id,
        team:          grad.team,
        context:       grad.context,
        decision:      grad.predicted_decision,
        mismatchRate:  (mismatchRate * 100).toFixed(1) + '%',
        reason:        `최근 7일 불일치율 ${(mismatchRate * 100).toFixed(1)}% ≥ 20% — 자동 복귀`,
      });
    }
  }

  return reverted;
}

async function buildGraduationReport(team) {
  await _ensureTable();

  const rows = await pgPool.query(SCHEMA, `
    SELECT status, COUNT(*) AS cnt,
           AVG(match_rate) AS avg_rate
    FROM graduation_candidates
    WHERE team = $1
    GROUP BY status
  `, [team]);

  const byStatus = Object.fromEntries(rows.map(r => [r.status, { cnt: Number(r.cnt), rate: r.avg_rate }]));

  const candidates = await pgPool.query(SCHEMA, `
    SELECT id, context, predicted_decision, sample_count, match_rate, status, updated_at
    FROM graduation_candidates
    WHERE team = $1
    ORDER BY status, match_rate DESC
  `, [team]);

  const lines = [
    `📊 LLM 졸업 현황 (${team}팀)`,
    '════════════════════════',
    `후보:      ${byStatus.candidate?.cnt ?? 0}건`,
    `검증 중:   ${byStatus.verifying?.cnt ?? 0}건`,
    `졸업 완료: ${byStatus.graduated?.cnt ?? 0}건`,
    `복귀됨:    ${byStatus.reverted?.cnt ?? 0}건`,
    '',
  ];

  if (candidates.length > 0) {
    lines.push('상세:');
    for (const c of candidates) {
      const rateStr  = (c.match_rate * 100).toFixed(1) + '%';
      const statusIcon = {
        candidate: '🔍', verifying: '🔄', graduated: '✅', reverted: '↩️',
      }[c.status] ?? '?';
      lines.push(`  ${statusIcon} [${c.context}] ${c.predicted_decision} — ${rateStr} (n=${c.sample_count}) [${c.status}]`);
    }
    lines.push('');
  }

  const graduatedCnt   = byStatus.graduated?.cnt ?? 0;
  const dailySavings   = graduatedCnt * 24 * 0.003;
  const monthlySavings = dailySavings * 30;
  if (graduatedCnt > 0) {
    lines.push(`예상 월 절감: $${monthlySavings.toFixed(2)} (Sonnet 기준)`);
  }

  return lines.join('\n');
}

async function listCandidates(team, status = null) {
  await _ensureTable();
  const params = status ? [team, status] : [team];
  const where  = status
    ? 'WHERE team = $1 AND status = $2'
    : 'WHERE team = $1';
  return pgPool.query(SCHEMA, `
    SELECT id, team, context, predicted_decision, sample_count, match_rate, status, updated_at
    FROM graduation_candidates
    ${where}
    ORDER BY match_rate DESC, sample_count DESC
  `, params);
}

module.exports = {
  findGraduationCandidates,
  startVerification,
  approveGraduation,
  isGraduated,
  weeklyValidation,
  buildGraduationReport,
  listCandidates,
};

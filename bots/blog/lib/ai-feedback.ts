// @ts-nocheck
'use strict';

const crypto = require('crypto');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const {
  ensureAiFeedbackTables,
  createFeedbackSession,
  updateFeedbackSession,
  addFeedbackEvent,
} = require(path.join(__dirname, '../../../packages/core/lib/ai-feedback-store'));
const {
  FEEDBACK_EVENT_TYPES,
  FEEDBACK_STATUSES,
  shouldMarkAcceptedWithoutEdit,
} = require(path.join(__dirname, '../../../packages/core/lib/ai-feedback-core'));

const SCHEMA = 'blog';
const MASTER_USER_ID = 1;

async function ensureBlogFeedbackTables() {
  await ensureAiFeedbackTables(pgPool, { schema: SCHEMA });
  await pgPool.run(SCHEMA, `
    ALTER TABLE blog.curriculum_series
      ADD COLUMN IF NOT EXISTS feedback_session_id BIGINT REFERENCES blog.ai_feedback_sessions(id);
    CREATE INDEX IF NOT EXISTS idx_blog_curriculum_series_feedback_session
      ON blog.curriculum_series(feedback_session_id);
  `);
}

async function createCurriculumProposalSession({
  currentSeries,
  remainingLectures,
  candidates,
}) {
  await ensureBlogFeedbackTables();
  const proposalId = crypto.randomUUID();
  const session = await createFeedbackSession(pgPool, {
    schema: SCHEMA,
    session: {
      companyId: 'blog',
      userId: MASTER_USER_ID,
      sourceType: 'blog_curriculum_planner',
      sourceRefType: 'curriculum_candidate_batch',
      sourceRefId: proposalId,
      flowCode: 'curriculum_planning',
      actionCode: 'recommend_next_series',
      proposalId,
      aiInputText: currentSeries?.series_name || null,
      aiInputPayload: {
        current_series: currentSeries?.series_name || null,
        remaining_lectures: remainingLectures,
      },
      aiOutputType: 'curriculum_candidates',
      originalSnapshot: {
        current_series: currentSeries?.series_name || null,
        remaining_lectures: remainingLectures,
        candidates,
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
        candidates,
      },
      eventMeta: {
        current_series: currentSeries?.series_name || null,
        remaining_lectures: remainingLectures,
      },
    },
  });

  return session;
}

async function markCurriculumProposalConfirmed({
  sessionId,
  chosenTopic,
  chosenRank,
  totalLectures,
}) {
  await addFeedbackEvent(pgPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: sessionId,
      eventType: FEEDBACK_EVENT_TYPES.CONFIRMED,
      afterValue: {
        chosen_topic: chosenTopic,
        total_lectures: totalLectures,
      },
      eventMeta: {
        chosen_rank: chosenRank,
      },
    },
  });

  return updateFeedbackSession(pgPool, {
    schema: SCHEMA,
    sessionId,
    patch: {
      feedbackStatus: FEEDBACK_STATUSES.CONFIRMED,
      acceptedWithoutEdit: true,
      submittedSnapshot: {
        chosen_topic: chosenTopic,
        total_lectures: totalLectures,
      },
    },
  });
}

async function markCurriculumProposalRejected({
  sessionId,
  manualTopic,
}) {
  await addFeedbackEvent(pgPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: sessionId,
      eventType: FEEDBACK_EVENT_TYPES.REJECTED,
      afterValue: {
        manual_topic: manualTopic,
      },
      eventMeta: {
        rejection_mode: 'manual_topic',
      },
    },
  });

  return updateFeedbackSession(pgPool, {
    schema: SCHEMA,
    sessionId,
    patch: {
      feedbackStatus: FEEDBACK_STATUSES.REJECTED,
      acceptedWithoutEdit: false,
      submittedSnapshot: {
        manual_topic: manualTopic,
      },
    },
  });
}

async function markCurriculumProposalCommitted({
  sessionId,
  topic,
  lectureCount,
  seriesId,
}) {
  const acceptedWithoutEdit = shouldMarkAcceptedWithoutEdit(FEEDBACK_STATUSES.COMMITTED, []);

  await addFeedbackEvent(pgPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: sessionId,
      eventType: FEEDBACK_EVENT_TYPES.COMMITTED,
      afterValue: {
        topic,
        lecture_count: lectureCount,
        series_id: seriesId,
      },
      eventMeta: {
        commit_source: 'curriculum_generate',
      },
    },
  });

  return updateFeedbackSession(pgPool, {
    schema: SCHEMA,
    sessionId,
    patch: {
      feedbackStatus: FEEDBACK_STATUSES.COMMITTED,
      acceptedWithoutEdit,
      submittedSnapshot: {
        topic,
        lecture_count: lectureCount,
        series_id: seriesId,
      },
    },
  });
}

async function getLatestPendingCurriculumProposalSession() {
  await ensureBlogFeedbackTables();
  return pgPool.get(SCHEMA, `
    SELECT *
    FROM blog.ai_feedback_sessions
    WHERE source_type='blog_curriculum_planner'
      AND flow_code='curriculum_planning'
      AND feedback_status='pending'
    ORDER BY created_at DESC
    LIMIT 1
  `);
}

module.exports = {
  ensureBlogFeedbackTables,
  createCurriculumProposalSession,
  markCurriculumProposalConfirmed,
  markCurriculumProposalRejected,
  markCurriculumProposalCommitted,
  getLatestPendingCurriculumProposalSession,
};

'use strict';

const path = require('path');

const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const rag = require(path.join(__dirname, '../../../packages/core/lib/rag-safe'));
const {
  FEEDBACK_EVENT_TYPES,
  FEEDBACK_STATUSES,
  buildFieldDiffEvents,
  shouldMarkAcceptedWithoutEdit,
} = require(path.join(__dirname, '../../../packages/core/lib/ai-feedback-core'));
const {
  ensureAiFeedbackTables,
  createFeedbackSession,
  updateFeedbackSession,
  addFeedbackEvent,
  listFeedbackEvents,
  clearFeedbackEditEvents,
  getFeedbackSessionById,
  getFeedbackSessionBySource,
} = require(path.join(__dirname, '../../../packages/core/lib/ai-feedback-store'));
const {
  publishFeedbackSessionToRag,
} = require(path.join(__dirname, '../../../packages/core/lib/feedback-rag'));

const SCHEMA = 'video';
const SOURCE_REF_TYPE = 'edit_step';
const SOURCE_BOT = 'video-feedback';
const FLOW_CODE = 'video_edit';

function createVideoSchemaAdapter() {
  return {
    async query(_schema, sql, params = []) {
      return pgPool.query('public', sql, params);
    },
    async run(_schema, sql, params = []) {
      return pgPool.run('public', sql, params);
    },
    async get(_schema, sql, params = []) {
      return pgPool.get('public', sql, params);
    },
  };
}

const videoFeedbackPool = createVideoSchemaAdapter();

async function ensureVideoFeedbackTables() {
  await pgPool.run('public', `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await ensureAiFeedbackTables(videoFeedbackPool, { schema: SCHEMA });
}

async function createVideoStepFeedbackSession({
  companyId,
  userId,
  sourceType = FLOW_CODE,
  sourceRefType = SOURCE_REF_TYPE,
  sourceRefId,
  flowCode = FLOW_CODE,
  actionCode = 'sync_match',
  proposalId = null,
  aiInputText = null,
  aiInputPayload = {},
  aiOutputType = 'step_proposal',
  originalSnapshot,
  eventMeta = {},
}) {
  if (sourceRefId == null || sourceRefId === '') {
    throw new Error('sourceRefId는 필수입니다.');
  }

  await ensureVideoFeedbackTables();
  const session = await createFeedbackSession(videoFeedbackPool, {
    schema: SCHEMA,
    session: {
      companyId,
      userId,
      sourceType,
      sourceRefType,
      sourceRefId,
      flowCode,
      actionCode,
      proposalId,
      aiInputText,
      aiInputPayload,
      aiOutputType,
      originalSnapshot,
      feedbackStatus: FEEDBACK_STATUSES.PENDING,
      acceptedWithoutEdit: false,
    },
  });

  await addFeedbackEvent(videoFeedbackPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: session.id,
      eventType: FEEDBACK_EVENT_TYPES.PROPOSAL_GENERATED,
      eventMeta,
      afterValue: originalSnapshot,
    },
  });

  return session;
}

async function getVideoFeedbackSessionForStep(stepRefId) {
  return getFeedbackSessionBySource(videoFeedbackPool, {
    schema: SCHEMA,
    sourceRefType: SOURCE_REF_TYPE,
    sourceRefId: stepRefId,
  });
}

async function getVideoFeedbackSessionById(sessionId) {
  return getFeedbackSessionById(videoFeedbackPool, {
    schema: SCHEMA,
    id: sessionId,
  });
}

async function recordVideoFeedbackEdits({
  sessionId,
  originalSnapshot,
  submittedSnapshot,
  eventMeta = {},
}) {
  await clearFeedbackEditEvents(videoFeedbackPool, {
    schema: SCHEMA,
    feedbackSessionId: sessionId,
  });
  const events = buildFieldDiffEvents(originalSnapshot, submittedSnapshot);
  for (const event of events) {
    await addFeedbackEvent(videoFeedbackPool, {
      schema: SCHEMA,
      event: {
        feedbackSessionId: sessionId,
        eventType: event.eventType,
        fieldKey: event.fieldKey,
        beforeValue: event.beforeValue,
        afterValue: event.afterValue,
        eventMeta,
      },
    });
  }
  return events;
}

async function replaceVideoFeedbackEdits({
  sessionId,
  submittedSnapshot,
  eventMeta = {},
}) {
  const session = await getFeedbackSessionById(videoFeedbackPool, {
    schema: SCHEMA,
    id: sessionId,
  });
  if (!session) return [];
  return recordVideoFeedbackEdits({
    sessionId,
    originalSnapshot: session.original_snapshot_json || {},
    submittedSnapshot,
    eventMeta,
  });
}

async function markVideoFeedbackStatus({
  sessionId,
  nextStatus,
  submittedSnapshot,
  eventType,
  eventMeta = {},
}) {
  const events = await listFeedbackEvents(videoFeedbackPool, {
    schema: SCHEMA,
    feedbackSessionId: sessionId,
  });

  await addFeedbackEvent(videoFeedbackPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: sessionId,
      eventType,
      afterValue: submittedSnapshot,
      eventMeta,
    },
  });

  const acceptedWithoutEdit = shouldMarkAcceptedWithoutEdit(nextStatus, events);
  return updateFeedbackSession(videoFeedbackPool, {
    schema: SCHEMA,
    sessionId,
    patch: {
      feedbackStatus: nextStatus,
      acceptedWithoutEdit,
      submittedSnapshot,
    },
  });
}

async function markVideoFeedbackConfirmed(params) {
  return markVideoFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.CONFIRMED,
    eventType: FEEDBACK_EVENT_TYPES.CONFIRMED,
  });
}

async function markVideoFeedbackRejected(params) {
  return markVideoFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.REJECTED,
    eventType: FEEDBACK_EVENT_TYPES.REJECTED,
  });
}

async function publishVideoFeedbackToRag(session) {
  try {
    const events = await listFeedbackEvents(videoFeedbackPool, {
      schema: SCHEMA,
      feedbackSessionId: session.id,
    });
    await publishFeedbackSessionToRag(rag, {
      schema: SCHEMA,
      session,
      events,
      sourceBot: SOURCE_BOT,
    });
  } catch (error) {
    console.warn(`[video-feedback] feedback RAG publish skipped: ${error.message}`);
  }
}

async function markVideoFeedbackSubmitted(params) {
  const updated = await markVideoFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.SUBMITTED,
    eventType: FEEDBACK_EVENT_TYPES.SUBMITTED,
  });
  await publishVideoFeedbackToRag(updated);
  return updated;
}

async function markVideoFeedbackCommitted(params) {
  const updated = await markVideoFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.COMMITTED,
    eventType: FEEDBACK_EVENT_TYPES.COMMITTED,
  });
  await publishVideoFeedbackToRag(updated);
  return updated;
}

module.exports = {
  ensureVideoFeedbackTables,
  createVideoStepFeedbackSession,
  getVideoFeedbackSessionForStep,
  getVideoFeedbackSessionById,
  recordVideoFeedbackEdits,
  replaceVideoFeedbackEdits,
  markVideoFeedbackConfirmed,
  markVideoFeedbackRejected,
  markVideoFeedbackSubmitted,
  markVideoFeedbackCommitted,
};

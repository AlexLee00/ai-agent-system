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

const SCHEMA = 'worker';

async function ensureWorkerFeedbackTables() {
  await ensureAiFeedbackTables(pgPool, { schema: SCHEMA });
}

async function createWorkerProposalFeedbackSession({
  companyId,
  userId,
  sourceType,
  sourceRefType,
  sourceRefId,
  flowCode,
  actionCode,
  proposalId = null,
  aiInputText = null,
  aiInputPayload = {},
  aiOutputType,
  originalSnapshot,
  eventMeta = {},
}) {
  await ensureWorkerFeedbackTables();
  const session = await createFeedbackSession(pgPool, {
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

  await addFeedbackEvent(pgPool, {
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

async function getWorkerFeedbackSessionForTask(taskId) {
  return getFeedbackSessionBySource(pgPool, {
    schema: SCHEMA,
    sourceRefType: 'agent_task',
    sourceRefId: taskId,
  });
}

async function getWorkerFeedbackSessionById(sessionId) {
  return getFeedbackSessionById(pgPool, {
    schema: SCHEMA,
    id: sessionId,
  });
}

async function recordWorkerFeedbackEdits({ sessionId, originalSnapshot, submittedSnapshot, eventMeta = {} }) {
  // TODO: 승인 UI에서 payload 수정이 가능해지면 이 함수를 review-save 시점에 연결한다.
  await clearFeedbackEditEvents(pgPool, {
    schema: SCHEMA,
    feedbackSessionId: sessionId,
  });
  const events = buildFieldDiffEvents(originalSnapshot, submittedSnapshot);
  for (const event of events) {
    await addFeedbackEvent(pgPool, {
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

async function replaceWorkerFeedbackEdits({
  sessionId,
  submittedSnapshot,
  eventMeta = {},
}) {
  const session = await getFeedbackSessionById(pgPool, {
    schema: SCHEMA,
    id: sessionId,
  });
  if (!session) return [];
  return recordWorkerFeedbackEdits({
    sessionId,
    originalSnapshot: session.original_snapshot_json || {},
    submittedSnapshot,
    eventMeta,
  });
}

async function markWorkerFeedbackStatus({
  sessionId,
  nextStatus,
  submittedSnapshot,
  eventType,
  eventMeta = {},
}) {
  const events = await listFeedbackEvents(pgPool, {
    schema: SCHEMA,
    feedbackSessionId: sessionId,
  });

  await addFeedbackEvent(pgPool, {
    schema: SCHEMA,
    event: {
      feedbackSessionId: sessionId,
      eventType,
      afterValue: submittedSnapshot,
      eventMeta,
    },
  });

  const acceptedWithoutEdit = shouldMarkAcceptedWithoutEdit(nextStatus, events);
  return updateFeedbackSession(pgPool, {
    schema: SCHEMA,
    sessionId,
    patch: {
      feedbackStatus: nextStatus,
      acceptedWithoutEdit,
      submittedSnapshot,
    },
  });
}

async function markWorkerFeedbackConfirmed(params) {
  return markWorkerFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.CONFIRMED,
    eventType: FEEDBACK_EVENT_TYPES.CONFIRMED,
  });
}

async function markWorkerFeedbackRejected(params) {
  return markWorkerFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.REJECTED,
    eventType: FEEDBACK_EVENT_TYPES.REJECTED,
  });
}

async function markWorkerFeedbackCommitted(params) {
  const updated = await markWorkerFeedbackStatus({
    ...params,
    nextStatus: FEEDBACK_STATUSES.COMMITTED,
    eventType: FEEDBACK_EVENT_TYPES.COMMITTED,
  });
  try {
    const events = await listFeedbackEvents(pgPool, {
      schema: SCHEMA,
      feedbackSessionId: updated.id,
    });
    await publishFeedbackSessionToRag(rag, {
      schema: SCHEMA,
      session: updated,
      events,
      sourceBot: 'worker-feedback',
    });
  } catch (error) {
    console.warn(`[worker-feedback] feedback RAG publish skipped: ${error.message}`);
  }
  return updated;
}

module.exports = {
  ensureWorkerFeedbackTables,
  createWorkerProposalFeedbackSession,
  getWorkerFeedbackSessionForTask,
  getWorkerFeedbackSessionById,
  recordWorkerFeedbackEdits,
  replaceWorkerFeedbackEdits,
  markWorkerFeedbackConfirmed,
  markWorkerFeedbackRejected,
  markWorkerFeedbackCommitted,
};

// TODO: analytics/export/training dataset 연결 시
// - flow_code/action_code 별 accepted_without_edit 집계
// - 반복 수정 field_key 랭킹
// - source_type 별 승인/반려 전환율 export

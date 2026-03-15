'use strict';

const { publishToRag } = require('./reporting-hub');
const { sanitizeFeedbackValue } = require('./ai-feedback-core');

function createFeedbackRagStoreAdapter(rag) {
  return {
    async store(collection, content, metadata = {}, sourceBot = 'unknown') {
      return rag.store(collection, content, metadata, sourceBot);
    },
  };
}

function formatValue(value) {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeEditEvents(events = []) {
  const editEvents = events.filter((event) => ['field_edited', 'field_added', 'field_removed'].includes(event.event_type || event.eventType));
  const fieldKeys = [...new Set(editEvents.map((event) => event.field_key || event.fieldKey).filter(Boolean))];
  return {
    count: editEvents.length,
    fieldKeys,
  };
}

function buildFeedbackCaseDocument({ schema, session, events = [] }) {
  const original = sanitizeFeedbackValue(session?.original_snapshot_json || {});
  const submitted = sanitizeFeedbackValue(session?.submitted_snapshot_json || {});
  const edits = summarizeEditEvents(events);

  const lines = [
    `[AI 피드백 사례] ${schema} / ${session.flow_code} / ${session.action_code}`,
    `상태: ${session.feedback_status}`,
    `무수정 승인: ${session.accepted_without_edit ? '예' : '아니오'}`,
    `수정 이벤트: ${edits.count}건`,
  ];

  if (session.ai_input_text) {
    lines.push(`입력: ${session.ai_input_text}`);
  }
  if (edits.fieldKeys.length > 0) {
    lines.push(`수정 필드: ${edits.fieldKeys.join(', ')}`);
  }
  lines.push('원본 제안:');
  lines.push(formatValue(original));
  if (Object.keys(submitted || {}).length > 0) {
    lines.push('최종 확정안:');
    lines.push(formatValue(submitted));
  }
  return lines.join('\n');
}

async function publishFeedbackSessionToRag(rag, {
  schema,
  session,
  events = [],
  collection = 'feedback_cases',
  sourceBot = 'feedback',
}) {
  if (!session) return null;
  if (!['submitted', 'committed'].includes(String(session.feedback_status || ''))) {
    return null;
  }

  const sanitizedOriginal = sanitizeFeedbackValue(session.original_snapshot_json || {});
  const sanitizedSubmitted = sanitizeFeedbackValue(session.submitted_snapshot_json || {});
  const editSummary = summarizeEditEvents(events);

  const result = await publishToRag({
    ragStore: createFeedbackRagStoreAdapter(rag),
    collection,
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: schema,
      event_type: 'feedback_case',
      alert_level: 1,
      message: `[AI 피드백] ${schema}/${session.flow_code}/${session.action_code} · ${session.feedback_status}`,
      payload: {
        title: `${schema} ${session.flow_code}`,
        summary: `${session.action_code} · ${session.feedback_status}`,
        details: [
          `무수정 승인: ${session.accepted_without_edit ? '예' : '아니오'}`,
          `수정 이벤트: ${editSummary.count}건`,
          ...(editSummary.fieldKeys.length > 0 ? [`수정 필드: ${editSummary.fieldKeys.join(', ')}`] : []),
        ],
      },
    },
    metadata: {
      schema,
      feedback_session_id: session.id,
      company_id: session.company_id,
      user_id: session.user_id,
      source_type: session.source_type,
      source_ref_type: session.source_ref_type,
      source_ref_id: session.source_ref_id,
      flow_code: session.flow_code,
      action_code: session.action_code,
      feedback_status: session.feedback_status,
      accepted_without_edit: Boolean(session.accepted_without_edit),
      edited_fields: editSummary.fieldKeys,
      edit_count: editSummary.count,
      original_snapshot: sanitizedOriginal,
      submitted_snapshot: sanitizedSubmitted,
    },
    contentBuilder: () => buildFeedbackCaseDocument({
      schema,
      session,
      events,
    }),
    policy: {
      dedupe: true,
      key: `feedback-rag:${schema}:${session.id}:${session.feedback_status}`,
      cooldownMs: 24 * 60 * 60 * 1000,
    },
  });

  return result.id || null;
}

module.exports = {
  buildFeedbackCaseDocument,
  publishFeedbackSessionToRag,
};


const { publishToRag } = require('./reporting-hub.js');
const { sanitizeFeedbackValue } = require('./ai-feedback-core.legacy.js');

type RagLike = {
  store?: (collection: string, content: string, metadata?: Record<string, unknown>, sourceBot?: string) => Promise<unknown>;
  search?: (collection: string, query: string, options?: Record<string, unknown>) => Promise<any[]>;
};

type FeedbackEventRow = {
  event_type?: string;
  eventType?: string;
  field_key?: string;
  fieldKey?: string;
};

type FeedbackSessionRow = {
  id?: number | string;
  flow_code?: string;
  action_code?: string;
  feedback_status?: string;
  accepted_without_edit?: boolean;
  ai_input_text?: string;
  original_snapshot_json?: Record<string, unknown>;
  submitted_snapshot_json?: Record<string, unknown>;
  company_id?: string | null;
  user_id?: number | null;
  source_type?: string;
  source_ref_type?: string;
  source_ref_id?: string | number;
};

function createFeedbackRagStoreAdapter(rag: RagLike) {
  return {
    async store(collection: string, content: string, metadata: Record<string, unknown> = {}, sourceBot = 'unknown') {
      return rag.store?.(collection, content, metadata, sourceBot);
    },
  };
}

function formatValue(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeEditEvents(events: FeedbackEventRow[] = []): { count: number; fieldKeys: string[] } {
  const editEvents = events.filter((event) => ['field_edited', 'field_added', 'field_removed'].includes(String(event.event_type || event.eventType || '')));
  const fieldKeys = [...new Set(editEvents.map((event) => String(event.field_key || event.fieldKey || '')).filter(Boolean))];
  return {
    count: editEvents.length,
    fieldKeys,
  };
}

function buildFeedbackCaseDocument({ schema, session, events = [] }: { schema: string; session: FeedbackSessionRow; events?: FeedbackEventRow[] }): string {
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
  if (Object.keys((submitted as Record<string, unknown>) || {}).length > 0) {
    lines.push('최종 확정안:');
    lines.push(formatValue(submitted));
  }
  return lines.join('\n');
}

function formatFeedbackCaseHits(hits: any[] = []) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  return hits.map((hit) => ({
    id: hit.id,
    summary: String(hit?.metadata?.summary || hit?.metadata?.title || '').trim(),
    flow_code: String(hit?.metadata?.flow_code || ''),
    action_code: String(hit?.metadata?.action_code || ''),
    accepted_without_edit: Boolean(hit?.metadata?.accepted_without_edit),
    edited_fields: Array.isArray(hit?.metadata?.edited_fields) ? hit.metadata.edited_fields : [],
    similarity: Number(hit?.similarity || 0),
    preview: String(hit?.content || '').slice(0, 220),
    created_at: hit?.created_at || null,
  }));
}

async function searchFeedbackCases(
  rag: RagLike,
  {
    schema,
    flowCode = null,
    actionCode = null,
    query,
    limit = 3,
    threshold = 0.45,
    acceptedWithoutEditOnly = false,
    sourceBot = 'worker-feedback',
  }: {
    schema: string;
    flowCode?: string | null;
    actionCode?: string | null;
    query: string;
    limit?: number;
    threshold?: number;
    acceptedWithoutEditOnly?: boolean;
    sourceBot?: string;
  },
) {
  if (!rag || typeof rag.search !== 'function' || !schema || !query) return [];
  try {
    const filter = {
      schema,
      feedback_status: 'committed',
      ...(flowCode ? { flow_code: flowCode } : {}),
      ...(actionCode ? { action_code: actionCode } : {}),
      ...(acceptedWithoutEditOnly ? { accepted_without_edit: true } : {}),
    };
    const hits = await rag.search('feedback_cases', String(query).slice(0, 240), {
      limit,
      threshold,
      filter,
      sourceBot,
    });
    return formatFeedbackCaseHits(hits);
  } catch {
    return [];
  }
}

async function publishFeedbackSessionToRag(
  rag: RagLike,
  {
    schema,
    session,
    events = [],
    collection = 'feedback_cases',
    sourceBot = 'feedback',
  }: {
    schema: string;
    session: FeedbackSessionRow | null | undefined;
    events?: FeedbackEventRow[];
    collection?: string;
    sourceBot?: string;
  },
) {
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

export = {
  buildFeedbackCaseDocument,
  formatFeedbackCaseHits,
  publishFeedbackSessionToRag,
  searchFeedbackCases,
};

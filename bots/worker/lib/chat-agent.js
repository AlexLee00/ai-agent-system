'use strict';

const { randomUUID } = require('crypto');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const kst = require(path.join(__dirname, '../../../packages/core/lib/kst'));
const { callWithFallback } = require(path.join(__dirname, '../../../packages/core/lib/llm-fallback'));
const { selectLLMChain } = require(path.join(__dirname, '../../../packages/core/lib/llm-model-selector'));
const { getWorkerLLMSelectorOverrides } = require('./runtime-config');
const {
  createLearnedPatternReloader,
  createPromotedIntentExampleLoader,
  injectDynamicExamples,
  normalizeIntentText,
  buildAutoLearnPattern,
  evaluateAutoPromoteDecision,
} = require(path.join(__dirname, '../../../packages/core/lib/intent-core'));
const {
  ensureIntentTables,
  insertUnrecognizedIntent,
  getPromotedIntentExamples,
  getNamedIntentLearningPath,
  getRecentUnrecognizedIntents,
  upsertPromotionCandidate,
  logPromotionEvent,
  findPromotionCandidateIdByNormalized,
  markUnrecognizedPromoted,
  addLearnedPattern,
} = require(path.join(__dirname, '../../../packages/core/lib/intent-store'));
const { createRequest: createApprovalRequest, attachTarget: attachApprovalTarget } = require('./approval');
const {
  ensureWorkerFeedbackTables,
  createWorkerProposalFeedbackSession,
} = require('./ai-feedback-service');

const SCHEMA = 'worker';
const WORKER_INTENT_LEARNINGS_PATH = getNamedIntentLearningPath('worker');
const learnedPatternReloader = createLearnedPatternReloader({
  filePath: WORKER_INTENT_LEARNINGS_PATH,
  intervalMs: 5 * 60 * 1000,
});
const loadDynamicExamples = createPromotedIntentExampleLoader({
  ttlMs: 5 * 60 * 1000,
  fetchRows: async () => getPromotedIntentExamples(pgPool, { schema: SCHEMA, limit: 20 }),
  maxTextLength: 60,
  confidence: 0.9,
});

async function ensureChatSchema() {
  await ensureIntentTables(pgPool, { schema: SCHEMA });
  await ensureWorkerFeedbackTables();

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS worker.chat_sessions (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES worker.companies(id),
      user_id      INTEGER NOT NULL REFERENCES worker.users(id),
      title        TEXT NOT NULL DEFAULT '새 대화',
      channel      TEXT NOT NULL DEFAULT 'web',
      status       TEXT NOT NULL DEFAULT 'active',
      last_intent  TEXT,
      context      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_worker_chat_sessions_company_user
      ON worker.chat_sessions(company_id, user_id, last_at DESC);
  `);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS worker.chat_messages (
      id           SERIAL PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES worker.chat_sessions(id) ON DELETE CASCADE,
      company_id   TEXT NOT NULL REFERENCES worker.companies(id),
      user_id      INTEGER REFERENCES worker.users(id),
      role         TEXT NOT NULL,
      content      TEXT,
      intent       TEXT,
      metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_worker_chat_messages_session
      ON worker.chat_messages(session_id, created_at);
  `);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS worker.agent_tasks (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT REFERENCES worker.chat_sessions(id) ON DELETE SET NULL,
      company_id    TEXT NOT NULL REFERENCES worker.companies(id),
      user_id       INTEGER REFERENCES worker.users(id),
      target_bot    TEXT NOT NULL,
      task_type     TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'queued',
      approval_id   INTEGER REFERENCES worker.approval_requests(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_worker_agent_tasks_company_status
      ON worker.agent_tasks(company_id, status, created_at DESC);
  `);
}

async function resolveEmployeeId(userId) {
  const row = await pgPool.get(SCHEMA,
    `SELECT id FROM worker.employees WHERE user_id=$1 AND deleted_at IS NULL`,
    [userId]);
  return row?.id || null;
}

async function createSession({ companyId, userId, title, channel = 'web' }) {
  const id = randomUUID();
  const row = await pgPool.get(SCHEMA, `
    INSERT INTO worker.chat_sessions (id, company_id, user_id, title, channel)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [id, companyId, userId, title || '새 대화', channel]);
  return row;
}

async function getSession(sessionId, companyId, userId) {
  return pgPool.get(SCHEMA, `
    SELECT * FROM worker.chat_sessions
    WHERE id=$1 AND company_id=$2 AND user_id=$3 AND deleted_at IS NULL
  `, [sessionId, companyId, userId]);
}

async function listSessions(companyId, userId) {
  return pgPool.query(SCHEMA, `
    SELECT id, title, channel, status, last_intent,
      to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "createdAt",
      to_char(last_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "lastAt"
    FROM worker.chat_sessions
    WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL
    ORDER BY last_at DESC
    LIMIT 100
  `, [companyId, userId]);
}

async function listMessages(sessionId, companyId, userId) {
  return pgPool.query(SCHEMA, `
    SELECT m.id, m.role, m.content, m.intent, m.metadata,
      to_char(m.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
    FROM worker.chat_messages m
    JOIN worker.chat_sessions s ON s.id = m.session_id
    WHERE m.session_id=$1 AND s.company_id=$2 AND s.user_id=$3
    ORDER BY m.created_at ASC, m.id ASC
  `, [sessionId, companyId, userId]);
}

async function saveMessage({ sessionId, companyId, userId, role, content, intent = null, metadata = {} }) {
  return pgPool.run(SCHEMA, `
    INSERT INTO worker.chat_messages (session_id, company_id, user_id, role, content, intent, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [sessionId, companyId, userId || null, role, content || null, intent, JSON.stringify(metadata || {})]);
}

async function updateSession(sessionId, companyId, userId, patch = {}) {
  return pgPool.get(SCHEMA, `
    UPDATE worker.chat_sessions
    SET title       = COALESCE($4, title),
        status      = COALESCE($5, status),
        last_intent = COALESCE($6, last_intent),
        context     = COALESCE($7::jsonb, context),
        updated_at  = NOW(),
        last_at     = NOW()
    WHERE id=$1 AND company_id=$2 AND user_id=$3 AND deleted_at IS NULL
    RETURNING *
  `, [
    sessionId,
    companyId,
    userId,
    patch.title || null,
    patch.status || null,
    patch.last_intent || null,
    patch.context ? JSON.stringify(patch.context) : null,
  ]);
}

function _extractTime(text) {
  const hasMorning = /오전|아침/.test(text);
  const hasAfternoon = /오후|저녁|밤/.test(text);
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*시(?:\s*(반|\d{1,2}\s*분))?/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  let minute = match[2] ? parseInt(match[2], 10) : 0;
  if (!match[2] && match[3]) {
    minute = String(match[3]).includes('반') ? 30 : parseInt(String(match[3]).replace(/\D/g, ''), 10);
  }
  if (hasAfternoon && hour < 12) hour += 12;
  if (hasMorning && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function _dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: kst.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')) };
}

function _composeKstDate(parts, time) {
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  const hh = String(time.hour).padStart(2, '0');
  const mi = String(time.minute).padStart(2, '0');
  return new Date(`${parts.year}-${mm}-${dd}T${hh}:${mi}:00+09:00`);
}

function _extractDate(text) {
  const now = new Date();
  const base = _dateParts(now);
  if (/모레/.test(text)) {
    const d = new Date(`${base.year}-${String(base.month).padStart(2, '0')}-${String(base.day).padStart(2, '0')}T00:00:00+09:00`);
    d.setUTCDate(d.getUTCDate() + 2);
    return _dateParts(d);
  }
  if (/내일/.test(text)) {
    const d = new Date(`${base.year}-${String(base.month).padStart(2, '0')}-${String(base.day).padStart(2, '0')}T00:00:00+09:00`);
    d.setUTCDate(d.getUTCDate() + 1);
    return _dateParts(d);
  }
  if (/오늘/.test(text)) return base;

  let m = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return { year: base.year, month: Number(m[1]), day: Number(m[2]) };

  m = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return { year: base.year, month: Number(m[1]), day: Number(m[2]) };

  return base;
}

function _cleanTitle(text) {
  return text
    .replace(/(내일|오늘|모레)/g, '')
    .replace(/(\d{1,2}\/\d{1,2}|\d{1,2}월\s*\d{1,2}일)/g, '')
    .replace(/(오전|오후|아침|저녁|밤)?\s*\d{1,2}(?::\d{2})?\s*시(\s*(반|\d{1,2}\s*분))?/g, '')
    .replace(/(잡아줘|등록해줘|만들어줘|추가해줘|일정|미팅|회의|약속|리마인더|로 변경|변경해줘|수정해줘|취소해줘|삭제해줘)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRuleIntent(text, session) {
  const normalized = String(text || '').trim();
  const lowered = normalized.toLowerCase();
  const hasScheduleWord = /(일정|미팅|회의|약속|리마인더)/.test(normalized);
  const time = _extractTime(normalized);
  const date = _extractDate(normalized);

  for (const pattern of learnedPatternReloader.getPatterns()) {
    if (pattern.re.test(normalized)) {
      return {
        intent: pattern.intent,
        ...(pattern.args || {}),
        source: 'learned',
      };
    }
  }

  if (/(오늘|내일|이번주|이번 주)?.*(일정|미팅|회의|약속).*(보여|알려|조회|확인)/.test(normalized) ||
      /(오늘|내일).*(뭐 있어|뭐있어)/.test(normalized)) {
    return { intent: 'list_schedule', scope: /내일/.test(normalized) ? 'tomorrow' : /이번\s*주/.test(normalized) ? 'week' : 'today' };
  }

  if ((/취소|삭제/.test(normalized)) && session?.context?.last_schedule_id) {
    return { intent: 'cancel_last_schedule' };
  }

  if ((/변경|수정/.test(normalized) || /로\s*바꿔/.test(lowered)) && time && session?.context?.last_schedule_id) {
    return { intent: 'update_last_schedule', time };
  }

  if ((hasScheduleWord || /잡아줘|등록해줘|만들어줘|추가해줘/.test(normalized)) && time) {
    const type = /미팅|회의/.test(normalized) ? 'meeting' : /리마인더/.test(normalized) ? 'reminder' : 'task';
    const title = _cleanTitle(normalized) || (type === 'meeting' ? '새 미팅' : '새 일정');
    return { intent: 'create_schedule', type, title, date, time };
  }

  if (/(계약서|문서|파일|ocr|검토)/i.test(normalized)) return { intent: 'route_request', target: 'emily' };
  if (/(채용|직원|휴가|출근|퇴근|인사|근태)/.test(normalized)) return { intent: 'route_request', target: 'noah' };
  if (/(급여|월급|명세서)/.test(normalized)) return { intent: 'route_request', target: 'sophie' };
  if (/(매출|리포트|보고서|분석)/.test(normalized)) return { intent: 'route_request', target: 'oliver' };
  if (/(프로젝트|마일스톤|일정표|로드맵)/.test(normalized)) return { intent: 'route_request', target: 'ryan' };
  if (/(일정|캘린더|미팅|회의|리마인더)/.test(normalized)) return { intent: 'route_request', target: 'chloe' };
  if (/(세금|컴플라이언스|규정|신고)/.test(normalized)) return { intent: 'route_request', target: 'oliver' };

  return { intent: 'unknown' };
}

async function parseLlmIntent(text) {
  const selectorOverrides = getWorkerLLMSelectorOverrides();
  const baseSystemPrompt = [
    '당신은 워커팀 자연어 업무 분류기다.',
    '반드시 JSON만 반환한다.',
    'intent는 create_schedule, list_schedule, update_last_schedule, cancel_last_schedule, route_request, unknown 중 하나다.',
    'target는 emily, noah, ryan, chloe, oliver, sophie, marcus 중 하나 또는 null.',
    'datetime은 ISO8601 +09:00 형식 또는 null.',
    '',
    '승인된 예시:',
    '{DYNAMIC_EXAMPLES}',
  ].join('\n');
  const userPrompt = `메시지: ${text}\n\nJSON 형식:\n{"intent":"...","title":null,"type":"task|meeting|reminder|null","datetime":null,"scope":"today|tomorrow|week|null","target":null}`;
  try {
    const dynamicExamples = await loadDynamicExamples();
    const systemPrompt = injectDynamicExamples(baseSystemPrompt, dynamicExamples);
    const result = await callWithFallback({
      chain: selectLLMChain('worker.chat.task_intake', {
        policyOverride: selectorOverrides['worker.chat.task_intake'],
      }),
      systemPrompt,
      userPrompt,
      logMeta: { team: 'worker', bot: 'worker-chat', requestType: 'task_intake' },
    });
    const cleaned = result.text.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function _formatKst(date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: kst.TZ,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

async function _createSchedule(intent, companyId, userId) {
  const employeeId = await resolveEmployeeId(userId);
  const startTime = _composeKstDate(intent.date, intent.time);
  const row = await pgPool.get(SCHEMA, `
    INSERT INTO worker.schedules
      (company_id, title, description, type, start_time, all_day, attendees, reminder, created_by)
    VALUES ($1, $2, $3, $4, $5, FALSE, '[]'::jsonb, 30, $6)
    RETURNING *
  `, [companyId, intent.title, 'AI 대화로 등록된 일정', intent.type || 'task', startTime.toISOString(), employeeId]);
  return {
    schedule: row,
    reply: `${intent.type === 'meeting' ? '미팅' : '일정'}을 등록했습니다. ${_formatKst(startTime)}, ${row.title}입니다.`,
    ui: {
      type: 'schedule',
      action: 'created',
      schedule: {
        id: row.id,
        title: row.title,
        type: row.type,
        start_time: row.start_time,
        location: row.location,
      },
    },
    contextPatch: {
      last_schedule_id: row.id,
      last_schedule_title: row.title,
      last_schedule_start_time: row.start_time,
    },
  };
}

async function _listSchedules(intent, companyId) {
  let from;
  let to;
  const today = kst.today();
  if (intent.scope === 'tomorrow') {
    from = kst.daysAgoStr(-1);
    to = from;
  } else if (intent.scope === 'week') {
    from = today;
    to = kst.daysAgoStr(-6);
  } else {
    from = today;
    to = today;
  }
  const rows = await pgPool.query(SCHEMA, `
    SELECT id, title, type, start_time, location
    FROM worker.schedules
    WHERE company_id=$1 AND deleted_at IS NULL AND start_time::date BETWEEN $2 AND $3
    ORDER BY start_time ASC
    LIMIT 20
  `, [companyId, from, to]);
  if (!rows.length) {
    return { reply: `${intent.scope === 'tomorrow' ? '내일' : intent.scope === 'week' ? '이번 주' : '오늘'} 등록된 일정이 없습니다.`, ui: { type: 'schedule_list', items: [] } };
  }
  return {
    reply: `${intent.scope === 'tomorrow' ? '내일' : intent.scope === 'week' ? '이번 주' : '오늘'} 일정 ${rows.length}건입니다.`,
    ui: {
      type: 'schedule_list',
      items: rows.map(row => ({
        id: row.id,
        title: row.title,
        type: row.type,
        start_time: row.start_time,
        location: row.location,
      })),
    },
  };
}

async function _updateLastSchedule(intent, companyId, session) {
  const row = await pgPool.get(SCHEMA, `
    SELECT * FROM worker.schedules WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL
  `, [session.context.last_schedule_id, companyId]);
  if (!row) {
    return { reply: '최근 대화에서 만든 일정을 찾지 못했습니다. 다시 일정 이름과 시간을 말씀해주세요.' };
  }
  const existing = new Date(row.start_time);
  const parts = _dateParts(existing);
  const nextTime = _composeKstDate(parts, intent.time);
  const updated = await pgPool.get(SCHEMA, `
    UPDATE worker.schedules
    SET start_time=$1, updated_at=NOW()
    WHERE id=$2 AND company_id=$3
    RETURNING *
  `, [nextTime.toISOString(), row.id, companyId]);
  return {
    reply: `시간을 ${_formatKst(nextTime)}로 변경했습니다.`,
    ui: {
      type: 'schedule',
      action: 'updated',
      schedule: {
        id: updated.id,
        title: updated.title,
        type: updated.type,
        start_time: updated.start_time,
      },
    },
    contextPatch: {
      last_schedule_id: updated.id,
      last_schedule_title: updated.title,
      last_schedule_start_time: updated.start_time,
    },
  };
}

async function _cancelLastSchedule(companyId, session) {
  const row = await pgPool.get(SCHEMA, `
    UPDATE worker.schedules
    SET deleted_at=NOW(), updated_at=NOW()
    WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL
    RETURNING id, title, type
  `, [session.context.last_schedule_id, companyId]);
  if (!row) {
    return { reply: '최근 대화에서 만든 일정을 찾지 못했습니다.' };
  }
  return {
    reply: `${row.title} 일정을 취소했습니다.`,
    ui: { type: 'schedule', action: 'cancelled', schedule: row },
    contextPatch: {
      last_schedule_id: null,
      last_schedule_title: null,
      last_schedule_start_time: null,
    },
  };
}

function _buildRoutedTask(text, intent) {
  const title = _cleanTitle(text) || `${intent.target} 요청`;
  return {
    taskType: 'agent_request',
    title,
    description: text,
    payload: {
      source: 'chat',
      target: intent.target,
      raw_text: text,
    },
  };
}

function _needsApproval(target) {
  return ['noah', 'ryan', 'oliver'].includes(target);
}

async function _queueAgentTask({ text, intent, companyId, userId, sessionId }) {
  const task = _buildRoutedTask(text, intent);
  let approvalId = null;

  if (_needsApproval(intent.target)) {
    const approval = await createApprovalRequest({
      companyId,
      requesterId: userId,
      category: 'agent_task',
      action: `${intent.target}_request`,
      targetTable: 'agent_tasks',
      payload: {
        target_bot: intent.target,
        title: task.title,
        description: task.description,
      },
      priority: intent.target === 'oliver' ? 'high' : 'normal',
    });
    approvalId = approval.id || null;
  }

  const row = await pgPool.get(SCHEMA, `
    INSERT INTO worker.agent_tasks
      (session_id, company_id, user_id, target_bot, task_type, title, description, payload, status, approval_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    RETURNING *
  `, [
    sessionId,
    companyId,
    userId,
    intent.target,
    task.taskType,
    task.title,
    task.description,
    JSON.stringify(task.payload),
    approvalId ? 'pending_approval' : 'queued',
    approvalId,
  ]);

  if (approvalId) {
    await attachApprovalTarget({ requestId: approvalId, targetId: row.id });

    const feedbackSession = await createWorkerProposalFeedbackSession({
      companyId,
      userId,
      sourceType: 'worker_chat',
      sourceRefType: 'agent_task',
      sourceRefId: row.id,
      flowCode: 'worker_chat_route',
      actionCode: `${intent.target}_request`,
      proposalId: String(approvalId),
      aiInputText: text,
      aiInputPayload: {
        raw_text: text,
        parsed_intent: intent,
        session_id: sessionId,
      },
      aiOutputType: 'agent_task',
      originalSnapshot: {
        task_id: row.id,
        target_bot: row.target_bot,
        task_type: row.task_type,
        title: row.title,
        description: row.description,
        payload: task.payload,
        status: row.status,
        approval_id: approvalId,
      },
      eventMeta: {
        session_id: sessionId,
        target_bot: row.target_bot,
        approval_id: approvalId,
      },
    });

    await pgPool.run(SCHEMA, `
      UPDATE worker.agent_tasks
      SET feedback_session_id=$2
      WHERE id=$1
    `, [row.id, feedbackSession.id]);
    await pgPool.run(SCHEMA, `
      UPDATE worker.approval_requests
      SET feedback_session_id=$2
      WHERE id=$1
    `, [approvalId, feedbackSession.id]);
  }

  return {
    task: row,
    approvalId,
    reply: approvalId
      ? `${intent.target} 담당 업무로 등록했습니다. 처리 대기열에 넣었고 승인 요청 #${approvalId}도 생성했습니다.`
      : `${intent.target} 담당 업무로 등록했습니다. 처리 대기열에 넣었습니다.`,
    ui: {
      type: 'route',
      target: intent.target,
      status: approvalId ? 'pending_approval' : 'queued',
      task: {
        id: row.id,
        title: row.title,
        target_bot: row.target_bot,
        status: row.status,
        approval_id: approvalId,
      },
    },
    contextPatch: {
      last_agent_task_id: row.id,
      last_agent_task_target: row.target_bot,
      last_approval_id: approvalId,
    },
  };
}

const SUPPORTED_AGENT_TARGETS = new Set([
  'worker',
  'emily',
  'noah',
  'ryan',
  'chloe',
  'oliver',
  'sophie',
  'marcus',
]);

function normalizeSelectedBot(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SUPPORTED_AGENT_TARGETS.has(normalized)) return null;
  return normalized;
}

function applySelectedBotPreference(intent, selectedBot) {
  if (!selectedBot || selectedBot === 'worker') return intent;
  if (!intent || typeof intent !== 'object') return { intent: 'route_request', target: selectedBot };
  if (intent.intent === 'route_request') {
    return { ...intent, target: selectedBot, source: intent.source || 'selected_bot' };
  }
  if (intent.intent === 'unknown') {
    return { intent: 'route_request', target: selectedBot, source: 'selected_bot' };
  }
  return intent;
}

async function recordWorkerIntentCandidate(text, llmIntent) {
  if (!llmIntent?.intent || llmIntent.intent === 'unknown') return;

  const normalized = normalizeIntentText(text);
  if (!normalized) return;

  const rows = await getRecentUnrecognizedIntents(pgPool, {
    schema: SCHEMA,
    windowDays: 30,
    limit: 500,
  });

  const matching = rows.filter(row =>
    normalizeIntentText(row.text) === normalized &&
    String(row.llm_intent || '') === String(llmIntent.intent || '')
  );

  const pattern = buildAutoLearnPattern(normalized);
  await upsertPromotionCandidate(pgPool, {
    schema: SCHEMA,
    normalizedText: normalized,
    sampleText: text,
    suggestedIntent: llmIntent.intent,
    occurrenceCount: matching.length,
    confidence: Number(llmIntent.confidence || 0.8),
    autoApplied: false,
    learnedPattern: pattern,
  });

  const candidate = await findPromotionCandidateIdByNormalized(pgPool, {
    schema: SCHEMA,
    normalizedText: normalized,
  });

  await logPromotionEvent(pgPool, {
    schema: SCHEMA,
    candidateId: candidate?.id || null,
    normalizedText: normalized,
    sampleText: text,
    suggestedIntent: llmIntent.intent,
    eventType: 'candidate_seen',
    learnedPattern: pattern,
    actor: 'worker-chat',
    metadata: {
      occurrenceCount: matching.length,
      confidence: Number(llmIntent.confidence || 0.8),
    },
  });

  const decision = evaluateAutoPromoteDecision({
    intent: llmIntent.intent,
    occurrenceCount: matching.length,
    confidence: Number(llmIntent.confidence || 0.8),
    pattern,
    team: 'worker',
  });

  if (!decision.allowed || !candidate?.id) {
    if (decision.reason !== 'threshold_count' && decision.reason !== 'threshold_confidence') {
      await logPromotionEvent(pgPool, {
        schema: SCHEMA,
        candidateId: candidate?.id || null,
        normalizedText: normalized,
        sampleText: text,
        suggestedIntent: llmIntent.intent,
        eventType: 'auto_blocked',
        learnedPattern: pattern,
        actor: 'worker-chat',
        metadata: {
          reason: decision.reason,
          threshold: decision.threshold,
        },
      });
    }
    return;
  }

  addLearnedPattern({
    pattern,
    intent: llmIntent.intent,
    filePath: WORKER_INTENT_LEARNINGS_PATH,
  });

  await markUnrecognizedPromoted(pgPool, {
    schema: SCHEMA,
    intent: llmIntent.intent,
    text,
  });

  await upsertPromotionCandidate(pgPool, {
    schema: SCHEMA,
    normalizedText: normalized,
    sampleText: text,
    suggestedIntent: llmIntent.intent,
    occurrenceCount: matching.length,
    confidence: Number(llmIntent.confidence || 0.8),
    autoApplied: true,
    learnedPattern: pattern,
  });

  await logPromotionEvent(pgPool, {
    schema: SCHEMA,
    candidateId: candidate.id,
    normalizedText: normalized,
    sampleText: text,
    suggestedIntent: llmIntent.intent,
    eventType: 'auto_apply',
    learnedPattern: pattern,
    actor: 'worker-chat',
    metadata: {
      threshold: decision.threshold,
      occurrenceCount: matching.length,
      confidence: Number(llmIntent.confidence || 0.8),
    },
  });
}

async function handleChatMessage({ text, sessionId, user, companyId, channel = 'web', aiPolicy = null, agentContext = null }) {
  await ensureChatSchema();

  let session = sessionId
    ? await getSession(sessionId, companyId, user.id)
    : null;

  if (!session) {
    session = await createSession({
      companyId,
      userId: user.id,
      title: String(text || '').trim().slice(0, 40) || '새 대화',
      channel,
    });
  }

  await saveMessage({
    sessionId: session.id,
    companyId,
    userId: user.id,
    role: 'user',
    content: text,
  });

  let intent = parseRuleIntent(text, session);
  let llmIntent = null;
  const allowLlmAssist = aiPolicy?.llm_mode !== 'off';
  const selectedBot = normalizeSelectedBot(agentContext?.selectedBot);
  if (intent.intent === 'unknown' && allowLlmAssist) {
    llmIntent = await parseLlmIntent(text);
    if (llmIntent?.intent && llmIntent.intent !== 'unknown') {
      await insertUnrecognizedIntent(pgPool, {
        schema: SCHEMA,
        text,
        parseSource: 'worker_chat_llm',
        llmIntent: llmIntent.intent,
      });
      await recordWorkerIntentCandidate(text, llmIntent);
      intent = llmIntent;
      if (intent.datetime) {
        const dt = new Date(intent.datetime);
        intent.date = _dateParts(dt);
        intent.time = { hour: Number(new Intl.DateTimeFormat('en-US', { timeZone: kst.TZ, hour: '2-digit', hour12: false }).format(dt)), minute: Number(new Intl.DateTimeFormat('en-US', { timeZone: kst.TZ, minute: '2-digit', hour12: false }).format(dt)) };
      }
    }
  }

  if (intent.intent === 'unknown') {
    await insertUnrecognizedIntent(pgPool, {
      schema: SCHEMA,
      text,
      parseSource: intent.source || 'worker_chat',
      llmIntent: llmIntent?.intent || null,
    });
  }

  intent = applySelectedBotPreference(intent, selectedBot);

  let result;
  switch (intent.intent) {
    case 'create_schedule':
      result = await _createSchedule(intent, companyId, user.id);
      break;
    case 'list_schedule':
      result = await _listSchedules(intent, companyId);
      break;
    case 'update_last_schedule':
      result = await _updateLastSchedule(intent, companyId, session);
      break;
    case 'cancel_last_schedule':
      result = await _cancelLastSchedule(companyId, session);
      break;
    case 'route_request':
      result = await _queueAgentTask({
        text,
        intent,
        companyId,
        userId: user.id,
        sessionId: session.id,
      });
      break;
    default:
      result = {
        reply: '지금은 일정 등록/조회/변경/취소 중심으로 지원하고 있습니다. 예: "내일 오전 10시 김대리 업체 미팅 잡아줘"',
        ui: { type: 'hint', suggestions: ['오늘 일정 보여줘', '내일 오전 10시 미팅 잡아줘', '시간 11시로 변경해줘'] },
      };
      break;
  }

  const nextContext = { ...(session.context || {}), ...(result.contextPatch || {}) };
  await updateSession(session.id, companyId, user.id, {
    last_intent: intent.intent,
    context: nextContext,
  });

  await saveMessage({
    sessionId: session.id,
    companyId,
    userId: user.id,
    role: 'assistant',
    content: result.reply,
    intent: intent.intent,
      metadata: {
      ui: result.ui || null,
      target: intent.target || null,
      selected_bot: selectedBot,
      llm_mode: aiPolicy?.llm_mode || null,
      llm_used: Boolean(llmIntent?.intent && allowLlmAssist),
    },
  });

  return {
    sessionId: session.id,
    reply: result.reply,
    intent: intent.intent,
    ui: result.ui || null,
    aiPolicy: aiPolicy || null,
    selectedBot,
  };
}

module.exports = {
  ensureChatSchema,
  createSession,
  getSession,
  listSessions,
  listMessages,
  saveMessage,
  updateSession,
  handleChatMessage,
  resolveEmployeeId,
};

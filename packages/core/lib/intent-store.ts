import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  buildPromotionCandidateWhere,
  buildPromotionEventWhere,
  buildUnrecognizedReportQueries,
} = require('./intent-core');

type PgPool = {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<unknown>;
  get: (schema: string, sql: string, params?: unknown[]) => Promise<any>;
  query: (schema: string, sql: string, params?: unknown[]) => Promise<any[]>;
};

type LearningItem = {
  re: string;
  intent: string;
  args?: Record<string, unknown>;
};

function safeSchema(schema = 'claude'): string {
  const value = String(schema || 'claude').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid_intent_schema:${schema}`);
  }
  return value;
}

function q(schema: string, table: string): string {
  return `${safeSchema(schema)}.${table}`;
}

function getAgentWorkspace(): string {
  const home = process.env.AI_AGENT_HOME
    || process.env.JAY_HOME
    || path.join(os.homedir(), '.ai-agent-system');
  return process.env.AI_AGENT_WORKSPACE
    || process.env.JAY_WORKSPACE
    || process.env.OPENCLAW_WORKSPACE
    || path.join(home, 'workspace');
}

function getIntentLearningPath(explicitPath = ''): string {
  if (explicitPath) return explicitPath;
  return path.join(getAgentWorkspace(), 'nlp-learnings.json');
}

function getNamedIntentLearningPath(name = 'jay'): string {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized || normalized === 'jay' || normalized === 'default') {
    return getIntentLearningPath();
  }
  return path.join(getAgentWorkspace(), `${normalized}-nlp-learnings.json`);
}

function readIntentLearnings(filePath = ''): { path: string; items: LearningItem[] } {
  const targetPath = getIntentLearningPath(filePath);
  try {
    if (!fs.existsSync(targetPath)) return { path: targetPath, items: [] };
    return { path: targetPath, items: JSON.parse(fs.readFileSync(targetPath, 'utf8')) as LearningItem[] };
  } catch {
    return { path: targetPath, items: [] };
  }
}

function writeIntentLearnings(items: LearningItem[] = [], filePath = ''): string {
  const targetPath = getIntentLearningPath(filePath);
  fs.writeFileSync(targetPath, JSON.stringify(items, null, 2));
  return targetPath;
}

function removeLearnedPatterns({ learnedPattern, sampleText, filePath = '' }: { learnedPattern?: string; sampleText?: string; filePath?: string } = {}) {
  const { path: targetPath, items } = readIntentLearnings(filePath);
  const nextItems = items.filter((item) => {
    if (learnedPattern && item.re === learnedPattern) return false;
    if (sampleText && item.re === sampleText) return false;
    return true;
  });
  if (nextItems.length !== items.length) {
    writeIntentLearnings(nextItems, targetPath);
  }
  return { changed: nextItems.length !== items.length, path: targetPath, items: nextItems };
}

function addLearnedPattern({ pattern, intent, filePath = '' }: { pattern?: string; intent?: string; filePath?: string } = {}) {
  if (!pattern || !intent) return { changed: false, path: getIntentLearningPath(filePath) };
  const { path: targetPath, items } = readIntentLearnings(filePath);
  if (items.some((item) => item.re === pattern)) {
    return { changed: false, path: targetPath, items };
  }
  const nextItems = [...items, { re: pattern, intent, args: {} }];
  writeIntentLearnings(nextItems, targetPath);
  return { changed: true, path: targetPath, items: nextItems };
}

async function ensureIntentTables(pgPool: PgPool | null | undefined, { schema = 'claude' }: { schema?: string } = {}): Promise<void> {
  if (!pgPool) return;
  const unrecTable = q(schema, 'unrecognized_intents');
  const candidateTable = q(schema, 'intent_promotion_candidates');
  const eventTable = q(schema, 'intent_promotion_events');
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS ${unrecTable} (
      id           SERIAL PRIMARY KEY,
      text         TEXT NOT NULL,
      parse_source TEXT,
      llm_intent   TEXT,
      promoted_to  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_unrec_created_${safeSchema(schema)} ON ${unrecTable}(created_at DESC)
  `);
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS ${candidateTable} (
      id               SERIAL PRIMARY KEY,
      normalized_text  TEXT NOT NULL UNIQUE,
      sample_text      TEXT NOT NULL,
      suggested_intent TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      confidence       NUMERIC(5,4) NOT NULL DEFAULT 0,
      auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
      learned_pattern  TEXT,
      first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_promotion_candidates_last_seen_${safeSchema(schema)}
    ON ${candidateTable}(last_seen_at DESC)
  `);
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS ${eventTable} (
      id               SERIAL PRIMARY KEY,
      candidate_id     INTEGER,
      normalized_text  TEXT,
      sample_text      TEXT,
      suggested_intent TEXT,
      event_type       TEXT NOT NULL,
      learned_pattern  TEXT,
      actor            TEXT NOT NULL DEFAULT 'system',
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_promotion_events_created_${safeSchema(schema)}
    ON ${eventTable}(created_at DESC)
  `);
}

async function logPromotionEvent(
  pgPool: PgPool | null | undefined,
  {
    schema = 'claude',
    candidateId = null,
    normalizedText = null,
    sampleText = null,
    suggestedIntent = null,
    eventType,
    learnedPattern = null,
    actor = 'system',
    metadata = {},
  }: {
    schema?: string;
    candidateId?: number | null;
    normalizedText?: string | null;
    sampleText?: string | null;
    suggestedIntent?: string | null;
    eventType?: string;
    learnedPattern?: string | null;
    actor?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  if (!pgPool || !eventType) return;
  await pgPool.run(schema, `
    INSERT INTO ${q(schema, 'intent_promotion_events')} (
      candidate_id, normalized_text, sample_text, suggested_intent,
      event_type, learned_pattern, actor, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    candidateId,
    normalizedText,
    sampleText,
    suggestedIntent,
    eventType,
    learnedPattern,
    actor,
    JSON.stringify(metadata || {}),
  ]);
}

async function upsertPromotionCandidate(
  pgPool: PgPool | null | undefined,
  {
    schema = 'claude',
    normalizedText,
    sampleText,
    suggestedIntent,
    occurrenceCount,
    confidence,
    autoApplied,
    learnedPattern,
  }: {
    schema?: string;
    normalizedText?: string;
    sampleText?: string;
    suggestedIntent?: string;
    occurrenceCount?: number;
    confidence?: number;
    autoApplied?: boolean;
    learnedPattern?: string | null;
  } = {},
): Promise<void> {
  if (!pgPool || !normalizedText || !suggestedIntent) return;
  await pgPool.run(schema, `
    INSERT INTO ${q(schema, 'intent_promotion_candidates')} (
      normalized_text, sample_text, suggested_intent, occurrence_count,
      confidence, auto_applied, learned_pattern, first_seen_at, last_seen_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
    ON CONFLICT (normalized_text) DO UPDATE
    SET sample_text      = EXCLUDED.sample_text,
        suggested_intent = EXCLUDED.suggested_intent,
        occurrence_count = EXCLUDED.occurrence_count,
        confidence       = EXCLUDED.confidence,
        auto_applied     = ${q(schema, 'intent_promotion_candidates')}.auto_applied OR EXCLUDED.auto_applied,
        learned_pattern  = COALESCE(${q(schema, 'intent_promotion_candidates')}.learned_pattern, EXCLUDED.learned_pattern),
        last_seen_at     = NOW(),
        updated_at       = NOW()
  `, [
    normalizedText,
    sampleText,
    suggestedIntent,
    occurrenceCount,
    confidence,
    !!autoApplied,
    learnedPattern || null,
  ]);
}

async function insertUnrecognizedIntent(pgPool: PgPool | null | undefined, { schema = 'claude', text, parseSource, llmIntent }: { schema?: string; text?: string; parseSource?: string; llmIntent?: string | null } = {}): Promise<void> {
  if (!pgPool || !text) return;
  await pgPool.run(schema, `
    INSERT INTO ${q(schema, 'unrecognized_intents')} (text, parse_source, llm_intent)
    VALUES ($1, $2, $3)
  `, [
    String(text).slice(0, 500),
    parseSource || 'unknown',
    llmIntent || null,
  ]);
}

async function getPromotionSummary(pgPool: PgPool, { schema = 'claude', filters = {} }: { schema?: string; filters?: Record<string, unknown> } = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters);
  return pgPool.get(schema, `
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE auto_applied = true)::int AS applied_count,
      COUNT(*) FILTER (WHERE auto_applied = false)::int AS pending_count
    FROM ${q(schema, 'intent_promotion_candidates')}
    ${candidateWhere.whereSql}
  `, candidateWhere.params);
}

async function getPromotionRows(pgPool: PgPool, { schema = 'claude', filters = {}, limit = 20 }: { schema?: string; filters?: Record<string, unknown>; limit?: number } = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters, { tableAlias: 'c' });
  return pgPool.query(schema, `
    SELECT
      c.id,
      c.sample_text,
      c.suggested_intent,
      c.occurrence_count,
      c.confidence,
      c.auto_applied,
      c.updated_at,
      e.event_type AS latest_event_type,
      e.metadata AS latest_event_metadata
    FROM ${q(schema, 'intent_promotion_candidates')} c
    LEFT JOIN LATERAL (
      SELECT event_type, metadata
      FROM ${q(schema, 'intent_promotion_events')}
      WHERE candidate_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) e ON true
    ${candidateWhere.whereSql}
    ORDER BY c.auto_applied DESC, c.updated_at DESC
    LIMIT ${Number(limit)}
  `, candidateWhere.params);
}

async function getPromotionFamilyRows(pgPool: PgPool, { schema = 'claude', filters = {}, limit = 200 }: { schema?: string; filters?: Record<string, unknown>; limit?: number } = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters);
  return pgPool.query(schema, `
    SELECT suggested_intent, auto_applied, occurrence_count
    FROM ${q(schema, 'intent_promotion_candidates')}
    ${candidateWhere.whereSql}
    ORDER BY updated_at DESC
    LIMIT ${Number(limit)}
  `, candidateWhere.params);
}

async function getPromotionEvents(pgPool: PgPool, { schema = 'claude', filters = {}, limit = 10 }: { schema?: string; filters?: Record<string, unknown>; limit?: number } = {}) {
  const eventWhere = buildPromotionEventWhere(filters);
  return pgPool.query(schema, `
    SELECT event_type, sample_text, suggested_intent, actor, created_at
    FROM ${q(schema, 'intent_promotion_events')}
    ${eventWhere.whereSql}
    ORDER BY created_at DESC
    LIMIT ${Number(limit)}
  `, eventWhere.params);
}

async function findPromotionCandidate(
  pgPool: PgPool,
  {
    schema = 'claude',
    candidateId,
    normalizedText,
    rawText,
  }: { schema?: string; candidateId?: number; normalizedText?: string; rawText?: string } = {},
) {
  if (Number.isFinite(candidateId)) {
    return pgPool.get(schema, `
      SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
      FROM ${q(schema, 'intent_promotion_candidates')}
      WHERE id = $1
      LIMIT 1
    `, [candidateId]);
  }
  return pgPool.get(schema, `
    SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
    FROM ${q(schema, 'intent_promotion_candidates')}
    WHERE normalized_text = $1 OR sample_text = $2
    LIMIT 1
  `, [normalizedText, rawText]);
}

async function getUnrecognizedReportRows(pgPool: PgPool, { schema = 'claude', days = 7, candidateLimit = 20 }: { schema?: string; days?: number; candidateLimit?: number } = {}) {
  const queries = buildUnrecognizedReportQueries({
    days,
    candidateLimit,
    unrecognizedTable: q(schema, 'unrecognized_intents'),
    candidateTable: q(schema, 'intent_promotion_candidates'),
    eventTable: q(schema, 'intent_promotion_events'),
  });
  const [rows, candidates] = await Promise.all([
    pgPool.query(schema, queries.unrecognizedSql),
    pgPool.query(schema, queries.candidatesSql),
  ]);
  return { rows, candidates };
}

async function getRecentUnrecognizedIntents(pgPool: PgPool, { schema = 'claude', windowDays = 30, limit = 500 }: { schema?: string; windowDays?: number; limit?: number } = {}) {
  return pgPool.query(schema, `
    SELECT id, text, llm_intent, promoted_to
    FROM ${q(schema, 'unrecognized_intents')}
    WHERE created_at > NOW() - ($1::text || ' days')::interval
    ORDER BY created_at DESC
    LIMIT ${Number(limit)}
  `, [String(windowDays)]);
}

async function getPromotedIntentExamples(pgPool: PgPool | null | undefined, { schema = 'claude', limit = 30 }: { schema?: string; limit?: number } = {}) {
  if (!pgPool) return [];
  return pgPool.query(schema, `
    SELECT DISTINCT ON (promoted_to) text, promoted_to
    FROM ${q(schema, 'unrecognized_intents')}
    WHERE promoted_to IS NOT NULL
    ORDER BY promoted_to, created_at DESC
    LIMIT ${Number(limit)}
  `);
}

async function findPromotionCandidateIdByNormalized(pgPool: PgPool | null | undefined, { schema = 'claude', normalizedText }: { schema?: string; normalizedText?: string } = {}) {
  if (!pgPool || !normalizedText) return null;
  return pgPool.get(schema, `
    SELECT id FROM ${q(schema, 'intent_promotion_candidates')} WHERE normalized_text = $1 LIMIT 1
  `, [normalizedText]);
}

async function clearPromotedUnrecognized(pgPool: PgPool | null | undefined, { schema = 'claude', suggestedIntent, normalizedText }: { schema?: string; suggestedIntent?: string; normalizedText?: string } = {}) {
  if (!pgPool || !suggestedIntent || !normalizedText) return;
  await pgPool.run(schema, `
    UPDATE ${q(schema, 'unrecognized_intents')}
    SET promoted_to = NULL
    WHERE promoted_to = $1
      AND lower(regexp_replace(text, '[^[:alnum:][:space:]]', ' ', 'g')) LIKE '%' || $2 || '%'
  `, [suggestedIntent, normalizedText]);
}

async function clearPromotionCandidateState(pgPool: PgPool | null | undefined, { schema = 'claude', candidateId }: { schema?: string; candidateId?: number } = {}) {
  if (!pgPool || !candidateId) return;
  await pgPool.run(schema, `
    UPDATE ${q(schema, 'intent_promotion_candidates')}
    SET auto_applied = FALSE,
        learned_pattern = NULL,
        updated_at = NOW()
    WHERE id = $1
  `, [candidateId]);
}

async function markUnrecognizedPromoted(
  pgPool: PgPool | null | undefined,
  {
    schema = 'claude',
    intent,
    recordIds = [],
    text,
  }: { schema?: string; intent?: string; recordIds?: number[]; text?: string } = {},
): Promise<void> {
  if (!pgPool || !intent) return;
  if (Array.isArray(recordIds) && recordIds.length > 0) {
    await pgPool.run(schema, `
    UPDATE ${q(schema, 'unrecognized_intents')}
    SET promoted_to = $1
      WHERE id = ANY($2::int[]) AND promoted_to IS NULL
    `, [intent, recordIds]);
    return;
  }
  if (text) {
    await pgPool.run(schema, `
      UPDATE unrecognized_intents
      SET promoted_to = $1
      WHERE text = $2 AND promoted_to IS NULL
    `, [intent, text]);
  }
}

export = {
  getIntentLearningPath,
  getNamedIntentLearningPath,
  readIntentLearnings,
  writeIntentLearnings,
  removeLearnedPatterns,
  addLearnedPattern,
  ensureIntentTables,
  logPromotionEvent,
  upsertPromotionCandidate,
  insertUnrecognizedIntent,
  getPromotionSummary,
  getPromotionRows,
  getPromotionFamilyRows,
  getPromotionEvents,
  findPromotionCandidate,
  getUnrecognizedReportRows,
  getRecentUnrecognizedIntents,
  getPromotedIntentExamples,
  findPromotionCandidateIdByNormalized,
  clearPromotedUnrecognized,
  clearPromotionCandidateState,
  markUnrecognizedPromoted,
};

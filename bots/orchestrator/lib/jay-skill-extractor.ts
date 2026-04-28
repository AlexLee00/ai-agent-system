'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pgPool = require('../../../packages/core/lib/pg-pool');

const SKILL_TABLE = 'agent.jay_skill_memory';
let ensurePromise = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseBoolean(value, fallback = false) {
  const text = normalizeText(value, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function buildSkillId(seed) {
  const hash = crypto
    .createHash('sha1')
    .update(seed)
    .digest('hex')
    .slice(0, 14);
  return `jskill_${hash}`;
}

function mirrorPath() {
  if (process.env.JAY_SKILL_FILE_MIRROR_PATH) return process.env.JAY_SKILL_FILE_MIRROR_PATH;
  const root = process.env.JAY_RUNTIME_DIR
    || process.env.HUB_RUNTIME_DIR
    || path.join(os.homedir(), '.ai-agent-system', 'jay');
  return path.join(root, 'skills', 'jay-skill-memory.jsonl');
}

function skillArtifactRoot() {
  return process.env.JAY_SKILL_ARTIFACT_ROOT
    || path.join(__dirname, '..', '..', '..', 'packages', 'core', 'lib', 'skills', 'jay');
}

function slugifySkillTopic(value) {
  const slug = normalizeText(value, 'general')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'general';
}

function appendMirrorLine(record) {
  if (!parseBoolean(process.env.JAY_SKILL_FILE_MIRROR, false)) return;
  const target = mirrorPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
}

function writeSkillArtifact(record) {
  if (!parseBoolean(process.env.JAY_SKILL_ARTIFACT_WRITE, false)) return null;
  const team = slugifySkillTopic(record.team || 'general');
  const topic = slugifySkillTopic(record.strategy_key || record.strategyKey || record.id || 'general');
  const dir = path.join(skillArtifactRoot(), team, topic);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'SKILL.md');
  const summary = normalizeText(record.summary, 'No summary recorded.');
  const outcome = normalizeText(record.outcome_status || record.outcomeStatus, 'completed');
  const confidence = Number(record.confidence || 0);
  const evidence = JSON.stringify(record.evidence || {}, null, 2);
  const markdown = [
    `# Jay Skill: ${team}/${topic}`,
    '',
    '## When To Use',
    `Use this when a Jay incident matches strategy \`${normalizeText(record.strategy_key || record.strategyKey, topic)}\`.`,
    '',
    '## Learned Pattern',
    summary,
    '',
    '## Outcome',
    `- status: ${outcome}`,
    `- confidence: ${confidence.toFixed(2)}`,
    '',
    '## Evidence',
    '```json',
    evidence,
    '```',
    '',
    '## Guardrails',
    '- Re-verify live state before mutating actions.',
    '- Prefer Hub control-plane tools and team commander contracts.',
    '',
  ].join('\n');
  fs.writeFileSync(target, markdown, 'utf8');
  return target;
}

async function ensureJaySkillMemoryTable() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${SKILL_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL,
        team TEXT NOT NULL,
        strategy_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        outcome_status TEXT NOT NULL DEFAULT 'completed',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_skill_memory_team_idx
      ON ${SKILL_TABLE} (team, updated_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_skill_memory_strategy_idx
      ON ${SKILL_TABLE} (strategy_key, updated_at DESC)
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

function inferStrategyKey(input) {
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const goal = normalizeText(input?.goal || input?.summary || '', '').toLowerCase().slice(0, 120);
  const normalizedGoal = goal.replace(/[^a-z0-9가-힣]+/g, '_').replace(/^_+|_+$/g, '');
  return `${team}:${normalizedGoal || 'general_incident'}`;
}

function extractSkillRecord(input) {
  const incidentKey = normalizeText(input?.incidentKey, '');
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const summary = normalizeText(input?.summary || input?.reflection, '');
  if (!summary) return { ok: false, error: 'skill_summary_required' };
  const strategyKey = normalizeText(input?.strategyKey, inferStrategyKey(input));
  const evidence = normalizeObject(input?.evidence);
  const outcomeStatus = normalizeText(input?.outcomeStatus, 'completed').toLowerCase();
  const confidenceRaw = Number(input?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.6;
  const id = buildSkillId(`${incidentKey}|${strategyKey}|${summary}`);
  return {
    ok: true,
    data: {
      id,
      incidentKey,
      team,
      strategyKey,
      summary,
      evidence,
      outcomeStatus,
      confidence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

async function saveSkillMemory(input) {
  const parsed = extractSkillRecord(input);
  if (!parsed.ok) return parsed;
  await ensureJaySkillMemoryTable();
  const row = await pgPool.get('agent', `
    INSERT INTO ${SKILL_TABLE} (
      id, incident_key, team, strategy_key, summary, evidence, outcome_status, confidence, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      summary = EXCLUDED.summary,
      evidence = EXCLUDED.evidence,
      outcome_status = EXCLUDED.outcome_status,
      confidence = EXCLUDED.confidence,
      updated_at = NOW()
    RETURNING
      id, incident_key, team, strategy_key, summary, evidence, outcome_status, confidence,
      to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
      to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
  `, [
    parsed.data.id,
    parsed.data.incidentKey,
    parsed.data.team,
    parsed.data.strategyKey,
    parsed.data.summary,
    JSON.stringify(parsed.data.evidence),
    parsed.data.outcomeStatus,
    parsed.data.confidence,
  ]);
  appendMirrorLine(row || parsed.data);
  const artifactPath = writeSkillArtifact(row || parsed.data);
  return { ok: true, skill: row || parsed.data, artifactPath };
}

async function listRecentSkills(input = {}) {
  await ensureJaySkillMemoryTable();
  const team = normalizeText(input?.team, '').toLowerCase();
  const strategyKey = normalizeText(input?.strategyKey, '');
  const limit = Math.max(1, Number(input?.limit || 8) || 8);
  const days = Math.max(1, Number(input?.days || 30) || 30);
  const rows = await pgPool.query('agent', `
    SELECT
      id, incident_key, team, strategy_key, summary, evidence, outcome_status, confidence,
      to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
      to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS updated_at
    FROM ${SKILL_TABLE}
    WHERE ($1 = '' OR team = $1)
      AND ($2 = '' OR strategy_key = $2)
      AND updated_at >= NOW() - ($3::int || ' days')::interval
    ORDER BY confidence DESC, updated_at DESC
    LIMIT $4
  `, [team, strategyKey, days, limit]);
  return rows;
}

async function buildSkillContextForPlan(input = {}) {
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const strategyKey = normalizeText(input?.strategyKey, '');
  const rows = await listRecentSkills({
    team,
    strategyKey,
    limit: Number(input?.limit || 5),
    days: Number(input?.days || 45),
  });
  if (!rows.length) {
    return {
      ok: true,
      context: '',
      skills: [],
    };
  }
  const lines = ['Recent reusable skills:'];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. [${row.strategy_key}] ${row.summary}`);
  });
  return {
    ok: true,
    context: lines.join('\n'),
    skills: rows,
  };
}

module.exports = {
  ensureJaySkillMemoryTable,
  saveSkillMemory,
  listRecentSkills,
  buildSkillContextForPlan,
  _testOnly: {
    inferStrategyKey,
    extractSkillRecord,
    mirrorPath,
    skillArtifactRoot,
    slugifySkillTopic,
    writeSkillArtifact,
    SKILL_TABLE,
  },
};

#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeLibraryCoords } from '../shared/library-coords.ts';
import {
  extractSourceRef,
  normalizeSourceRef,
  sourceRefKey,
} from '../shared/source-ref.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool.ts'));

const COORD_COLUMNS = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

export function rowCoords(row = {}) {
  const meta = parseMeta(row.meta);
  return normalizeLibraryCoords({
    ...(meta.libraryCoords || {}),
    abstraction_level: row.abstraction_level || meta.libraryCoords?.abstraction_level,
    time_stage: row.time_stage || meta.libraryCoords?.time_stage,
    validation_state: row.validation_state || meta.libraryCoords?.validation_state,
    prediction_state: row.prediction_state || meta.libraryCoords?.prediction_state,
    prediction_horizon: row.prediction_horizon || meta.libraryCoords?.prediction_horizon,
  });
}

function rowText(row = {}) {
  return [
    row.title,
    row.type,
    row.source,
    row.file_path,
    row.content,
    typeof row.meta === 'string' ? row.meta : JSON.stringify(row.meta || {}),
  ].filter(Boolean).join('\n').toLowerCase();
}

function normalizeEvidenceLink(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    return value.id || value.entryId || value.url || value.filePath || value.source || JSON.stringify(value);
  }
  return String(value);
}

function normalizePolarity(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'positive' || text === 'success' || text === 'validated') return 'positive';
  if (text === 'negative' || text === 'failure' || text === 'contradicted') return 'negative';
  return 'neutral';
}

export function normalizeLessonKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\u3131-\uD79Da-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function entryLessonKey(row = {}, trigger = {}) {
  const meta = parseMeta(row.meta);
  return normalizeLessonKey(
    trigger.lessonKey
    || trigger.lesson
    || trigger.evidence?.lesson
    || meta.validation_lesson_key
    || meta.lesson
    || meta.titlePattern?.label
    || row.title
    || row.file_path
  );
}

function valueEquals(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function changedPatch(current = {}, desired = {}) {
  return Object.fromEntries(
    Object.entries(desired || {}).filter(([key, value]) => !valueEquals(current?.[key], value)),
  );
}

export function isSigmaTransitionEnabled(env = process.env) {
  return String(env.SIGMA_TRANSITION_ENABLED || '').toLowerCase() === 'true';
}

export function isSigmaPredictionEnabled(env = process.env) {
  return String(env.SIGMA_PREDICTION_ENABLED || '').toLowerCase() === 'true';
}

function predictionOutcomeForValidation(validationState) {
  if (validationState === 'validated') return 'hit';
  if (validationState === 'contradicted') return 'miss';
  return null;
}

function horizonDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function horizonBucket(row = {}) {
  const coords = row.coords || rowCoords(row);
  const horizon = horizonDate(coords.prediction_horizon);
  if (!horizon) return 'unknown';
  const created = horizonDate(row.created_at);
  if (!created) return 'unknown';
  const days = (horizon.getTime() - created.getTime()) / 86_400_000;
  if (days <= 1) return 'lte_1d';
  if (days <= 7) return 'lte_7d';
  if (days <= 30) return 'lte_30d';
  return 'gt_30d';
}

function accuracyBucket(rows = []) {
  const counts = { total: 0, hit: 0, miss: 0, accuracy: null };
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const coords = row.coords || rowCoords(row);
    const outcome = meta.prediction_outcome || predictionOutcomeForValidation(coords.validation_state);
    if (outcome !== 'hit' && outcome !== 'miss') continue;
    counts.total += 1;
    counts[outcome] += 1;
  }
  counts.accuracy = counts.total > 0 ? counts.hit / counts.total : null;
  return counts;
}

export function buildPredictionAccuracy({ rows = [] } = {}) {
  const resolved = (rows || [])
    .map((row) => ({ ...row, coords: row.coords || rowCoords(row) }))
    .filter((row) => row.coords.prediction_state === 'resolved');
  const bySource = {};
  const byHorizon = {};
  for (const row of resolved) {
    const source = String(row.source || 'unknown');
    const bucket = horizonBucket(row);
    bySource[source] = bySource[source] || [];
    byHorizon[bucket] = byHorizon[bucket] || [];
    bySource[source].push(row);
    byHorizon[bucket].push(row);
  }
  return {
    overall: accuracyBucket(resolved),
    bySource: Object.fromEntries(Object.entries(bySource).map(([key, value]) => [key, accuracyBucket(value)])),
    byHorizon: Object.fromEntries(Object.entries(byHorizon).map(([key, value]) => [key, accuracyBucket(value)])),
  };
}

export function buildPredictionLedgerTransitionPlan({ rows = [], now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const normalizedNow = Number.isFinite(nowDate.getTime()) ? nowDate : new Date();
  return (rows || [])
    .map((row) => ({ ...row, coords: row.coords || rowCoords(row) }))
    .flatMap((row) => {
      const coords = row.coords;
      const horizon = horizonDate(coords.prediction_horizon);
      if (coords.prediction_state === 'forward') {
        if (!horizon || horizon.getTime() > normalizedNow.getTime()) return [];
        return [{
          id: row.id,
          title: row.title || row.file_path || `vault ${row.id}`,
          current: coords,
          nextCoords: { prediction_state: 'due' },
          metaPatch: {
            prediction_due_at: normalizedNow.toISOString(),
          },
          apply: true,
          reason: 'prediction_horizon_due',
        }];
      }
      if (coords.prediction_state === 'due') {
        const outcome = predictionOutcomeForValidation(coords.validation_state);
        if (!outcome) {
          return [{
            id: row.id,
            title: row.title || row.file_path || `vault ${row.id}`,
            current: coords,
            nextCoords: null,
            metaPatch: {},
            apply: false,
            reason: 'validation_unresolved',
          }];
        }
        return [{
          id: row.id,
          title: row.title || row.file_path || `vault ${row.id}`,
          current: coords,
          nextCoords: { prediction_state: 'resolved' },
          metaPatch: {
            prediction_outcome: outcome,
            prediction_resolved_at: normalizedNow.toISOString(),
          },
          apply: true,
          reason: `prediction_${outcome}`,
        }];
      }
      return [];
    });
}

export function buildTeamTransitionPlan({
  vaultRows = [],
  validatedHistoryRows = [],
  triggers = [],
  minPromotionRepeats = 3,
  predictionEnabled = false,
  now = new Date(),
} = {}) {
  const rowsByRef = new Map();
  const normalizeTransitionRow = (row, indexSourceRefs = false) => {
    const meta = parseMeta(row.meta);
    const sourceRefs = [...new Map([
      extractSourceRef(row),
      ...(Array.isArray(meta.source_refs) ? meta.source_refs.map((ref) => normalizeSourceRef(ref)) : []),
    ].filter(Boolean).map((ref) => [sourceRefKey(ref), ref])).values()];
    const sourceRef = sourceRefs[0] || null;
    const refKey = sourceRefKey(sourceRef);
    const normalized = { ...row, parsedMeta: meta, sourceRef, sourceRefs, refKey, coords: rowCoords(row) };
    if (indexSourceRefs) {
      for (const ref of sourceRefs) {
        const key = sourceRefKey(ref);
        if (key && !rowsByRef.has(key)) rowsByRef.set(key, normalized);
      }
    }
    return normalized;
  };
  const normalizedRows = (vaultRows || []).map((row) => normalizeTransitionRow(row, true));
  const normalizedHistoryRows = (validatedHistoryRows || []).map((row) => normalizeTransitionRow(row));

  const plans = (triggers || []).map((trigger) => {
    const sourceRef = normalizeSourceRef(trigger.source_ref || trigger.sourceRef || trigger);
    const refKey = sourceRefKey(sourceRef);
    const row = refKey ? rowsByRef.get(refKey) : null;
    const polarity = normalizePolarity(trigger.polarity || trigger.outcome);
    const nextValidationState = polarity === 'positive'
      ? 'validated'
      : polarity === 'negative'
        ? 'contradicted'
        : null;
    const lessonKey = entryLessonKey(row || {}, trigger);
    const desiredCoords = {};
    if (row && nextValidationState && row.coords.validation_state !== nextValidationState) {
      desiredCoords.validation_state = nextValidationState;
    }
    const pAxisOutcome = predictionEnabled && row?.coords?.prediction_state === 'due'
      ? predictionOutcomeForValidation(nextValidationState)
      : null;
    if (pAxisOutcome) desiredCoords.prediction_state = 'resolved';
    const nextCoords = Object.keys(desiredCoords).length ? desiredCoords : null;
    const lessonMetaPatch = row && nextCoords && lessonKey
      ? changedPatch(row.parsedMeta, { validation_lesson_key: lessonKey })
      : {};
    const planItem = {
      id: row?.id || null,
      title: row?.title || trigger.title || sourceRef?.id || 'unmatched trigger',
      sourceRef,
      refKey,
      matched: Boolean(row),
      current: row?.coords || null,
      trigger: {
        team: trigger.team || sourceRef?.team || 'unknown',
        polarity,
        reason: trigger.reason || null,
        occurredAt: trigger.occurredAt || trigger.occurred_at || null,
        evidence: trigger.evidence || {},
      },
      lessonKey,
      apply: Boolean(row && (nextCoords || Object.keys(lessonMetaPatch).length > 0)),
      nextCoords,
      metaPatch: lessonMetaPatch,
      reason: row
        ? `sigma_5axis_${polarity}`
        : 'source_ref_unmatched',
      pAxis: pAxisOutcome
        ? {
            linked: true,
            outcome: pAxisOutcome,
            resolvedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
            reason: 'validation_transition_resolved_prediction',
          }
        : null,
    };
    Object.defineProperty(planItem, 'currentMeta', {
      value: row?.parsedMeta || {},
      enumerable: false,
    });
    return planItem;
  });

  const validatedIdsByLesson = new Map();
  const repeatRows = [...new Map(
    [...normalizedHistoryRows, ...normalizedRows]
      .filter((row) => row.id != null)
      .map((row) => [String(row.id), row]),
  ).values()];
  for (const row of repeatRows) {
    const key = entryLessonKey(row, {});
    if (!key || row.coords.validation_state !== 'validated') continue;
    const ids = validatedIdsByLesson.get(key) || new Set();
    ids.add(String(row.id));
    validatedIdsByLesson.set(key, ids);
  }
  for (const item of plans) {
    if (!item.lessonKey || !item.matched) continue;
    const ids = validatedIdsByLesson.get(item.lessonKey) || new Set();
    if (item.trigger.polarity === 'positive') ids.add(String(item.id));
    if (item.trigger.polarity === 'negative') ids.delete(String(item.id));
    validatedIdsByLesson.set(item.lessonKey, ids);
  }
  for (const item of plans) {
    const count = validatedIdsByLesson.get(item.lessonKey)?.size || 0;
    const promotionEligible = item.trigger.polarity === 'positive';
    if (promotionEligible && item.matched && item.lessonKey && count >= minPromotionRepeats) {
      const promotionPatch = changedPatch(item.currentMeta, {
        promotion_candidate: true,
        promotion_candidate_reason: 'validated_repeat_threshold',
        promotion_candidate_count: count,
      });
      item.metaPatch = { ...item.metaPatch, ...promotionPatch };
      item.apply = item.apply || Object.keys(promotionPatch).length > 0;
    } else if (
      item.matched
      && item.currentMeta?.promotion_candidate === true
      && (item.trigger.polarity === 'negative' || (promotionEligible && count < minPromotionRepeats))
    ) {
      const promotionPatch = changedPatch(item.currentMeta, {
        promotion_candidate: false,
        promotion_candidate_reason: item.trigger.polarity === 'negative'
          ? 'validation_contradicted'
          : 'validated_repeat_below_threshold',
        promotion_candidate_count: count,
      });
      item.metaPatch = { ...item.metaPatch, ...promotionPatch };
      item.apply = item.apply || Object.keys(promotionPatch).length > 0;
    }
    if (item.pAxis?.linked) {
      const predictionPatch = changedPatch(item.currentMeta, {
        prediction_outcome: item.pAxis.outcome,
        prediction_resolved_at: item.pAxis.resolvedAt,
        prediction_resolved_by: 'sigma_5axis_validation_transition',
      });
      item.metaPatch = { ...item.metaPatch, ...predictionPatch };
      item.apply = item.apply || Object.keys(predictionPatch).length > 0;
    }
  }

  return plans;
}

function extractEvidenceLinks(row, evidenceRows = []) {
  const meta = parseMeta(row.meta);
  const direct = [
    ...(Array.isArray(meta.evidenceLinks) ? meta.evidenceLinks : []),
    ...(Array.isArray(meta.sourceLinks) ? meta.sourceLinks : []),
    ...(Array.isArray(meta.sourceEntryIds) ? meta.sourceEntryIds.map((id) => `vault-entry:${id}`) : []),
  ].map(normalizeEvidenceLink).filter(Boolean);
  const linked = (evidenceRows || [])
    .filter((evidence) => {
      const text = rowText(evidence);
      const id = String(row.id || '');
      return id && (text.includes(id.toLowerCase()) || text.includes(`vault-entry:${id}`.toLowerCase()));
    })
    .map((evidence) => `vault-entry:${evidence.id}`);
  return [...new Set([...direct, ...linked])];
}

function classifyEvidence(row, evidenceRows = [], wikiHealth = null) {
  const meta = parseMeta(row.meta);
  const explicit = String(meta.validationOutcome || meta.expectedOutcomeStatus || '').trim().toLowerCase();
  const evidenceLinks = extractEvidenceLinks(row, evidenceRows);
  const id = String(row.id || '').toLowerCase();
  const relevantEvidenceRows = (evidenceRows || []).filter((evidence) => {
    const evidenceText = rowText(evidence);
    if (id && (evidenceText.includes(id) || evidenceText.includes(`vault-entry:${id}`))) return true;
    const evidenceId = String(evidence.id || '').trim();
    return evidenceId && evidenceLinks.includes(`vault-entry:${evidenceId}`);
  });
  const text = [
    rowText(row),
    ...relevantEvidenceRows.map(rowText),
  ].join('\n');

  if ((explicit === 'validated' || explicit === 'contradicted') && evidenceLinks.length > 0) {
    return { state: explicit, reason: `explicit_${explicit}`, evidenceLinks };
  }

  const contradiction = (wikiHealth?.contradictions || []).find((item) => {
    const subject = String(item.subject || '').toLowerCase();
    return subject && text.includes(subject);
  });
  if (contradiction && evidenceLinks.length > 0) {
    return {
      state: 'contradicted',
      reason: `wiki_health_contradiction:${contradiction.subject}`,
      evidenceLinks,
    };
  }

  if (evidenceLinks.length === 0) {
    return { state: 'insufficient_evidence', reason: 'evidence_link_missing', evidenceLinks: [] };
  }

  if (/contradict|failed|missed|invalid|wrong|false|손실|실패|불일치|반례|빗나/i.test(text)) {
    return { state: 'contradicted', reason: 'negative_evidence_terms', evidenceLinks };
  }
  if (/validated|confirmed|hit|success|true|observed|수익|성공|확인|적중|관측/i.test(text)) {
    return { state: 'validated', reason: 'positive_evidence_terms', evidenceLinks };
  }
  return { state: 'insufficient_evidence', reason: 'evidence_unclear', evidenceLinks };
}

export function buildValidationTransitionPlan({ dueRows = [], evidenceRows = [], wikiHealth = null } = {}) {
  return (dueRows || [])
    .filter((row) => rowCoords(row).prediction_state === 'due')
    .map((row) => {
      const decision = classifyEvidence(row, evidenceRows, wikiHealth);
      const nextValidationState = decision.state === 'validated' || decision.state === 'contradicted'
        ? decision.state
        : null;
      return {
        id: row.id,
        title: row.title || row.file_path || `vault ${row.id}`,
        current: rowCoords(row),
        decision: decision.state,
        reason: decision.reason,
        evidenceLinks: decision.evidenceLinks,
        apply: Boolean(nextValidationState),
        nextCoords: nextValidationState
          ? {
              validation_state: nextValidationState,
              prediction_state: 'resolved',
            }
          : null,
      };
    });
}

export async function detectCoordColumns(queryReadonly = pgPool.queryReadonly) {
  try {
    const rows = await queryReadonly('sigma', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sigma'
        AND table_name = 'vault_entries'
        AND column_name = ANY($1::text[])
    `, [COORD_COLUMNS]);
    return new Set((Array.isArray(rows) ? rows : rows?.rows ?? []).map((row) => row.column_name));
  } catch {
    return new Set();
  }
}

export async function fetchVaultRowsForSourceRefs({ sourceRefs = [], limit = 500, queryReadonly = pgPool.queryReadonly } = {}) {
  const refs = [...new Map((sourceRefs || [])
    .map((ref) => normalizeSourceRef(ref))
    .filter(Boolean)
    .map((ref) => [sourceRefKey(ref), ref])).values()];
  if (refs.length === 0) return [];
  const boundedRefs = refs.slice(0, Math.max(1, Math.min(500, Number(limit) || 500)));
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const params = [];
  const clauses = boundedRefs.map((ref) => {
    params.push(ref.team, ref.table, ref.id);
    const start = params.length - 2;
    return `(
      (meta->'source_ref'->>'team' = $${start} AND meta->'source_ref'->>'table' = $${start + 1} AND meta->'source_ref'->>'id' = $${start + 2})
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(meta->'source_refs') = 'array' THEN meta->'source_refs'
            ELSE '[]'::jsonb
          END
        ) AS source_ref_alias
        WHERE source_ref_alias->>'team' = $${start}
          AND source_ref_alias->>'table' = $${start + 1}
          AND source_ref_alias->>'id' = $${start + 2}
      )
    )`;
  });
  params.push(boundedRefs.length);
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND (${clauses.join(' OR ')})
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

export async function fetchValidatedVaultRows({ lessonKeys = [], limit = 5000, queryReadonly = pgPool.queryReadonly } = {}) {
  const normalizedLessonKeys = [...new Set((lessonKeys || []).map(normalizeLessonKey).filter(Boolean))].slice(0, 500);
  if (normalizedLessonKeys.length === 0) return [];
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const validationExpr = coordColumns.has('validation_state')
    ? "COALESCE(validation_state, meta->'libraryCoords'->>'validation_state', 'unverified')"
    : "COALESCE(meta->'libraryCoords'->>'validation_state', 'unverified')";
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND ${validationExpr} = 'validated'
      AND LEFT(TRIM(REGEXP_REPLACE(
            LOWER(COALESCE(
              NULLIF(meta->>'validation_lesson_key', ''),
              NULLIF(meta->>'lesson', ''),
              NULLIF(meta->'titlePattern'->>'label', ''),
              NULLIF(title, ''),
              NULLIF(file_path, ''),
              ''
            )),
            '[^ㄱ-힣a-z0-9]+',
            ' ',
            'g'
          )), 160) = ANY($1::text[])
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [normalizedLessonKeys, Math.max(1, Math.min(5000, Number(limit) || 5000))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

export async function fetchDuePredictionRows({ limit = 100, queryReadonly = pgPool.queryReadonly } = {}) {
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const predictionExpr = coordColumns.has('prediction_state')
    ? "COALESCE(prediction_state, meta->'libraryCoords'->>'prediction_state', 'none')"
    : "COALESCE(meta->'libraryCoords'->>'prediction_state', 'none')";
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND ${predictionExpr} = 'due'
    ORDER BY created_at ASC
    LIMIT $1
  `, [Math.max(1, Math.min(1000, Number(limit) || 100))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

export async function fetchEvidenceRowsForDue({ dueRows = [], limit = 300, queryReadonly = pgPool.queryReadonly } = {}) {
  const ids = (dueRows || []).map((row) => String(row.id || '')).filter(Boolean);
  if (ids.length === 0) return [];
  const patterns = ids.flatMap((id) => [`%${id}%`, `%vault-entry:${id}%`]).slice(0, 100);
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND (
        COALESCE(content, '') ILIKE ANY($1::text[])
        OR COALESCE(meta::text, '') ILIKE ANY($1::text[])
        OR COALESCE(file_path, '') ILIKE ANY($1::text[])
      )
    ORDER BY created_at DESC
    LIMIT $2
  `, [patterns, Math.max(1, Math.min(1000, Number(limit) || 300))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

async function updateEntryCoords(id, patch, { pg = pgPool, coordColumns = null, metaPatch = null, reasoning = null } = {}) {
  const columns = coordColumns || await detectCoordColumns(pg.queryReadonly || pg.query);
  const safeMetaPatch = metaPatch && Object.keys(metaPatch).length ? metaPatch : null;
  if (columns.size === COORD_COLUMNS.length) {
    const sets = [];
    const params = [];
    for (const key of Object.keys(patch)) {
      if (!COORD_COLUMNS.includes(key)) continue;
      params.push(patch[key]);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(JSON.stringify(patch || {}));
    let metaExpression = `jsonb_set(COALESCE(meta, '{}'::jsonb), '{libraryCoords}', COALESCE(meta->'libraryCoords', '{}'::jsonb) || $${params.length}::jsonb, true)`;
    if (safeMetaPatch) {
      params.push(JSON.stringify(safeMetaPatch));
      metaExpression = `${metaExpression} || $${params.length}::jsonb`;
    }
    sets.push(`meta = ${metaExpression}`);
    params.push(id);
    if (sets.length) {
      // code-review: allow-whitelisted-sql-identifiers (COORD_COLUMNS)
      await pg.query('sigma', `UPDATE sigma.vault_entries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    }
  } else {
    const mergedMeta = safeMetaPatch || {};
    await pg.query('sigma', `
      UPDATE sigma.vault_entries
      SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{libraryCoords}', COALESCE(meta->'libraryCoords', '{}'::jsonb) || $1::jsonb, true) || $2::jsonb,
          updated_at = NOW()
      WHERE id = $3
    `, [JSON.stringify(patch || {}), JSON.stringify(mergedMeta), id]);
  }
  await pg.query('sigma', `
    INSERT INTO sigma.vault_audit (entry_id, action, classifier, reasoning, applied, dry_run)
    VALUES ($1, 'tagged', 'rule', $2, true, false)
  `, [id, reasoning || `sigma_validation_transition:${JSON.stringify({ patch, metaPatch: safeMetaPatch })}`]).catch(() => []);
}

export async function applyValidationTransitionPlan(plan = [], { pg = pgPool } = {}) {
  const coordColumns = await detectCoordColumns(pg.queryReadonly || pg.query);
  const applied = [];
  for (const item of plan) {
    if (!item.apply || !item.nextCoords) continue;
    await updateEntryCoords(item.id, item.nextCoords, { pg, coordColumns });
    applied.push(item.id);
  }
  return { applied, count: applied.length };
}

function sanitizePredictionAxisPatch(nextCoords = {}, metaPatch = {}, env = process.env) {
  const safeNextCoords = { ...(nextCoords || {}) };
  const safeMetaPatch = { ...(metaPatch || {}) };
  if (isSigmaPredictionEnabled(env)) {
    return {
      nextCoords: safeNextCoords,
      metaPatch: Object.keys(safeMetaPatch).length ? safeMetaPatch : null,
    };
  }
  delete safeNextCoords.prediction_state;
  delete safeNextCoords.prediction_horizon;
  delete safeMetaPatch.prediction_outcome;
  delete safeMetaPatch.prediction_resolved_at;
  delete safeMetaPatch.prediction_resolved_by;
  delete safeMetaPatch.prediction_due_at;
  return {
    nextCoords: safeNextCoords,
    metaPatch: Object.keys(safeMetaPatch).length ? safeMetaPatch : null,
  };
}

export async function applyTeamTransitionPlan(plan = [], { pg = pgPool, env = process.env } = {}) {
  if (!isSigmaTransitionEnabled(env)) {
    return { applied: [], count: 0, skipped: true, reason: 'SIGMA_TRANSITION_ENABLED_not_true' };
  }
  const coordColumns = await detectCoordColumns(pg.queryReadonly || pg.query);
  const applied = [];
  const appliedIds = new Set();
  for (const item of plan) {
    if (!item.apply || !item.id || appliedIds.has(String(item.id))) continue;
    const patch = sanitizePredictionAxisPatch(item.nextCoords || {}, item.metaPatch || {}, env);
    const nextCoords = changedPatch(item.current || {}, patch.nextCoords);
    const metaPatch = changedPatch(item.currentMeta || {}, patch.metaPatch || {});
    if (!Object.keys(nextCoords).length && !Object.keys(metaPatch).length) continue;
    await updateEntryCoords(item.id, nextCoords, {
      pg,
      coordColumns,
      metaPatch,
      reasoning: `sigma_5axis_transition:${JSON.stringify({
        sourceRef: item.sourceRef,
        polarity: item.trigger?.polarity,
        reason: item.trigger?.reason || item.reason,
        nextCoords,
        metaPatch,
      })}`,
    });
    appliedIds.add(String(item.id));
    applied.push(item.id);
  }
  return { applied, count: applied.length, skipped: false };
}

export async function applyPredictionLedgerPlan(plan = [], { pg = pgPool, env = process.env } = {}) {
  if (!isSigmaPredictionEnabled(env)) {
    return { applied: [], count: 0, skipped: true, reason: 'SIGMA_PREDICTION_ENABLED_not_true' };
  }
  const coordColumns = await detectCoordColumns(pg.queryReadonly || pg.query);
  const applied = [];
  for (const item of plan) {
    if (!item.apply || !item.id || !item.nextCoords) continue;
    await updateEntryCoords(item.id, item.nextCoords, {
      pg,
      coordColumns,
      metaPatch: item.metaPatch || null,
      reasoning: `sigma_prediction_ledger:${JSON.stringify({
        reason: item.reason,
        nextCoords: item.nextCoords,
        metaPatch: item.metaPatch,
      })}`,
    });
    applied.push(item.id);
  }
  return { applied, count: applied.length, skipped: false };
}

export async function buildValidationTransitionReport(options = {}) {
  const dueRows = options.dueRows || await fetchDuePredictionRows({
    limit: options.limit || 100,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const evidenceRows = options.evidenceRows || await fetchEvidenceRowsForDue({
    dueRows,
    limit: options.evidenceLimit || 300,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const wikiHealth = options.wikiHealth || null;
  const plan = buildValidationTransitionPlan({ dueRows, evidenceRows, wikiHealth });
  return {
    ok: true,
    source: 'sigma_validation_transition',
    dryRun: options.dryRun !== false,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    counts: {
      due: dueRows.length,
      evidenceRows: evidenceRows.length,
      validated: plan.filter((item) => item.decision === 'validated').length,
      contradicted: plan.filter((item) => item.decision === 'contradicted').length,
      insufficient: plan.filter((item) => item.decision === 'insufficient_evidence').length,
      applicable: plan.filter((item) => item.apply).length,
    },
    plan,
  };
}

export function buildPredictionLedgerReport({ rows = [], now = new Date() } = {}) {
  const normalized = (rows || []).map((row) => ({ ...row, coords: rowCoords(row) }));
  const counts = {
    forward: normalized.filter((row) => row.coords.prediction_state === 'forward').length,
    due: normalized.filter((row) => row.coords.prediction_state === 'due').length,
    resolved: normalized.filter((row) => row.coords.prediction_state === 'resolved').length,
    validated: normalized.filter((row) => row.coords.validation_state === 'validated').length,
    contradicted: normalized.filter((row) => row.coords.validation_state === 'contradicted').length,
  };
  const accuracy = buildPredictionAccuracy({ rows: normalized });
  return {
    ok: true,
    source: 'sigma_prediction_ledger',
    generatedAt: now.toISOString(),
    counts,
    accuracy: accuracy.overall.accuracy,
    accuracyDetail: accuracy,
    dueRows: normalized
      .filter((row) => row.coords.prediction_state === 'due')
      .map((row) => ({ id: row.id, title: row.title || row.file_path, horizon: row.coords.prediction_horizon || null })),
  };
}

export async function fetchPredictionLedgerRows({ limit = 500, queryReadonly = pgPool.queryReadonly } = {}) {
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const predictionExpr = coordColumns.has('prediction_state')
    ? "COALESCE(prediction_state, meta->'libraryCoords'->>'prediction_state', 'none')"
    : "COALESCE(meta->'libraryCoords'->>'prediction_state', 'none')";
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND ${predictionExpr} <> 'none'
    ORDER BY created_at DESC
    LIMIT $1
  `, [Math.max(1, Math.min(2000, Number(limit) || 500))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

export default {
  buildValidationTransitionPlan,
  buildValidationTransitionReport,
  applyValidationTransitionPlan,
  buildTeamTransitionPlan,
  applyTeamTransitionPlan,
  applyPredictionLedgerPlan,
  buildPredictionLedgerTransitionPlan,
  buildPredictionAccuracy,
  buildPredictionLedgerReport,
  detectCoordColumns,
  fetchVaultRowsForSourceRefs,
  fetchValidatedVaultRows,
  fetchDuePredictionRows,
  fetchPredictionLedgerRows,
  isSigmaTransitionEnabled,
  isSigmaPredictionEnabled,
  normalizeLessonKey,
};

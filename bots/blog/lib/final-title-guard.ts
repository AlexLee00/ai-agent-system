// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { findRecentTitleConflict, normalizeTitle } = require('./topic-title-guard.ts');

const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output');
const MAX_FINAL_TITLE_ALTERNATES = 2;
const MAX_FINAL_TITLE_REGENERATIONS = 1;

function normalizeObservedAt(value) {
  if (!value) return null;
  const observedAt = new Date(value);
  return Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString();
}

async function loadDbTitleHistory({ pool = pgPool, days = DEFAULT_HISTORY_DAYS } = {}) {
  try {
    const rows = await pool.query('blog', `
      SELECT title, COALESCE(publish_date::timestamptz, created_at) AS observed_at
      FROM blog.posts
      WHERE post_type = 'general'
        AND status IN ('ready', 'published')
        AND COALESCE(publish_date::timestamptz, created_at) >= NOW() - ($1::text || ' days')::interval
        AND COALESCE(title, '') <> ''
      ORDER BY COALESCE(publish_date::timestamptz, created_at) DESC, id DESC
      LIMIT 200
    `, [Math.max(1, Number(days || DEFAULT_HISTORY_DAYS))]);
    const entries = (rows || [])
      .map((row) => ({
        title: String(row.title || '').trim(),
        observedAt: normalizeObservedAt(row.observed_at),
      }))
      .filter((entry) => entry.title);
    return { available: true, entries, titles: entries.map((entry) => entry.title), error: null };
  } catch (error) {
    return { available: false, entries: [], titles: [], error: String(error?.message || error) };
  }
}

function loadOutputTitleHistory({
  outputDir = DEFAULT_OUTPUT_DIR,
  days = DEFAULT_HISTORY_DAYS,
  now = new Date(),
  fsModule = fs,
} = {}) {
  try {
    const cutoff = new Date(now.getTime() - Math.max(1, Number(days || DEFAULT_HISTORY_DAYS)) * 86_400_000);
    const entries = fsModule.readdirSync(outputDir)
      .map((filename) => {
        const match = String(filename).match(/^(\d{4}-\d{2}-\d{2})_general_(.+)\.html$/);
        if (!match) return null;
        const observedAt = new Date(`${match[1]}T00:00:00+09:00`);
        if (Number.isNaN(observedAt.getTime()) || observedAt < cutoff) return null;
        return {
          title: String(match[2] || '').trim(),
          observedAt: observedAt.toISOString(),
        };
      })
      .filter((entry) => entry?.title)
      .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt));
    return { available: true, entries, titles: entries.map((entry) => entry.title), error: null };
  } catch (error) {
    return { available: false, entries: [], titles: [], error: String(error?.message || error) };
  }
}

function normalizeHistoryEntries(history = {}, source = '') {
  const rawEntries = Array.isArray(history?.entries)
    ? history.entries
    : (Array.isArray(history?.titles) ? history.titles.map((title) => ({ title })) : []);
  return rawEntries
    .map((entry) => ({
      title: String(typeof entry === 'string' ? entry : entry?.title || '').trim(),
      observedAt: normalizeObservedAt(typeof entry === 'string' ? null : entry?.observedAt || entry?.observed_at),
      sources: [source],
    }))
    .filter((entry) => entry.title);
}

function buildTitleHistorySnapshot(dbHistory = {}, outputHistory = {}) {
  const combined = [
    ...normalizeHistoryEntries(dbHistory, 'db'),
    ...normalizeHistoryEntries(outputHistory, 'output'),
  ].map((entry, combinedOrder) => ({ ...entry, combinedOrder }));

  combined.sort((first, second) => {
    const firstTime = first.observedAt ? Date.parse(first.observedAt) : Number.NEGATIVE_INFINITY;
    const secondTime = second.observedAt ? Date.parse(second.observedAt) : Number.NEGATIVE_INFINITY;
    return secondTime - firstTime || first.combinedOrder - second.combinedOrder;
  });

  const entries = [];
  const entryByKey = new Map();
  for (const entry of combined) {
    const key = normalizeTitle(entry.title);
    if (!key) continue;
    const existing = entryByKey.get(key);
    if (existing) {
      if (!existing.sources.includes(entry.sources[0])) existing.sources.push(entry.sources[0]);
      continue;
    }
    const normalizedEntry = {
      title: entry.title,
      observedAt: entry.observedAt,
      sources: [...entry.sources],
    };
    entryByKey.set(key, normalizedEntry);
    entries.push(normalizedEntry);
  }

  const frozenEntries = entries.map((entry) => Object.freeze({
    ...entry,
    sources: Object.freeze([...entry.sources]),
  }));
  const sources = Object.freeze({
    db: Boolean(dbHistory?.available),
    output: Boolean(outputHistory?.available),
  });
  return Object.freeze({
    entries: Object.freeze(frozenEntries),
    titles: Object.freeze(frozenEntries.map((entry) => entry.title)),
    sources,
    degraded: !sources.db || !sources.output,
    errors: Object.freeze({
      db: dbHistory?.error || null,
      output: outputHistory?.error || null,
    }),
  });
}

function buildHistoryUnavailableError(snapshot = null) {
  const error = new Error('최종 제목 이력을 조회할 수 없어 발행을 보류합니다.');
  error.code = 'title_history_unavailable';
  error.details = {
    dbError: snapshot?.errors?.db || null,
    outputError: snapshot?.errors?.output || null,
    conflictTitle: null,
    conflictSource: null,
    matchedPredicate: 'title_history_unavailable',
  };
  return error;
}

async function loadTitleHistorySnapshot(options = {}) {
  if (options.historySnapshot) return options.historySnapshot;
  const loadDb = options.loadDbTitleHistory || loadDbTitleHistory;
  const loadOutput = options.loadOutputTitleHistory || loadOutputTitleHistory;
  const [dbHistory, outputHistory] = await Promise.all([
    loadDb(options),
    Promise.resolve(loadOutput(options)),
  ]);
  const snapshot = buildTitleHistorySnapshot(dbHistory, outputHistory);
  if (!snapshot.sources.db && !snapshot.sources.output) throw buildHistoryUnavailableError(snapshot);
  return snapshot;
}

function findTitleHistoryConflict(title, historySnapshot) {
  const snapshot = historySnapshot || buildTitleHistorySnapshot({}, {});
  const conflict = findRecentTitleConflict(title, snapshot.titles);
  if (!conflict) return null;
  const historyEntry = snapshot.entries[conflict.historyIndex] || null;
  return {
    ...conflict,
    conflictSource: ['db', 'output'].filter((source) => historyEntry?.sources?.includes(source)).join('+') || null,
  };
}

function assertTitleAgainstHistorySnapshot(title, historySnapshot) {
  if (!historySnapshot?.sources?.db && !historySnapshot?.sources?.output) {
    const unavailable = buildHistoryUnavailableError(historySnapshot);
    unavailable.details.attemptedTitle = String(title || '').trim() || null;
    throw unavailable;
  }

  const conflict = findTitleHistoryConflict(title, historySnapshot);
  if (conflict) {
    const error = new Error(`30일 이력과 제목 구조가 겹쳐 발행을 보류합니다: ${conflict.conflictTitle}`);
    error.code = 'final_title_overlap';
    error.details = {
      title,
      attemptedTitle: title,
      conflict: conflict.conflictTitle,
      conflictTitle: conflict.conflictTitle,
      conflictSource: conflict.conflictSource,
      matchedPredicate: conflict.matchedPredicate,
    };
    throw error;
  }

  return {
    ok: true,
    historyCount: historySnapshot.titles.length,
    sources: historySnapshot.sources,
    degraded: historySnapshot.degraded,
  };
}

async function assertFinalGeneralTitle(title, options = {}) {
  let historySnapshot = options.historySnapshot;
  try {
    historySnapshot = historySnapshot || await loadTitleHistorySnapshot(options);
  } catch (error) {
    if (error?.code === 'title_history_unavailable') {
      error.details = { ...error.details, attemptedTitle: String(title || '').trim() || null };
    }
    throw error;
  }
  return assertTitleAgainstHistorySnapshot(title, historySnapshot);
}

function attachRecoveryContext(error, context = {}) {
  const details = error?.details || {};
  error.details = {
    ...details,
    attemptedTitle: context.attemptedTitle || details.attemptedTitle || details.title || null,
    conflictTitle: details.conflictTitle || context.conflictTitle || details.conflict || null,
    conflictSource: details.conflictSource || context.conflictSource || null,
    matchedPredicate: details.matchedPredicate || context.matchedPredicate || null,
    candidateCount: Math.max(0, Number(context.candidateCount || 0)),
    selectedReason: String(context.selectedReason || 'final_title_guard'),
    guardAttempts: Math.max(0, Number(context.guardAttempts || 0)),
    regenerationAttempts: Math.max(0, Number(context.regenerationAttempts || 0)),
  };
  return error;
}

function buildTitleGuardEventDetails(errorOrDetails = {}) {
  const details = errorOrDetails?.details || errorOrDetails || {};
  if (!details.attemptedTitle && !details.matchedPredicate && !details.conflictTitle) return {};
  return {
    attemptedTitle: details.attemptedTitle || details.title || null,
    conflictTitle: details.conflictTitle || details.conflict || null,
    conflictSource: details.conflictSource || null,
    matchedPredicate: details.matchedPredicate || null,
    candidateCount: Math.max(0, Number(details.candidateCount || 0)),
    selectedReason: String(details.selectedReason || 'final_title_guard'),
  };
}

function uniqueTitleQueue(title, candidateTitles = []) {
  const seen = new Set();
  return [title, ...(Array.isArray(candidateTitles) ? candidateTitles : [])]
    .map((candidate) => String(candidate || '').trim())
    .filter((candidate) => {
      const key = normalizeTitle(candidate);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function resolveFinalGeneralTitle(input = {}) {
  const initialTitle = String(input.title || '').trim();
  const candidateCount = Math.max(0, Number(input.candidateCount || input.candidateTitles?.length || 0));
  const initialSelectedReason = String(input.selectedReason || 'title_feedback_selection');
  const guardOptions = input.guardOptions || {};
  const assertTitle = input.assertTitle || assertFinalGeneralTitle;
  let historySnapshot = input.historySnapshot;
  let guardAttempts = 0;
  let regenerationAttempts = 0;

  try {
    historySnapshot = historySnapshot || await loadTitleHistorySnapshot(guardOptions);
  } catch (error) {
    throw attachRecoveryContext(error, {
      attemptedTitle: initialTitle,
      candidateCount,
      selectedReason: initialSelectedReason,
      guardAttempts,
      regenerationAttempts,
    });
  }

  const queue = uniqueTitleQueue(initialTitle, input.candidateTitles);
  const boundedQueue = [queue[0], ...queue.slice(1, 1 + MAX_FINAL_TITLE_ALTERNATES)].filter(Boolean);
  let firstOverlap = null;
  let lastOverlap = null;

  for (let index = 0; index < boundedQueue.length; index += 1) {
    const attemptedTitle = boundedQueue[index];
    guardAttempts += 1;
    try {
      const guard = await assertTitle(attemptedTitle, { ...guardOptions, historySnapshot });
      const selectedReason = index === 0
        ? initialSelectedReason
        : `final_guard_alternate_${index}:${initialSelectedReason}`;
      if (index > 0 && typeof input.onRecovered === 'function') {
        const conflictDetails = firstOverlap?.details || {};
        await input.onRecovered(buildTitleGuardEventDetails({
          attemptedTitle: conflictDetails.attemptedTitle || initialTitle,
          conflictTitle: conflictDetails.conflictTitle || conflictDetails.conflict || null,
          conflictSource: conflictDetails.conflictSource || null,
          matchedPredicate: conflictDetails.matchedPredicate || null,
          candidateCount,
          selectedReason,
        }));
      }
      return { title: attemptedTitle, guard, guardAttempts, regenerationAttempts, selectedReason };
    } catch (error) {
      if (error?.code !== 'final_title_overlap') {
        throw attachRecoveryContext(error, {
          attemptedTitle,
          candidateCount,
          selectedReason: initialSelectedReason,
          guardAttempts,
          regenerationAttempts,
        });
      }
      firstOverlap = firstOverlap || error;
      lastOverlap = error;
    }
  }

  if (typeof input.regenerateTitle === 'function' && MAX_FINAL_TITLE_REGENERATIONS > 0) {
    regenerationAttempts = 1;
    const conflictDetails = lastOverlap?.details || firstOverlap?.details || {};
    let regeneratedResult;
    try {
      regeneratedResult = await input.regenerateTitle({
        conflictTitle: conflictDetails.conflictTitle || conflictDetails.conflict || null,
        conflictReason: conflictDetails.matchedPredicate || null,
        historySnapshot,
      });
    } catch (error) {
      throw attachRecoveryContext(error, {
        attemptedTitle: initialTitle,
        conflictTitle: conflictDetails.conflictTitle || conflictDetails.conflict || null,
        conflictSource: conflictDetails.conflictSource || null,
        matchedPredicate: conflictDetails.matchedPredicate || null,
        candidateCount,
        selectedReason: initialSelectedReason,
        guardAttempts,
        regenerationAttempts,
      });
    }

    const regeneratedTitle = String(regeneratedResult?.title || '').trim();
    if (regeneratedTitle && !regeneratedResult?.blocked) {
      guardAttempts += 1;
      try {
        const guard = await assertTitle(regeneratedTitle, { ...guardOptions, historySnapshot });
        const selectedReason = `final_guard_regenerated:${regeneratedResult?.metadata?.title_selected_reason || initialSelectedReason}`;
        if (typeof input.onRecovered === 'function') {
          await input.onRecovered(buildTitleGuardEventDetails({
            attemptedTitle: firstOverlap?.details?.attemptedTitle || initialTitle,
            conflictTitle: conflictDetails.conflictTitle || conflictDetails.conflict || null,
            conflictSource: conflictDetails.conflictSource || null,
            matchedPredicate: conflictDetails.matchedPredicate || null,
            candidateCount,
            selectedReason,
          }));
        }
        return {
          title: regeneratedTitle,
          guard,
          guardAttempts,
          regenerationAttempts,
          selectedReason,
          regeneratedResult,
        };
      } catch (error) {
        if (error?.code !== 'final_title_overlap') {
          throw attachRecoveryContext(error, {
            attemptedTitle: regeneratedTitle,
            candidateCount,
            selectedReason: initialSelectedReason,
            guardAttempts,
            regenerationAttempts,
          });
        }
        lastOverlap = error;
      }
    }
  }

  const terminalError = lastOverlap || firstOverlap || new Error('최종 제목 후보를 모두 소진해 발행을 보류합니다.');
  if (!terminalError.code) terminalError.code = 'final_title_overlap';
  throw attachRecoveryContext(terminalError, {
    attemptedTitle: terminalError?.details?.attemptedTitle || initialTitle,
    candidateCount,
    selectedReason: initialSelectedReason,
    guardAttempts,
    regenerationAttempts,
  });
}

module.exports = {
  DEFAULT_HISTORY_DAYS,
  MAX_FINAL_TITLE_ALTERNATES,
  MAX_FINAL_TITLE_REGENERATIONS,
  loadDbTitleHistory,
  loadOutputTitleHistory,
  buildTitleHistorySnapshot,
  loadTitleHistorySnapshot,
  findTitleHistoryConflict,
  assertTitleAgainstHistorySnapshot,
  assertFinalGeneralTitle,
  buildTitleGuardEventDetails,
  resolveFinalGeneralTitle,
};

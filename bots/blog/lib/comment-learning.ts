// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const COMMENT_LEARNING_STRATEGY_VERSION = 'comment-classifier-v1';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSource(value = '') {
  return String(value || '') === 'neighbor' ? 'neighbor' : 'own';
}

async function tableExists(pool = pgPool, qualifiedName = '') {
  try {
    const rows = await pool.query('public', 'SELECT to_regclass($1) AS regclass', [qualifiedName]);
    return Boolean(rows?.[0]?.regclass || rows?.rows?.[0]?.regclass);
  } catch {
    return false;
  }
}

function buildCommentLearningEventPayload(input = {}) {
  return {
    commentId: input.commentId ?? input.comment_id ?? null,
    source: normalizeSource(input.source),
    type: normalizeText(input.type || '기타') || '기타',
    strategyVersion: normalizeText(input.strategyVersion || COMMENT_LEARNING_STRATEGY_VERSION),
    replyPostedAt: input.replyPostedAt || input.reply_posted_at || new Date().toISOString(),
    outcome: input.outcome && typeof input.outcome === 'object' ? input.outcome : {},
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

async function recordCommentLearningEvent(input = {}, { pool = pgPool } = {}) {
  const payload = buildCommentLearningEventPayload(input);
  try {
    const exists = await tableExists(pool, 'blog.comment_learning_events');
    if (!exists) {
      return { ok: true, skipped: true, reason: 'comment_learning_events_missing', payload };
    }
    await pool.run('blog', `
      INSERT INTO blog.comment_learning_events (
        comment_id, source, type, strategy_version, reply_posted_at, outcome, metadata
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb)
      ON CONFLICT (comment_id, source, strategy_version) DO UPDATE SET
        type = EXCLUDED.type,
        reply_posted_at = EXCLUDED.reply_posted_at,
        outcome = EXCLUDED.outcome,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      payload.commentId,
      payload.source,
      payload.type,
      payload.strategyVersion,
      payload.replyPostedAt,
      JSON.stringify(payload.outcome),
      JSON.stringify(payload.metadata),
    ]);
    return { ok: true, skipped: false, payload };
  } catch (error) {
    return { ok: false, skipped: true, reason: error?.message || String(error), payload };
  }
}

function deriveNeighborLearningType(candidate = {}) {
  const sourceType = normalizeText(candidate.source_type || candidate.sourceType || '');
  if (!sourceType) return 'neighbor_comment';
  return `neighbor:${sourceType}`;
}

function buildCommentStrategyVaultContribution(report = {}) {
  return {
    source: 'blo',
    type: 'comment_strategy_report',
    title: `[comment_strategy] ${report.weekKey || 'weekly shadow report'}`,
    content: [
      '# Blog comment strategy shadow report',
      `week: ${report.weekKey || ''}`,
      `events: ${report.totalEvents || 0}`,
      `proposals: ${Array.isArray(report.proposals) ? report.proposals.length : 0}`,
      '',
      ...(report.proposals || []).map((item) => `- ${item.type}: ${item.proposal}`),
    ].join('\n').trim(),
    filePath: `library/blo/comment_strategy/${report.weekKey || 'latest'}`,
    tags: ['blog', 'blo', 'comment_strategy', 'shadow'],
    meta: {
      team: 'blog',
      source: 'blo',
      sourceKind: 'comment_strategy_report',
      libraryCoords: {
        abstraction_level: 'L2',
        time_stage: 'digest',
        validation_state: 'unverified',
        prediction_state: 'none',
      },
      generatedAt: report.generatedAt || new Date().toISOString(),
    },
  };
}

module.exports = {
  COMMENT_LEARNING_STRATEGY_VERSION,
  tableExists,
  buildCommentLearningEventPayload,
  recordCommentLearningEvent,
  deriveNeighborLearningType,
  buildCommentStrategyVaultContribution,
};

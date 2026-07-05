// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { tableExists, buildCommentStrategyVaultContribution } = require('./comment-learning.ts');
const { COMMENT_TYPE_STRATEGIES } = require('./comment-classifier.ts');

function weekKey(date = new Date()) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeType(value = '') {
  return String(value || '').trim() || '기타';
}

function buildCommentStrategyReportFromRows({ learningEvents = [], ownComments = [], neighborComments = [], actionRows = [] } = {}, options = {}) {
  const minSamples = Math.max(1, Number(options.minSamples || 3));
  const maxOtherRatio = Number(options.maxOtherRatio || 0.3);
  const minSuccessRate = Number(options.minSuccessRate || 0.7);
  const buckets = new Map();

  function add(type, source, success, outcome = {}) {
    const key = normalizeType(type);
    const bucket = buckets.get(key) || { type: key, total: 0, success: 0, sources: {} };
    bucket.total += 1;
    if (success === true) bucket.success += 1;
    bucket.sources[source] = Number(bucket.sources[source] || 0) + 1;
    buckets.set(key, bucket);
  }

  for (const event of learningEvents || []) {
    const outcome = event.outcome && typeof event.outcome === 'object' ? event.outcome : {};
    add(event.type, event.source || 'learning', outcome.success !== false, outcome);
  }
  if (!learningEvents.length) {
    for (const row of ownComments || []) {
      const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
      const type = meta?.classification?.type || meta.commentType || '기타';
      add(type, 'own', String(row.status || '') === 'replied', meta);
    }
    for (const row of neighborComments || []) {
      add(row.source_type ? `neighbor:${row.source_type}` : 'neighbor_comment', 'neighbor', String(row.status || '') === 'posted', row.meta || {});
    }
    for (const row of actionRows || []) {
      if (!['reply', 'neighbor_comment'].includes(String(row.action_type || ''))) continue;
      const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
      add(meta?.classification?.type || meta.commentType || String(row.action_type || '기타'), 'action', row.success === true, meta);
    }
  }

  const distribution = [...buckets.values()].map((bucket) => ({
    ...bucket,
    successRate: bucket.total > 0 ? Number((bucket.success / bucket.total).toFixed(4)) : 0,
  })).sort((left, right) => right.total - left.total);
  const totalEvents = distribution.reduce((sum, item) => sum + item.total, 0);
  const proposals = [];
  const other = distribution.find((item) => item.type === '기타');
  if (other && totalEvents > 0 && other.total / totalEvents > maxOtherRatio) {
    proposals.push({
      type: '기타',
      reason: 'other_ratio_high',
      metric: Number((other.total / totalEvents).toFixed(4)),
      proposal: '기타 댓글을 질문/감사/공감/제안 하위 후보로 재분류할 신유형 후보를 검토하세요.',
      shadowOnly: true,
    });
  }
  for (const item of distribution) {
    if (item.total < minSamples || item.successRate >= minSuccessRate) continue;
    proposals.push({
      type: item.type,
      reason: 'low_success_rate',
      metric: item.successRate,
      proposal: `${item.type} 전략은 댓글 핵심 표현을 먼저 인용하고 답변을 한 문장 더 구체화하는 방향으로 개선안을 검토하세요.`,
      shadowOnly: true,
    });
  }

  const report = {
    ok: true,
    shadowOnly: true,
    liveMutation: false,
    weekKey: options.weekKey || weekKey(),
    generatedAt: new Date().toISOString(),
    totalEvents,
    distribution,
    proposals,
    classifierTypes: Object.keys(COMMENT_TYPE_STRATEGIES),
  };
  report.vaultContribution = buildCommentStrategyVaultContribution(report);
  return report;
}

async function fetchCommentStrategyRows({ days = 7, pool = pgPool } = {}) {
  const learningExists = await tableExists(pool, 'blog.comment_learning_events');
  if (learningExists) {
    const learningEvents = await pool.query('blog', `
      SELECT source, type, strategy_version, outcome, metadata, reply_posted_at
      FROM blog.comment_learning_events
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 1000
    `, [Math.max(1, Number(days || 7))]);
    return { learningEvents, ownComments: [], neighborComments: [], actionRows: [], source: 'comment_learning_events' };
  }
  const [ownComments, neighborComments, actionRows] = await Promise.all([
    pool.query('blog', `
      SELECT status, meta, reply_at, detected_at
      FROM blog.comments
      WHERE detected_at >= NOW() - ($1::text || ' days')::interval
      LIMIT 1000
    `, [Math.max(1, Number(days || 7))]),
    pool.query('blog', `
      SELECT source_type, status, meta, posted_at, created_at
      FROM blog.neighbor_comments
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
      LIMIT 1000
    `, [Math.max(1, Number(days || 7))]),
    pool.query('blog', `
      SELECT action_type, success, meta, executed_at
      FROM blog.comment_actions
      WHERE executed_at >= NOW() - ($1::text || ' days')::interval
      LIMIT 1000
    `, [Math.max(1, Number(days || 7))]),
  ]);
  return { learningEvents: [], ownComments, neighborComments, actionRows, source: 'fallback_existing_tables' };
}

async function persistCommentStrategyProposal(report = {}, { pool = pgPool } = {}) {
  const exists = await tableExists(pool, 'blog.comment_strategy_proposals');
  if (!exists) return { ok: true, skipped: true, reason: 'comment_strategy_proposals_missing' };
  let inserted = 0;
  for (const proposal of report.proposals || []) {
    await pool.run('blog', `
      INSERT INTO blog.comment_strategy_proposals (
        week_key, type, reason, proposal, metrics, status
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, 'shadow')
      ON CONFLICT (week_key, type, reason) DO UPDATE SET
        proposal = EXCLUDED.proposal,
        metrics = EXCLUDED.metrics,
        updated_at = NOW()
    `, [
      report.weekKey,
      proposal.type,
      proposal.reason,
      proposal.proposal,
      JSON.stringify({ metric: proposal.metric, totalEvents: report.totalEvents }),
    ]);
    inserted += 1;
  }
  return { ok: true, skipped: false, inserted };
}

async function runCommentStrategyEvolver(options = {}) {
  const rows = options.rows || await fetchCommentStrategyRows(options);
  const report = buildCommentStrategyReportFromRows(rows, options);
  report.source = rows.source || 'fixture';
  if (options.write === true) {
    report.persisted = await persistCommentStrategyProposal(report, options);
  } else {
    report.persisted = { ok: true, skipped: true, reason: 'dry_run' };
  }
  return report;
}

module.exports = {
  weekKey,
  buildCommentStrategyReportFromRows,
  fetchCommentStrategyRows,
  persistCommentStrategyProposal,
  runCommentStrategyEvolver,
};

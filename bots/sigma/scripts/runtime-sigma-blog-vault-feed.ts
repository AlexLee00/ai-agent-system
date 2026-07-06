#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { redactPii } from '../ts/lib/intelligent-library.ts';
import { attachSourceRefToMeta, sourceRefFromCandidate } from '../shared/source-ref.ts';
import { createVaultEmbedding, VaultManager } from '../vault/vault-manager.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_SINCE_HOURS = 24 * 7;
const DEFAULT_LIMIT_PER_SOURCE = 10_000;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

function countBy(items: any[], keyFn: (item: any) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items || []) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function contentHash(value: string): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function safeTag(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.replace(/\s+/g, '_').slice(0, 80);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceHint(text: string, value: unknown, replacement: string): { text: string; changed: boolean } {
  const raw = String(value || '').trim();
  if (raw.length < 2) return { text, changed: false };
  const pattern = new RegExp(escapeRegExp(raw), 'g');
  const next = text.replace(pattern, replacement);
  return { text: next, changed: next !== text };
}

export function redactBlogPii(input: unknown, hints: Record<string, unknown> = {}): { text: string; redactions: string[] } {
  const base = redactPii(String(input || ''));
  const redactions = new Set(base.redactions || []);
  let text = base.text
    .replace(/https?:\/\/m?\.?blog\.naver\.com\/[A-Za-z0-9._-]+/gi, (match) => {
      redactions.add('blog_url');
      return match.replace(/blog\.naver\.com\/[A-Za-z0-9._-]+/i, 'blog.naver.com/[REDACTED_BLOG_ID]');
    });

  const hintMap: Array<[string, string]> = [
    ['commenter_id', '[REDACTED_BLOG_ID]'],
    ['commenter_name', '[REDACTED_BLOG_NAME]'],
    ['target_blog', '[REDACTED_BLOG_ID]'],
    ['target_blog_name', '[REDACTED_BLOG_NAME]'],
  ];
  for (const [key, replacement] of hintMap) {
    const replaced = replaceHint(text, hints[key], replacement);
    text = replaced.text;
    if (replaced.changed) redactions.add(key);
  }

  return { text, redactions: [...redactions].sort() };
}

function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const size = Math.max(500, Math.min(Number(chunkSize || DEFAULT_CHUNK_SIZE), 4000));
  const chunks = [];
  for (let index = 0; index < normalized.length; index += size) {
    const chunk = normalized.slice(index, index + size).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function postTitle(row: any): string {
  return String(row?.final_title || row?.title || `blog post ${row?.id || ''}`).trim();
}

function postContent(row: any): string {
  return normalizeText(row?.final_content_text) || normalizeText(row?.content) || stripHtml(row?.html_content);
}

function countHeadingTags(value: unknown): number {
  const source = String(value || '');
  return (source.match(/<h[1-6]\b/gi) || []).length
    || (source.match(/^\s*#{1,6}\s+/gm) || []).length
    || (source.match(/^\s*\[[^\]\n]{2,60}\]\s*$/gm) || []).length;
}

function hasVideoSignal(row: any): boolean {
  const source = [row?.html_content, row?.content, row?.final_content_text].map((item) => String(item || '')).join('\n');
  return /<video\b|<iframe\b|youtu\.be|youtube\.com|tv\.naver|naver\.me\/x/i.test(source);
}

function buildPostStructureMeta(row: any, content: string): Record<string, unknown> {
  return {
    charCount: normalizeText(content).length || Number(row?.char_count || 0),
    headingCount: countHeadingTags(row?.html_content || content),
    hasVideo: hasVideoSignal(row),
    finalContentUsed: Boolean(normalizeText(row?.final_content_text)),
    finalContentCheckedAt: row?.final_content_checked_at || null,
  };
}

function buildPostCrankMeta(row: any): Record<string, unknown> | null {
  if (row?.crank_overall == null) return null;
  return {
    scoredDate: row?.crank_scored_date || null,
    overall: Number(row?.crank_overall || 0),
    crankTotal: row?.crank_total == null ? null : Number(row.crank_total),
    diaTotal: row?.dia_total == null ? null : Number(row.dia_total),
    geoTotal: row?.geo_total == null ? null : Number(row.geo_total),
  };
}

function postTags(row: any): string[] {
  const tags = new Set(['blog', 'blo', 'blog_post']);
  const postType = safeTag(row?.post_type);
  const seriesName = safeTag(row?.series_name);
  if (postType) tags.add(postType);
  if (seriesName) tags.add(seriesName);
  if (row?.lecture_number) tags.add(`lec:${Number(row.lecture_number)}`);
  return [...tags].slice(0, 12);
}

function commentTags(kind: string, row: any): string[] {
  const tags = new Set(['blog', 'blo', 'blog_comment', kind]);
  const status = safeTag(row?.status);
  const actionType = safeTag(row?.action_type);
  if (status) tags.add(`status:${status}`);
  if (actionType) tags.add(`action:${actionType}`);
  if (row?.success === true) tags.add('success:true');
  if (row?.success === false) tags.add('success:false');
  return [...tags].slice(0, 12);
}

function externalTrendTags(row: any): string[] {
  const meta = typeof row?.meta === 'string' ? safeJson(row.meta) : (row?.meta || {});
  const genre = String(meta?.raw?.genre || meta?.genre || row?.genre || '').trim();
  const tags = new Set(['blog', 'blo', 'blog_external_trend']);
  if (genre) tags.add(`genre:${genre}`);
  const source = safeTag(row?.source);
  if (source) tags.add(`source:${source}`);
  return [...tags].slice(0, 12);
}

function buildPostCandidates(posts: any[], options: { chunkSize?: number } = {}) {
  const candidates = [];
  for (const row of posts || []) {
    const rawContent = postContent(row);
    const chunks = chunkText(rawContent, options.chunkSize || DEFAULT_CHUNK_SIZE);
    chunks.forEach((chunk, index) => {
      const chunkCount = chunks.length;
      const title = postTitle(row);
      const prefix = [
        '[블로그 포스트]',
        `제목: ${title}`,
        row?.category ? `카테고리: ${row.category}` : '',
        row?.post_type === 'lecture' && row?.lecture_number ? `강의: ${row.series_name || 'unknown'} ${row.lecture_number}강` : '',
      ].filter(Boolean).join('\n');
      const sourceId = String(row?.id || '');
      candidates.push({
        sourceKind: 'blog_post',
        sourceTable: 'blog.posts',
        sourceId,
        title: `[blog_post] ${title}${chunkCount > 1 ? ` (${index + 1}/${chunkCount})` : ''}`,
        type: 'blog_post',
        content: `${prefix}\n\n${chunk}`.trim(),
        tags: postTags(row),
        filePath: `library/blo/post/${sourceId}/chunk-${String(index + 1).padStart(3, '0')}-${shortHash(`post:${sourceId}:chunk:${index + 1}`)}`,
        meta: {
          sourceTable: 'blog.posts',
          sourceId,
          sourceKind: 'blog_post',
          createdAt: row?.created_at || null,
          publishDate: row?.publish_date || null,
          status: row?.status || null,
          postType: row?.post_type || null,
          category: row?.category || null,
          lectureNumber: row?.lecture_number ?? null,
          seriesName: row?.series_name || null,
          chunkIndex: index + 1,
          chunkCount,
          contentHash: contentHash(chunk),
          structure: buildPostStructureMeta(row, rawContent),
          crank: buildPostCrankMeta(row),
        },
      });
    });
  }
  return candidates;
}

function buildInboundCommentCandidates(comments: any[]) {
  const candidates = [];
  for (const row of comments || []) {
    const redactedComment = redactBlogPii(row?.comment_text || '', row);
    const redactedReply = redactBlogPii(row?.reply_text || '', row);
    const content = normalizeText([
      '[블로그 수신 댓글]',
      row?.post_title ? `게시글: ${row.post_title}` : '',
      redactedComment.text ? `댓글: ${redactedComment.text}` : '',
      redactedReply.text ? `답글: ${redactedReply.text}` : '',
    ].filter(Boolean).join('\n'));
    if (!content) continue;
    const sourceId = String(row?.id || '');
    const redactions = [...new Set([...(redactedComment.redactions || []), ...(redactedReply.redactions || [])])].sort();
    candidates.push({
      sourceKind: 'blog_comment_inbound',
      sourceTable: 'blog.comments',
      sourceId,
      title: `[blog_comment] ${String(row?.post_title || 'inbound comment').trim().slice(0, 96)}`,
      type: 'blog_comment',
      content,
      tags: commentTags('inbound', row),
      filePath: `library/blo/comment/inbound/${sourceId}-${shortHash(`comment:${sourceId}`)}`,
      meta: {
        sourceTable: 'blog.comments',
        sourceId,
        sourceKind: 'blog_comment_inbound',
        createdAt: row?.detected_at || null,
        status: row?.status || null,
        postTitle: row?.post_title || null,
        hasReply: Boolean(row?.reply_text),
        redactions,
      },
    });
  }
  return candidates;
}

function buildCommentActionCandidates(actions: any[]) {
  const candidates = [];
  for (const row of actions || []) {
    const redactedComment = redactBlogPii(row?.comment_text || '', row);
    const content = normalizeText([
      '[블로그 댓글 액션]',
      row?.action_type ? `유형: ${row.action_type}` : '',
      row?.success == null ? '' : `성공: ${row.success ? 'true' : 'false'}`,
      redactedComment.text ? `댓글: ${redactedComment.text}` : '',
    ].filter(Boolean).join('\n'));
    if (!content) continue;
    const sourceId = String(row?.id || '');
    candidates.push({
      sourceKind: 'blog_comment_action',
      sourceTable: 'blog.comment_actions',
      sourceId,
      title: `[blog_comment] ${String(row?.action_type || 'comment action').trim().slice(0, 96)}`,
      type: 'blog_comment',
      content,
      tags: commentTags('action', row),
      filePath: `library/blo/comment/action/${sourceId}-${shortHash(`comment_action:${sourceId}`)}`,
      meta: {
        sourceTable: 'blog.comment_actions',
        sourceId,
        sourceKind: 'blog_comment_action',
        createdAt: row?.executed_at || null,
        actionType: row?.action_type || null,
        success: row?.success ?? null,
        redactions: redactedComment.redactions || [],
      },
    });
  }
  return candidates;
}

function buildExternalTrendCandidates(trends: any[]) {
  const candidates = [];
  for (const row of trends || []) {
    const meta = typeof row?.meta === 'string' ? safeJson(row.meta) : (row?.meta || {});
    const raw = meta?.raw || {};
    const genre = String(raw.genre || meta.genre || row.genre || '').trim();
    if (!['it', 'book'].includes(genre)) continue;
    const sourceId = String(row?.id || '');
    const sourceTitle = String(raw.review_title || raw.title || raw.book_title || row?.topic_ko || '').trim();
    const title = sourceTitle || `external ${genre} trend ${sourceId}`;
    const content = normalizeText([
      `[블로그 외부 ${genre === 'book' ? '도서' : 'IT'} 트렌드]`,
      `출처: ${row?.source || raw.source || 'unknown'}`,
      `제목: ${title}`,
      raw.book_title ? `도서: ${raw.book_title}` : '',
      raw.title_pattern?.label ? `제목 패턴: ${raw.title_pattern.label}` : '',
      raw.structure_hint ? `구조 힌트: ${JSON.stringify(raw.structure_hint)}` : '',
      raw.url ? `URL: ${raw.url}` : '',
    ].filter(Boolean).join('\n'));
    if (!content) continue;
    candidates.push({
      sourceKind: 'blog_external_trend',
      sourceTable: 'blog.trend_topics',
      sourceId,
      title: `[blog_external_${genre}] ${title.slice(0, 96)}`,
      type: 'blog_external_trend',
      content,
      tags: externalTrendTags(row),
      filePath: `library/blo/external/${genre}/${sourceId}-${shortHash(`external:${genre}:${sourceId}:${title}`)}`,
      meta: {
        sourceTable: 'blog.trend_topics',
        sourceId,
        sourceKind: 'blog_external_trend',
        source: row?.source || raw.source || null,
        genre,
        createdAt: row?.created_at || raw.collected_at || null,
        titlePattern: raw.title_pattern || null,
        scoreSignal: raw.score_signal || null,
        libraryCoords: {
          abstraction_level: 'L1',
          time_stage: 'raw',
          validation_state: 'unverified',
          prediction_state: 'none',
        },
      },
    });
  }
  return candidates;
}

export function buildBlogVaultCandidates(rows: {
  posts?: any[];
  comments?: any[];
  commentActions?: any[];
  externalTrends?: any[];
}, options: { chunkSize?: number } = {}) {
  return [
    ...buildPostCandidates(rows.posts || [], options),
    ...buildInboundCommentCandidates(rows.comments || []),
    ...buildCommentActionCandidates(rows.commentActions || []),
    ...buildExternalTrendCandidates(rows.externalTrends || []),
  ];
}

export function entryForCandidate(candidate: any) {
  const meta = attachSourceRefToMeta({
    ...(candidate.meta || {}),
    team: 'blog',
    source: 'blo',
  }, sourceRefFromCandidate(candidate, 'blog'));
  return {
    title: candidate.title,
    type: candidate.type,
    content: candidate.content,
    tags: candidate.tags,
    filePath: candidate.filePath,
    source: 'blo',
    meta,
  };
}

export function buildPopularPatternEntry(pattern: any = {}, options: { key?: string } = {}) {
  const content = normalizeText(pattern.content || pattern.summary || pattern.pattern || '');
  const title = String(pattern.title || pattern.name || 'blog popular pattern').trim();
  const key = String(options.key || pattern.id || pattern.key || title || contentHash(content));
  return {
    title: `[popular_pattern] ${title.slice(0, 96)}`,
    type: 'popular_pattern',
    content: content || title,
    tags: ['blog', 'blo', 'popular_pattern', safeTag(pattern.category) || 'lecture'].filter(Boolean).slice(0, 12),
    filePath: `library/blo/popular_pattern/${shortHash(key)}`,
    source: 'blo',
    meta: attachSourceRefToMeta({
      sourceTable: 'popular_pattern_interface',
      sourceId: key,
      sourceKind: 'popular_pattern',
      category: pattern.category || null,
      createdAt: pattern.createdAt || new Date().toISOString(),
      contentHash: contentHash(content || title),
      metrics: pattern.metrics || {},
    }, { team: 'blog', table: 'popular_pattern_interface', id: key }),
  };
}

export async function persistPopularPattern(pattern: any = {}, options: { dryRun?: boolean; write?: boolean } = {}) {
  const entry = buildPopularPatternEntry(pattern);
  const effectiveDryRun = options.dryRun !== false || options.write !== true;
  if (effectiveDryRun) {
    return { ok: true, dryRun: true, entry, persisted: false };
  }
  const manager = new VaultManager();
  const persisted = await manager.addToInbox(entry);
  return { ok: persisted.ok, dryRun: false, entry, persisted };
}

async function latestVaultCreatedAtBySource(sourceTable: string, pool: any): Promise<string | null> {
  try {
    const rows = await pool.query('sigma', `
      SELECT MAX((meta->>'createdAt')::timestamptz) AS latest
      FROM sigma.vault_entries
      WHERE source = 'blo'
        AND meta->>'sourceTable' = $1
        AND COALESCE(meta->>'createdAt', '') <> ''
    `, [sourceTable]);
    return rows?.[0]?.latest || rows?.rows?.[0]?.latest || null;
  } catch {
    return null;
  }
}

async function sourceTableExists(pool: any, schemaName: string, tableName: string): Promise<boolean> {
  try {
    const rows = await pool.query('public', 'SELECT to_regclass($1) AS regclass', [`${schemaName}.${tableName}`]);
    return Boolean(rows?.[0]?.regclass || rows?.rows?.[0]?.regclass);
  } catch {
    return false;
  }
}

async function sourceTableHasColumns(pool: any, schemaName: string, tableName: string, columns: string[]): Promise<boolean> {
  try {
    const rows = await pool.query('public', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND column_name = ANY($3::text[])
    `, [schemaName, tableName, columns]);
    const present = new Set((rows?.rows || rows || []).map((row: any) => String(row.column_name)));
    return columns.every((column) => present.has(column));
  } catch {
    return false;
  }
}

function fallbackSinceIso(sinceHours: number): string {
  return new Date(Date.now() - sinceHours * 3600_000).toISOString();
}

async function collectBlogRows(options: {
  backfill?: boolean;
  sinceHours?: number;
  limitPerSource?: number;
}, pool: any = pgPool) {
  const sinceHours = boundedNumber(options.sinceHours, DEFAULT_SINCE_HOURS, 1, 24 * 365);
  const limitPerSource = Math.floor(boundedNumber(options.limitPerSource, DEFAULT_LIMIT_PER_SOURCE, 1, 50_000));
  const backfill = Boolean(options.backfill);

  const sinceByTable = {
    posts: backfill ? null : (await latestVaultCreatedAtBySource('blog.posts', pool) || fallbackSinceIso(sinceHours)),
    comments: backfill ? null : (await latestVaultCreatedAtBySource('blog.comments', pool) || fallbackSinceIso(sinceHours)),
    commentActions: backfill ? null : (await latestVaultCreatedAtBySource('blog.comment_actions', pool) || fallbackSinceIso(sinceHours)),
    externalTrends: backfill ? null : (await latestVaultCreatedAtBySource('blog.trend_topics', pool) || fallbackSinceIso(sinceHours)),
  };
  const [finalContentColumnsExist, crankScoresExists] = await Promise.all([
    sourceTableHasColumns(pool, 'blog', 'final_content_checks', ['final_title', 'final_content_text', 'checked_at', 'metadata']),
    sourceTableExists(pool, 'blog', 'crank_scores'),
  ]);
  const finalSelect = finalContentColumnsExist
    ? `,
             fcc.final_title,
             fcc.final_content_text,
             fcc.checked_at AS final_content_checked_at,
             fcc.metadata AS final_content_metadata`
    : `,
             NULL::text AS final_title,
             NULL::text AS final_content_text,
             NULL::timestamptz AS final_content_checked_at,
             NULL::jsonb AS final_content_metadata`;
  const finalJoin = finalContentColumnsExist
    ? `
      LEFT JOIN LATERAL (
        SELECT final_title, final_content_text, checked_at, metadata
        FROM blog.final_content_checks
        WHERE post_id = p.id
        ORDER BY checked_at DESC
        LIMIT 1
      ) fcc ON true`
    : '';
  const crankSelect = crankScoresExists
    ? `,
             cs.scored_date AS crank_scored_date,
             cs.overall AS crank_overall,
             cs.crank_total,
             cs.dia_total,
             cs.geo_total`
    : `,
             NULL::date AS crank_scored_date,
             NULL::int AS crank_overall,
             NULL::int AS crank_total,
             NULL::int AS dia_total,
             NULL::int AS geo_total`;
  const crankJoin = crankScoresExists
    ? `
      LEFT JOIN LATERAL (
        SELECT scored_date, overall, crank_total, dia_total, geo_total
        FROM blog.crank_scores
        WHERE post_id = p.id
        ORDER BY scored_date DESC, id DESC
        LIMIT 1
      ) cs ON true`
    : '';

  const trendTopicsExists = await sourceTableExists(pool, 'blog', 'trend_topics');

  const [posts, comments, commentActions, externalTrends] = await Promise.all([
    pool.query('blog', `
      SELECT p.id, p.title, p.category, p.post_type, p.lecture_number, p.series_name, p.publish_date, p.status,
             p.char_count, p.content, p.html_content, p.hashtags, p.naver_url, p.metadata, p.created_at
             ${finalSelect}
             ${crankSelect}
      FROM blog.posts p
      ${finalJoin}
      ${crankJoin}
      WHERE ($1::timestamptz IS NULL OR p.created_at > $1::timestamptz)
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT $2
    `, [sinceByTable.posts, limitPerSource]),
    pool.query('blog', `
      SELECT id, post_url, post_title, commenter_id, commenter_name, comment_text, comment_ref,
             reply_text, reply_at, detected_at, status, error_message, meta
      FROM blog.comments
      WHERE ($1::timestamptz IS NULL OR detected_at > $1::timestamptz)
      ORDER BY detected_at ASC, id ASC
      LIMIT $2
    `, [sinceByTable.comments, limitPerSource]),
    pool.query('blog', `
      SELECT id, action_type, target_blog, target_post_url, comment_text, success, executed_at, meta
      FROM blog.comment_actions
      WHERE ($1::timestamptz IS NULL OR executed_at > $1::timestamptz)
      ORDER BY executed_at ASC, id ASC
      LIMIT $2
    `, [sinceByTable.commentActions, limitPerSource]),
    trendTopicsExists
      ? pool.query('blog', `
        SELECT id, date, source, topic_ko, category, meta, created_at
        FROM blog.trend_topics
        WHERE ($1::timestamptz IS NULL OR created_at > $1::timestamptz)
          AND COALESCE(meta->'raw'->>'genre', meta->>'genre', '') IN ('it', 'book')
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `, [sinceByTable.externalTrends, limitPerSource])
      : Promise.resolve([]),
  ]);

  return {
    posts: Array.isArray(posts) ? posts : posts?.rows || [],
    comments: Array.isArray(comments) ? comments : comments?.rows || [],
    commentActions: Array.isArray(commentActions) ? commentActions : commentActions?.rows || [],
    externalTrends: Array.isArray(externalTrends) ? externalTrends : externalTrends?.rows || [],
    sinceByTable,
    limitPerSource,
  };
}

export async function runSigmaBlogVaultFeed(options: {
  backfill?: boolean;
  sinceHours?: number;
  limitPerSource?: number;
  dryRun?: boolean;
  write?: boolean;
  sampleEmbedding?: boolean;
} = {}) {
  const effectiveDryRun = options.dryRun !== false || options.write !== true;
  const rows = await collectBlogRows(options, pgPool);
  const candidates = buildBlogVaultCandidates(rows);

  const embeddingProbeRecord = candidates.find((record) => record.content) || null;
  const embeddingProbe = embeddingProbeRecord && (options.sampleEmbedding !== false || effectiveDryRun)
    ? await createVaultEmbedding(embeddingProbeRecord.content)
    : { embedding: null, dim: null, warning: 'embedding_probe_skipped' };

  const manager = effectiveDryRun ? null : new VaultManager();
  const results = [];
  if (manager) {
    for (const candidate of candidates) {
      const entry = entryForCandidate(candidate);
      const persisted = await manager.addToInbox(entry);
      results.push({
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        filePath: entry.filePath,
        ok: persisted.ok,
        id: persisted.id || null,
        embedded: persisted.embedded,
        embeddingDim: persisted.embeddingDim ?? null,
        embeddingWarning: persisted.embeddingWarning || null,
        message: persisted.message,
      });
    }
  }

  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    dryRun: effectiveDryRun,
    backfill: Boolean(options.backfill),
    sinceHours: boundedNumber(options.sinceHours, DEFAULT_SINCE_HOURS, 1, 24 * 365),
    limitPerSource: rows.limitPerSource,
    sinceByTable: rows.sinceByTable,
    sourceRows: {
      posts: rows.posts.length,
      comments: rows.comments.length,
      commentActions: rows.commentActions.length,
      externalTrends: rows.externalTrends.length,
    },
    candidates: candidates.length,
    candidatesBySource: countBy(candidates, (record) => record.sourceKind),
    piiRedactionSample: candidates
      .filter((record) => Array.isArray(record.meta?.redactions) && record.meta.redactions.length > 0)
      .slice(0, 3)
      .map((record) => ({
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        redactions: record.meta.redactions,
        text: String(record.content || '').slice(0, 220),
      })),
    embeddingProbe: {
      sourceKind: embeddingProbeRecord?.sourceKind || null,
      dim: embeddingProbe.dim,
      embedded: Boolean(embeddingProbe.embedding),
      warning: embeddingProbe.warning || null,
    },
    persisted: {
      attempted: results.length,
      ok: results.filter((item) => item.ok).length,
      failed: failed.length,
      embedded: results.filter((item) => item.embedded).length,
      bySource: countBy(results.filter((item) => item.ok), (item) => item.sourceKind),
      embeddingWarnings: results.filter((item) => item.embeddingWarning).slice(0, 10),
      failures: failed.slice(0, 10),
    },
    sample: candidates.slice(0, 3).map((candidate) => ({
      sourceKind: candidate.sourceKind,
      sourceId: candidate.sourceId,
      title: candidate.title,
      filePath: candidate.filePath,
      text: String(candidate.content || '').slice(0, 220),
    })),
    safety: {
      defaultDryRun: true,
      dbWriteRequiresWriteAndNoDryRun: true,
      writesOnlySigmaVaultEntries: true,
      vaultCoreModified: false,
      livePublishImpact: false,
      externalTrendGenreRequired: true,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const json = hasFlag('json');
  const write = hasFlag('write');
  const noDryRun = hasFlag('no-dry-run');
  const result = await runSigmaBlogVaultFeed({
    backfill: hasFlag('backfill'),
    sinceHours: boundedNumber(argValue('since-hours', String(DEFAULT_SINCE_HOURS)), DEFAULT_SINCE_HOURS, 1, 24 * 365),
    limitPerSource: boundedNumber(argValue('limit-per-source', String(DEFAULT_LIMIT_PER_SOURCE)), DEFAULT_LIMIT_PER_SOURCE, 1, 50_000),
    dryRun: !noDryRun || hasFlag('dry-run'),
    write,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[sigma-blog-vault-feed] dryRun=${result.dryRun} backfill=${result.backfill} candidates=${result.candidates} persisted=${result.persisted.ok}/${result.persisted.attempted}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}

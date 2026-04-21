// @ts-nocheck
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { parseNaverBlogUrl } = require('../../../packages/core/lib/naver-blog-url');
const { getBlogCommenterConfig, getBlogNeighborCommenterConfig, getBlogLLMSelectorOverrides } = require('./runtime-config.ts');

const TABLE = 'blog.comments';
const ACTION_TABLE = 'blog.comment_actions';
const NEIGHBOR_TABLE = 'blog.neighbor_comments';
const DEFAULT_SUMMARY_LEN = 220;
const BROWSER_CONNECT_TIMEOUT_MS = 5000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 180000;
const NAVER_NAVIGATION_TIMEOUT_MS = 45000;
const NAVER_MONITOR_WS_FILE = path.join(env.OPENCLAW_WORKSPACE, 'naver-monitor-ws.txt');
const BLOG_COMMENTER_DEBUG_DIR = path.join(env.PROJECT_ROOT, 'tmp', 'blog-commenter-debug');

function traceCommenter(...args) {
  if (process.env.BLOG_COMMENTER_TRACE !== 'true') return;
  console.log('[blog-commenter]', ...args);
}

function shouldCaptureHeavyCommentDebug() {
  return process.env.BLOG_COMMENTER_TRACE === 'true' || process.env.BLOG_COMMENTER_HEAVY_DEBUG === 'true';
}

function buildCommenterFallbackChain(maxTokens, temperature) {
  return [
    { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens, temperature: Math.min(temperature, 0.7), timeoutMs: 15000 },
    { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens, temperature, timeoutMs: 12000 },
    { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens, temperature, timeoutMs: 12000 },
    { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens, temperature: Math.min(temperature, 0.7) },
  ];
}

function nowKstHour() {
  return Number(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours());
}

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function readOpenClawGatewayTokenFromConfig() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.gateway?.auth?.token || '').trim();
  } catch {
    return '';
  }
}

function readNaverMonitorWsEndpoint() {
  try {
    return String(fs.readFileSync(NAVER_MONITOR_WS_FILE, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function getCommenterConfig() {
  const runtime = getBlogCommenterConfig();
  const browserToken = String(
    runtime.browserToken
    || process.env.OPENCLAW_BROWSER_TOKEN
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || readOpenClawGatewayTokenFromConfig()
    || ''
  ).trim();
  return {
    enabled: runtime.enabled === true,
    blogId: String(runtime.blogId || '').trim(),
    maxDaily: Number(runtime.maxDaily || 20),
    activeStartHour: Number(runtime.activeStartHour || 8),
    activeEndHour: Number(runtime.activeEndHour || 22),
    browserHttpUrl: String(runtime.browserHttpUrl || '').trim(),
    browserWsEndpoint: String(runtime.browserWsEndpoint || '').trim(),
    browserToken,
    profileDir: expandHome(runtime.profileDir || path.join(env.OPENCLAW_WORKSPACE, 'naver-profile')),
    pageReadMinSec: Number(runtime.pageReadMinSec || 30),
    pageReadMaxSec: Number(runtime.pageReadMaxSec || 90),
    typingMinSec: Number(runtime.typingMinSec || 20),
    typingMaxSec: Number(runtime.typingMaxSec || 45),
    betweenCommentsMinSec: Number(runtime.betweenCommentsMinSec || 60),
    betweenCommentsMaxSec: Number(runtime.betweenCommentsMaxSec || 180),
    minReplyLen: Number(runtime.minReplyLen || 30),
    maxReplyLen: Number(runtime.maxReplyLen || 200),
    maxDetectPerCycle: Number(runtime.maxDetectPerCycle || 20),
    maxProcessPerCycle: Number(runtime.maxProcessPerCycle || 20),
    processTimeoutMs: Number(runtime.processTimeoutMs || 240000),
  };
}

function getNeighborCommenterConfig() {
  const runtime = getBlogNeighborCommenterConfig();
  return {
    enabled: runtime.enabled === true,
    blogId: String(runtime.blogId || '').trim(),
    maxDaily: Number(runtime.maxDaily || 20),
    activeStartHour: Number(runtime.activeStartHour || 9),
    activeEndHour: Number(runtime.activeEndHour || 21),
    maxCollectPerCycle: Number(runtime.maxCollectPerCycle || 20),
    maxProcessPerCycle: Number(runtime.maxProcessPerCycle || 20),
    recentWindowDays: Number(runtime.recentWindowDays || 14),
    minCommentLen: Number(runtime.minCommentLen || 45),
    maxCommentLen: Number(runtime.maxCommentLen || 220),
    processTimeoutMs: Number(runtime.processTimeoutMs || 180000),
  };
}

async function inferBlogIdFromPublishedPosts() {
  try {
    const row = await pgPool.get('blog', `
      SELECT naver_url
      FROM blog.posts
      WHERE naver_url IS NOT NULL
        AND naver_url <> ''
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!row?.naver_url) return '';
    const parsed = parseNaverBlogUrl(row.naver_url);
    return parsed.ok ? parsed.blogId : '';
  } catch {
    return '';
  }
}

async function resolveBlogId() {
  const config = getCommenterConfig();
  if (config.blogId) return config.blogId;
  return inferBlogIdFromPublishedPosts();
}

function buildDedupeKey(postUrl, commenterId, commentText) {
  const raw = [String(postUrl || '').trim(), String(commenterId || '').trim(), String(commentText || '').trim()].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function squeezeText(value, maxLen = DEFAULT_SUMMARY_LEN) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isWithinActiveWindow(config = getCommenterConfig()) {
  const hour = nowKstHour();
  return hour >= config.activeStartHour && hour <= config.activeEndHour;
}

function calcExpectedByWindow(target = 20, activeStartHour = 9, activeEndHour = 21) {
  const safeTarget = Math.max(0, Number(target || 0));
  const startHour = Number(activeStartHour || 9);
  const endHour = Number(activeEndHour || 21);
  const totalSlots = Math.max(1, endHour - startHour + 1);
  const currentHour = nowKstHour();
  const active = currentHour >= startHour && currentHour <= endHour;
  if (!active) {
    return { target: safeTarget, expectedNow: 0, active, totalSlots, currentHour };
  }
  const elapsedSlots = Math.max(1, Math.min(totalSlots, currentHour - startHour + 1));
  const expectedNow = Math.min(safeTarget, Math.ceil((safeTarget * elapsedSlots) / totalSlots));
  return { target: safeTarget, expectedNow, active, totalSlots, currentHour };
}

function buildAdaptiveNeighborCadence(config, metrics = {}) {
  const neighborPlan = calcExpectedByWindow(config.maxDaily || 20, config.activeStartHour || 9, config.activeEndHour || 21);
  const replyPlan = calcExpectedByWindow(
    Number(metrics.replyTarget || getCommenterConfig().maxDaily || 20),
    Number(metrics.replyActiveStartHour || getCommenterConfig().activeStartHour || 9),
    Number(metrics.replyActiveEndHour || getCommenterConfig().activeEndHour || 21),
  );
  const replySuccess = Math.max(0, Number(metrics.replySuccess || 0));
  const neighborSuccess = Math.max(0, Number(metrics.neighborSuccess || 0));
  const sympathySuccess = Math.max(0, Number(metrics.sympathySuccess || 0));
  const baseProcess = Math.max(1, Number(config.maxProcessPerCycle || 20));
  const baseCollect = Math.max(1, Number(config.maxCollectPerCycle || 20));
  const adaptiveEnabled = config.adaptiveEnabled !== false;
  const boostCap = Math.max(2, Number(config.adaptiveBoostCap || 12));
  const collectBoostCap = Math.max(2, Number(config.adaptiveCollectBoostCap || 20));
  const sympathyBoostCap = Math.max(2, Number(config.adaptiveSympathyBoostCap || 8));
  const minGapToBoost = Math.max(1, Number(config.adaptiveMinGapToBoost || 2));

  const neighborDeficit = Math.max(0, neighborPlan.expectedNow - neighborSuccess);
  const sympathyDeficit = Math.max(0, neighborPlan.expectedNow - sympathySuccess);
  const combinedCommentSuccess = replySuccess + neighborSuccess;
  const combinedCommentExpectedNow = replyPlan.expectedNow + neighborPlan.expectedNow;
  const combinedCommentDeficit = Math.max(0, combinedCommentExpectedNow - combinedCommentSuccess);
  const drivingGap = Math.max(neighborDeficit, Math.min(neighborPlan.expectedNow, combinedCommentDeficit));
  const shouldBoost = adaptiveEnabled && neighborPlan.active && drivingGap >= minGapToBoost;
  const processBoost = shouldBoost ? Math.min(boostCap, drivingGap) : 0;
  const collectBoost = shouldBoost ? Math.min(collectBoostCap, Math.max(processBoost, drivingGap * 2)) : 0;
  const sympathyBoost = adaptiveEnabled && neighborPlan.active && sympathyDeficit >= minGapToBoost
    ? Math.min(sympathyBoostCap, sympathyDeficit)
    : 0;

  return {
    active: neighborPlan.active,
    replySuccess,
    neighborSuccess,
    sympathySuccess,
    replyExpectedNow: replyPlan.expectedNow,
    neighborExpectedNow: neighborPlan.expectedNow,
    combinedCommentSuccess,
    combinedCommentExpectedNow,
    combinedCommentDeficit,
    neighborDeficit,
    sympathyDeficit,
    shouldBoost,
    processBoost,
    collectBoost,
    sympathyBoost,
    effectiveProcessLimit: baseProcess + processBoost,
    effectiveCollectLimit: baseCollect + collectBoost,
    effectiveSympathyLimit: baseProcess + sympathyBoost,
  };
}

function calcDelayMs(minSec, maxSec, testMode = false) {
  const min = Number(minSec || 0);
  const max = Number(maxSec || min);
  const fastDebug = process.env.BLOG_COMMENTER_FAST_DEBUG === 'true';
  const factor = (testMode || fastDebug) ? 0.03 : 1;
  const jitter = min + Math.random() * Math.max(0, max - min);
  return Math.round(jitter * 1000 * factor);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutError(code, message) {
  const error = new Error(message || code || 'timeout');
  error.code = code || 'timeout';
  return error;
}

function isNeighborCommentUiTimeoutError(error) {
  const message = String(error?.message || '');
  return (
    message === 'comment_editor_not_found'
    || message.startsWith('comment_panel_not_mounted:')
    || /Waiting failed: \d+ms exceeded/.test(message)
  );
}

function isDirectReplyUiError(error) {
  const message = String(error?.message || '');
  return (
    message.startsWith('reply_button_not_found:')
    || message === 'reply_editor_not_found'
    || message.startsWith('reply_submit_not_confirmed:')
    || /Waiting failed: \d+ms exceeded/.test(message)
  );
}

async function processNeighborCommentWithTimeout(candidate, { testMode = false } = {}) {
  const config = getNeighborCommenterConfig();
  return Promise.race([
    processNeighborComment(candidate, { testMode }),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(createTimeoutError('neighbor_comment_process_timeout', `neighbor_comment_process_timeout:${config.processTimeoutMs}`));
      }, Number(config.processTimeoutMs || 180000));
    }),
  ]);
}

async function processCommentWithTimeout(comment, { testMode = false } = {}) {
  const config = getCommenterConfig();
  const timeoutMs = testMode ? Math.min(Number(config.processTimeoutMs || 240000), 45000) : Number(config.processTimeoutMs || 240000);
  return Promise.race([
    processComment(comment, { testMode, operationTimeoutMs: timeoutMs }),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(createTimeoutError('reply_process_timeout', `reply_process_timeout:${timeoutMs}`));
      }, timeoutMs);
    }),
  ]);
}

async function humanDelay(minSec, maxSec, testMode = false) {
  const delayMs = calcDelayMs(minSec, maxSec, testMode);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

async function ensureSchema() {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      post_url TEXT NOT NULL,
      post_title TEXT,
      commenter_id TEXT,
      commenter_name TEXT,
      comment_text TEXT NOT NULL,
      comment_ref TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      reply_text TEXT,
      reply_at TIMESTAMPTZ,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      meta JSONB DEFAULT '{}'::JSONB
    )
  `);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_comments_status ON ${TABLE}(status)`);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_comments_detected ON ${TABLE}(detected_at DESC)`);
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS ${ACTION_TABLE} (
      id SERIAL PRIMARY KEY,
      action_type TEXT NOT NULL,
      target_blog TEXT,
      target_post_url TEXT,
      comment_text TEXT,
      success BOOLEAN DEFAULT true,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::JSONB
    )
  `);
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS ${NEIGHBOR_TABLE} (
      id SERIAL PRIMARY KEY,
      target_blog_id TEXT NOT NULL,
      target_blog_name TEXT,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      post_url TEXT NOT NULL,
      post_title TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      comment_text TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      posted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::JSONB
    )
  `);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_neighbor_comments_status ON ${NEIGHBOR_TABLE}(status, created_at DESC)`);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_neighbor_comments_blog ON ${NEIGHBOR_TABLE}(target_blog_id, created_at DESC)`);
}

async function recordCommentAction(actionType, payload = {}) {
  const targetPostUrl = String(payload.targetPostUrl || '').trim();
  const shouldDedupeSuccessByPost =
    payload.success !== false
    && targetPostUrl
    && ['neighbor_comment', 'neighbor_sympathy', 'neighbor_comment_sympathy', 'comment_post', 'comment_post_sympathy'].includes(String(actionType || ''));

  if (shouldDedupeSuccessByPost) {
    const existing = await pgPool.get('blog', `
      SELECT id
      FROM ${ACTION_TABLE}
      WHERE action_type = $1
        AND success = true
        AND target_post_url = $2
        AND timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
      LIMIT 1
    `, [actionType, targetPostUrl]);
    if (existing?.id) {
      return { ok: true, skippedDuplicate: true, id: existing.id };
    }
  }

  await pgPool.run('blog', `
    INSERT INTO ${ACTION_TABLE} (action_type, target_blog, target_post_url, comment_text, success, meta)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [
    actionType,
    payload.targetBlog || null,
    targetPostUrl || null,
    payload.commentText || null,
    payload.success !== false,
    JSON.stringify(payload.meta || {}),
  ]);
  return { ok: true, skippedDuplicate: false };
}

async function getTodayReplyCount() {
  const row = await pgPool.get('blog', `
    SELECT COUNT(*) AS count
    FROM ${TABLE}
    WHERE status = 'replied'
      AND timezone('Asia/Seoul', reply_at)::date = timezone('Asia/Seoul', now())::date
  `);
  return Number(row?.count || 0);
}

async function getTodayNeighborCommentCount() {
  const row = await pgPool.get('blog', `
    SELECT COUNT(*) AS count
    FROM ${NEIGHBOR_TABLE}
    WHERE status = 'posted'
      AND timezone('Asia/Seoul', posted_at)::date = timezone('Asia/Seoul', now())::date
  `);
  return Number(row?.count || 0);
}

async function getTodayActionCount(actionType) {
  const row = await pgPool.get('blog', `
    SELECT COUNT(*) AS count
    FROM ${ACTION_TABLE}
    WHERE action_type = $1
      AND success = true
      AND timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
  `, [actionType]);
  return Number(row?.count || 0);
}

async function getPendingComments(limit = 20) {
  return pgPool.query('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE status = 'pending'
    ORDER BY detected_at DESC
    LIMIT $1
  `, [limit]);
}

function isRecoverableReplyFailure(row) {
  const status = String(row?.status || '');
  const errorMessage = String(row?.error_message || '');
  if (!['failed', 'skipped'].includes(status)) return false;
  if (!errorMessage) return false;
  return (
    errorMessage === '__name is not defined'
    || errorMessage === 'reply_button_not_found'
    || errorMessage.startsWith('reply_button_not_found:')
    || errorMessage === 'reply_submit_not_confirmed'
    || errorMessage.startsWith('reply_submit_not_confirmed:')
    || errorMessage === 'reply_ui_unavailable'
    || errorMessage === 'comment_panel_not_mounted'
    || errorMessage.startsWith('comment_panel_not_mounted:')
  );
}

async function requeueRecoverableReplyFailures(limit = 10) {
  const rows = await pgPool.query('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE reply_at IS NULL
      AND status IN ('failed', 'skipped')
    ORDER BY detected_at DESC
    LIMIT $1
  `, [Math.max(limit * 3, limit)]);

  let requeued = 0;
  for (const row of rows) {
    if (requeued >= limit) break;
    if (!isRecoverableReplyFailure(row)) continue;
    const inboundAssessment = assessInboundComment(row);
    if (!inboundAssessment.ok) continue;

    await pgPool.run('blog', `
      UPDATE ${TABLE}
      SET status = 'pending',
          error_message = NULL,
          meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
      WHERE id = $1
    `, [
      row.id,
      JSON.stringify({
        phase: 'recoverable_requeue',
        previous_error: row.error_message || null,
      }),
    ]);
    requeued += 1;
  }

  return requeued;
}

async function requeueCourtesyReflectionCandidates(limit = 5, options = {}) {
  const numericLimit = Math.max(1, Number(limit || 5));
  const dryRun = Boolean(options?.dryRun);
  const rows = await pgPool.query('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE reply_at IS NULL
      AND status = 'skipped'
      AND COALESCE(error_message, '') = 'generic_greeting_comment'
      AND detected_at >= now() - interval '14 days'
    ORDER BY detected_at DESC
    LIMIT $1
  `, [Math.max(numericLimit * 4, numericLimit)]);

  const requeued = [];
  for (const row of rows) {
    if (requeued.length >= numericLimit) break;
    const inboundAssessment = assessInboundComment(row);
    if (!inboundAssessment.ok) continue;
    if (!['courtesy_reflection_allowed', 'generic_greeting_reply_allowed'].includes(String(inboundAssessment.reason || ''))) continue;

    const candidate = {
      id: row.id,
      commenterName: row.commenter_name || '',
      commentText: row.comment_text || '',
      detectedAt: row.detected_at || null,
      previousError: row.error_message || null,
      reassessedReason: inboundAssessment.reason,
    };

    if (!dryRun) {
      await pgPool.run('blog', `
        UPDATE ${TABLE}
        SET status = 'pending',
            error_message = NULL,
            meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
      `, [
        row.id,
        JSON.stringify({
          phase: 'courtesy_reply_backfill',
          previous_error: row.error_message || null,
          reassessed_reason: inboundAssessment.reason,
          requeued_at: new Date().toISOString(),
        }),
      ]);
    }

    requeued.push(candidate);
  }

  return {
    dryRun,
    reviewed: Array.isArray(rows) ? rows.length : 0,
    requeuedCount: requeued.length,
    candidates: requeued,
  };
}

async function updateCommentStatus(id, status, options = {}) {
  const fields = [
    'status = $2',
    'reply_text = COALESCE($3, reply_text)',
    'error_message = $4',
    'reply_at = CASE WHEN $2 = \'replied\' THEN NOW() ELSE reply_at END',
    'meta = COALESCE(meta, \'{}\'::jsonb) || $5::jsonb',
  ];
  await pgPool.run('blog', `
    UPDATE ${TABLE}
    SET ${fields.join(', ')}
    WHERE id = $1
  `, [
    id,
    status,
    options.replyText || null,
    options.errorMessage || null,
    JSON.stringify(options.meta || {}),
  ]);
}

function buildNeighborDedupeKey(targetBlogId, postUrl) {
  return crypto.createHash('sha1').update([String(targetBlogId || '').trim(), String(postUrl || '').trim()].join('|')).digest('hex');
}

async function hasSuccessfulNeighborCommentForPost(postUrl) {
  const normalized = String(postUrl || '').trim();
  if (!normalized) return false;

  const existing = await pgPool.get('blog', `
    SELECT 1
    FROM (
      SELECT post_url
      FROM ${NEIGHBOR_TABLE}
      WHERE status = 'posted'
        AND post_url = $1
      UNION ALL
      SELECT target_post_url AS post_url
      FROM ${ACTION_TABLE}
      WHERE success = true
        AND action_type = 'neighbor_comment'
        AND target_post_url = $1
    ) hits
    LIMIT 1
  `, [normalized]);

  return Boolean(existing);
}

async function saveNeighborCandidate(candidate) {
  const dedupeKey = buildNeighborDedupeKey(candidate.targetBlogId, candidate.postUrl);
  const alreadyCommented = await hasSuccessfulNeighborCommentForPost(candidate.postUrl);
  if (alreadyCommented) {
    return {
      inserted: false,
      id: null,
      dedupeKey,
      skippedExistingSuccess: true,
    };
  }
  const result = await pgPool.run('blog', `
    INSERT INTO ${NEIGHBOR_TABLE} (
      target_blog_id, target_blog_name, source_type, source_ref,
      post_url, post_title, dedupe_key, meta
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `, [
    candidate.targetBlogId,
    candidate.targetBlogName || null,
    candidate.sourceType,
    candidate.sourceRef || null,
    candidate.postUrl,
    candidate.postTitle || null,
    dedupeKey,
    JSON.stringify(candidate.meta || {}),
  ]);

  return {
    inserted: result.rowCount > 0,
    id: result.rows?.[0]?.id || null,
    dedupeKey,
    skippedExistingSuccess: false,
  };
}

async function getPendingNeighborComments(limit = 20) {
  return pgPool.query('blog', `
    SELECT *
    FROM ${NEIGHBOR_TABLE}
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1
  `, [limit]);
}

async function updateNeighborCommentStatus(id, status, options = {}) {
  await pgPool.run('blog', `
    UPDATE ${NEIGHBOR_TABLE}
    SET status = $2,
        comment_text = COALESCE($3, comment_text),
        error_message = $4,
        posted_at = CASE WHEN $2 = 'posted' THEN NOW() ELSE posted_at END,
        meta = COALESCE(meta, '{}'::jsonb) || $5::jsonb
    WHERE id = $1
  `, [
    id,
    status,
    options.commentText || null,
    options.errorMessage || null,
    JSON.stringify(options.meta || {}),
  ]);
}

async function getRecentlyTargetedPostUrls(recentWindowDays = 14) {
  const [neighborRows, actionRows] = await Promise.all([
    pgPool.query('blog', `
    SELECT post_url
    FROM ${NEIGHBOR_TABLE}
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `, [recentWindowDays]),
    pgPool.query('blog', `
    SELECT target_post_url AS post_url
    FROM ${ACTION_TABLE}
    WHERE success = true
      AND action_type IN ('neighbor_comment', 'neighbor_sympathy')
      AND executed_at >= NOW() - ($1::text || ' days')::interval
  `, [recentWindowDays]),
  ]);
  return new Set(
    [...neighborRows, ...actionRows]
      .map((row) => String(row.post_url || '').trim())
      .filter(Boolean),
  );
}

async function getRecentNeighborBlogIds(recentWindowDays = 14) {
  const [neighborRows, actionRows] = await Promise.all([
    pgPool.query('blog', `
    SELECT DISTINCT target_blog_id
    FROM ${NEIGHBOR_TABLE}
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `, [recentWindowDays]),
    pgPool.query('blog', `
    SELECT DISTINCT target_blog AS target_blog_id
    FROM ${ACTION_TABLE}
    WHERE success = true
      AND action_type IN ('neighbor_comment', 'neighbor_sympathy')
      AND executed_at >= NOW() - ($1::text || ' days')::interval
  `, [recentWindowDays]),
  ]);
  return new Set(
    [...neighborRows, ...actionRows]
      .map((row) => String(row.target_blog_id || '').trim())
      .filter(Boolean),
  );
}

async function saveDetectedComment(comment) {
  const dedupeKey = buildDedupeKey(comment.postUrl, comment.commenterId, comment.commentText);
  const existing = await pgPool.get('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE dedupe_key = $1
    LIMIT 1
  `, [dedupeKey]);

  if (existing?.id) {
    const recoverable = isRecoverableReplyFailure(existing);
    const inboundAssessment = assessInboundComment(existing);
    const shouldRequeue = Boolean(
      !existing.reply_at
      && ['failed', 'skipped'].includes(String(existing.status || ''))
      && recoverable
      && inboundAssessment.ok
    );

    await pgPool.run('blog', `
      UPDATE ${TABLE}
      SET status = CASE
            WHEN $2 THEN 'pending'
            ELSE status
          END,
          error_message = CASE
            WHEN $2 THEN NULL
            ELSE error_message
          END,
          meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
    `, [
      existing.id,
      shouldRequeue,
      JSON.stringify({
        ...(comment.meta || {}),
        ...(shouldRequeue ? {
          phase: 'recoverable_requeue',
          previous_error: existing.error_message || null,
        } : {}),
      }),
    ]);

    return { inserted: false, id: existing.id, dedupeKey, requeued: shouldRequeue };
  }

  const result = await pgPool.run('blog', `
    INSERT INTO ${TABLE} (
      post_url, post_title, commenter_id, commenter_name,
      comment_text, comment_ref, dedupe_key, meta
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    RETURNING id
  `, [
    comment.postUrl,
    comment.postTitle || null,
    comment.commenterId || null,
    comment.commenterName || null,
    comment.commentText,
    comment.commentRef || null,
    dedupeKey,
    JSON.stringify(comment.meta || {}),
  ]);

  if (result.rowCount > 0) {
    return { inserted: true, id: result.rows[0].id, dedupeKey, requeued: false };
  }
  return { inserted: false, dedupeKey, requeued: false };
}

async function hasSuccessfulReplyForComment(comment) {
  if (!comment?.id) return false;
  if (comment.reply_at) return true;
  if (String(comment.status || '') === 'replied') return true;

  const existing = await pgPool.get('blog', `
    SELECT id
    FROM ${ACTION_TABLE}
    WHERE action_type = 'reply'
      AND success = true
      AND (
        (meta->>'commentId')::int = $1
        OR (
          target_post_url = $2
          AND COALESCE(meta->>'commenterName', '') = $3
        )
      )
    ORDER BY executed_at DESC
    LIMIT 1
  `, [
    Number(comment.id),
    String(comment.post_url || ''),
    String(comment.commenter_name || ''),
  ]);

  return Boolean(existing?.id);
}

async function fetchManagedBrowserWsEndpoint(config) {
  const wsFileEndpoint = readNaverMonitorWsEndpoint();
  if (wsFileEndpoint) return wsFileEndpoint;
  if (config.browserWsEndpoint) return config.browserWsEndpoint;
  if (!config.browserHttpUrl) return '';

  const baseUrl = config.browserHttpUrl.replace(/\/+$/, '');
  const headers = {};
  const token = config.browserToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const statusRes = await fetch(`${baseUrl}/`, {
      headers,
      signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
    });
    if (statusRes.status === 401 || statusRes.status === 403) {
      const error = new Error('managed_browser_auth_failed');
      error.code = 'managed_browser_auth_failed';
      throw error;
    }
    if (statusRes.ok) {
      const status = await statusRes.json();
      const cdpUrl = String(status?.cdpUrl || '').trim();
      const ready = status?.running === true && status?.cdpReady === true && !!cdpUrl;
      if (!ready) {
        const reason = status?.running === false
          ? 'managed_browser_not_running'
          : 'managed_browser_not_ready';
        const error = new Error(reason);
        error.code = reason;
        throw error;
      }

      const cdpVersionRes = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, {
        signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
      });
      if (cdpVersionRes.status === 401 || cdpVersionRes.status === 403) {
        const error = new Error('managed_browser_auth_failed');
        error.code = 'managed_browser_auth_failed';
        throw error;
      }
      if (cdpVersionRes.ok) {
        const cdpVersion = await cdpVersionRes.json();
        if (cdpVersion?.webSocketDebuggerUrl) {
          return cdpVersion.webSocketDebuggerUrl;
        }
      }
    }
  } catch (error) {
    if (env.IS_OPS || token) {
      throw error;
    }
  }

  const candidates = [
    `${baseUrl}/json/version`,
    token ? `${baseUrl}/json/version?token=${encodeURIComponent(token)}` : '',
  ].filter(Boolean);

  for (const target of candidates) {
    try {
      const res = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        const error = new Error('managed_browser_auth_failed');
        error.code = 'managed_browser_auth_failed';
        throw error;
      }
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.webSocketDebuggerUrl) {
        return json.webSocketDebuggerUrl;
      }
    } catch (error) {
      if (error?.code === 'managed_browser_auth_failed' || error?.message === 'managed_browser_auth_failed') {
        throw error;
      }
      // try next
    }
  }

  return '';
}

async function connectBrowser(testMode = false) {
  const config = getCommenterConfig();
  const wsFileEndpoint = readNaverMonitorWsEndpoint();
  if (wsFileEndpoint) {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsFileEndpoint,
        protocolTimeout: testMode ? 15000 : BROWSER_PROTOCOL_TIMEOUT_MS,
      });
      return { browser, managed: true, mode: 'connect-ws-file' };
    } catch (error) {
      console.warn(`[commenter] naver-monitor ws 연결 실패 — managed browser 상태 조회로 폴백: ${error.message}`);
    }
  }

  const wsEndpoint = await fetchManagedBrowserWsEndpoint(config);
  if (wsEndpoint) {
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      protocolTimeout: testMode ? 15000 : BROWSER_PROTOCOL_TIMEOUT_MS,
    });
    return { browser, managed: true, mode: 'connect' };
  }

  if (env.IS_OPS && config.browserHttpUrl) {
    const error = new Error('managed_browser_required');
    error.code = 'managed_browser_required';
    throw error;
  }

  const browser = await puppeteer.launch({
    headless: false,
    pipe: false,
    defaultViewport: null,
    protocolTimeout: testMode ? 15000 : BROWSER_PROTOCOL_TIMEOUT_MS,
    userDataDir: config.profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=0,25',
      '--window-size=1600,1100',
    ],
  });
  return { browser, managed: false, mode: 'launch' };
}

async function disconnectBrowser(handle) {
  if (!handle?.browser) return;
  if (handle.managed) {
    await handle.browser.disconnect();
    return;
  }
  await handle.browser.close();
}

async function withBrowserPage(testMode, fn, { timeoutMs = 0, timeoutCode = 'browser_page_timeout' } = {}) {
  const handle = await connectBrowser(testMode);
  const page = await handle.browser.newPage();
  await page.evaluateOnNewDocument(() => {
    if (typeof globalThis.__name !== 'function') {
      globalThis.__name = (value) => value;
    }
  }).catch(() => {});
  await page.evaluate(() => {
    if (typeof globalThis.__name !== 'function') {
      globalThis.__name = (value) => value;
    }
  }).catch(() => {});
  page.setDefaultNavigationTimeout(testMode ? 15000 : NAVER_NAVIGATION_TIMEOUT_MS);
  page.setDefaultTimeout(testMode ? 10000 : 30000);
  let cleanedUp = false;
  let timer = null;

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await page.close();
    } catch {
      // ignore
    }
    try {
      await disconnectBrowser(handle);
    } catch {
      // ignore
    }
  }
  try {
    if (timeoutMs > 0) {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(async () => {
          traceCommenter('browserPage:timeout', { timeoutCode, timeoutMs });
          await cleanup();
          reject(createTimeoutError(timeoutCode, `${timeoutCode}:${timeoutMs}`));
        }, timeoutMs);

        Promise.resolve()
          .then(() => fn(page, handle))
          .then(resolve)
          .catch(reject);
      });
    }
    return await fn(page, handle);
  } finally {
    if (timer) clearTimeout(timer);
    await cleanup();
  }
}

async function goto(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVER_NAVIGATION_TIMEOUT_MS,
    });
    return;
  } catch (error) {
    const message = String(error?.message || '');
    const isTimeout = /Navigation timeout/i.test(message);
    if (!isTimeout) throw error;

    const currentUrl = String(page.url() || '');
    const sameTarget =
      currentUrl === url ||
      currentUrl.includes('blog.naver.com') ||
      currentUrl.includes('PostView.naver') ||
      currentUrl.includes('m.blog.naver.com');

    if (sameTarget) {
      await page.waitForFunction(`document.readyState !== 'loading'`, { timeout: 5000 }).catch(() => {});
      return;
    }

    await page.goto(url, {
      waitUntil: 'commit',
      timeout: Math.min(15000, NAVER_NAVIGATION_TIMEOUT_MS),
    });
  }
}

async function extractAdminComments(page, limit = 20, ownBlogId = '') {
  const payload = {
    maxItems: Number(limit || 20),
    ownBlogId: String(ownBlogId || '').trim(),
  };
  const inputJson = JSON.stringify(payload);
  const script = `
    (() => {
      var input = ${inputJson};
      var maxItems = Number(input && input.maxItems ? input.maxItems : 20);
      var ownBlogId = String((input && input.ownBlogId) || '').trim();
      function textOf(el) {
        return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      }
      function pickText(root, selectors) {
        for (var i = 0; i < selectors.length; i += 1) {
          var node = root.querySelector(selectors[i]);
          var text = textOf(node);
          if (text) return text;
        }
        return '';
      }
      function visible(el) {
        if (!el) return false;
        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      var selectors = ['tr', 'li[class*="comment"]', 'div[class*="comment"]', 'li'];
      var roots = [];
      for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
        var selector = selectors[selectorIndex];
        var nodes = document.querySelectorAll(selector);
        for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          var node = nodes[nodeIndex];
          if (!visible(node)) continue;
          var nodeText = textOf(node);
          if (nodeText.length < 10 || nodeText.length > 4000) continue;
          var anchor = node.querySelector('a[href*="blog.naver.com"], a[href*="m.blog.naver.com"], a[href*="PostView.naver"]');
          if (!anchor) continue;
          roots.push(node);
        }
      }
      var deduped = [];
      for (var dedupeIndex = 0; dedupeIndex < roots.length; dedupeIndex += 1) {
        var dedupeNode = roots[dedupeIndex];
        if (deduped.indexOf(dedupeNode) === -1) deduped.push(dedupeNode);
        if (deduped.length >= maxItems * 5) break;
      }
      var results = [];
      for (var rootIndex = 0; rootIndex < deduped.length; rootIndex += 1) {
        var root = deduped[rootIndex];
        var rootText = textOf(root);
        var anchorNodes = root.querySelectorAll('a[href*="blog.naver.com"], a[href*="m.blog.naver.com"], a[href*="PostView.naver"]');
        var postAnchor = null;
        var longestAnchorText = -1;
        for (var anchorIndex = 0; anchorIndex < anchorNodes.length; anchorIndex += 1) {
          var anchorNode = anchorNodes[anchorIndex];
          var anchorText = textOf(anchorNode);
          if (anchorText.length > longestAnchorText) {
            longestAnchorText = anchorText.length;
            postAnchor = anchorNode;
          }
        }
        var postUrl = postAnchor && postAnchor.href ? postAnchor.href : '';
        var postTitle = textOf(postAnchor);
        var commenterName = pickText(root, ['._writerNickname', '.nickname', '.nick', '.name', '.writer', 'strong']);
        var commenterId = pickText(root, ['._writerId', '.blogid']);
        var commentText = pickText(root, ['._replyRealContents', '._replyContents', '.comment_text', '.text', '.desc', 'p', 'span']);
        var commentKeyNode = root.querySelector('input[name="commentKey"]');
        var commentRef = root.getAttribute('data-comment-id')
          || root.getAttribute('data-comment-no')
          || root.getAttribute('data-log-no')
          || (commentKeyNode ? commentKeyNode.value : '')
          || root.id
          || '';
        if (!postUrl || !commentText) continue;
        if (commenterId && ownBlogId && commenterId === ownBlogId) continue;
        if (/^(작성자|내용)$/.test(commenterName) || /^(작성자 내용)$/.test(rootText)) continue;
        if (postTitle && !/\\[글\\]/.test(postTitle) && !/blog\\.naver\\.com|m\\.blog\\.naver\\.com|PostView\\.naver/.test(postUrl)) continue;
        results.push({
          postUrl: postUrl,
          postTitle: postTitle,
          commenterId: root.getAttribute('data-user-id') || root.getAttribute('data-member-id') || commenterId || commenterName || '',
          commenterName: commenterName,
          commentText: commentText,
          commentRef: commentRef,
          meta: {
            source: 'admin-comment',
            snippet: rootText.slice(0, 240),
            currentUrl: location.href
          }
        });
      }
      return results.slice(0, maxItems);
    })()
  `;
  return page.evaluate(script);
}

async function resolveAdminCommentFrame(page, blogId) {
  const directUrl = `https://admin.blog.naver.com/${blogId}/userfilter/commentlist`;
  const fallbackUrl = `https://admin.blog.naver.com/AdminMain.naver?blogId=${blogId}`;

  await goto(page, directUrl);
  await page.waitForSelector('body');

  let frame = page.frames().find((item) => item.name() === 'papermain' || /AdminNaverCommentManageView/.test(item.url()));
  if (frame) {
    await frame.waitForSelector('body', { timeout: 10000 }).catch(() => {});
    return frame;
  }

  await goto(page, fallbackUrl);
  await page.waitForSelector('body');
  await page.evaluate(() => {
    const link = document.querySelector('a[href*="/userfilter/commentlist"]');
    if (link) {
      link.click();
      return true;
    }
    return false;
  }).catch(() => false);

  await humanDelay(1, 2, true);
  frame = page.frames().find((item) => item.name() === 'papermain' || /AdminNaverCommentManageView/.test(item.url()));
  if (frame) {
    await frame.waitForSelector('body', { timeout: 10000 }).catch(() => {});
    return frame;
  }

  throw new Error('comment_admin_frame_not_found');
}

async function detectNewComments({ testMode = false } = {}) {
  const blogId = await resolveBlogId();
  if (!blogId) {
    throw new Error('blogId를 확인할 수 없습니다. bots/blog/config.json commenter.blogId 또는 published naver_url이 필요합니다.');
  }

  const config = getCommenterConfig();
  return withBrowserPage(testMode, async (page) => {
    const frame = await resolveAdminCommentFrame(page, blogId);
    await humanDelay(2, 4, testMode);
    const extracted = await extractAdminComments(frame, Math.min(config.maxDetectPerCycle, testMode ? 3 : config.maxDetectPerCycle), blogId);
    const inserted = [];
    for (const comment of extracted) {
      const saved = await saveDetectedComment(comment);
      if (saved.inserted) {
        inserted.push({ ...comment, id: saved.id });
      }
    }
    return inserted;
  });
}

async function getPostSummary(postUrl, { testMode = false } = {}) {
  return withBrowserPage(testMode, async (page) => {
    await goto(page, resolveNavigablePostUrl(postUrl));
    let contentFrame = await waitForPostContentFrame(page, testMode);
    await humanDelay(1, 2, testMode);
    contentFrame = await waitForPostContentFrame(page, testMode);
    const result = await contentFrame.evaluate(`
      (() => {
        const maxLen = ${JSON.stringify(DEFAULT_SUMMARY_LEN)};
        const metaContent = (selector) => {
          const node = document.querySelector(selector);
          return String((node && node.getAttribute && node.getAttribute('content')) || '').replace(/\\s+/g, ' ').trim();
        };

        const textOf = (selector) => {
          const node = document.querySelector(selector);
          return String((node && (node.innerText || node.textContent)) || '').replace(/\\s+/g, ' ').trim();
        };

        const firstText = (selectors) => {
          for (const selector of selectors) {
            const text = textOf(selector);
            if (text) return text;
          }
          return '';
        };

        const title =
          metaContent('meta[property="og:title"]')
          || firstText(['.se-title-text', '.pcol1 .htitle', '.tit_view', 'h3', 'h1', 'title']);
        const body = [
          '.se-main-container',
          '.se-component-content',
          '#post-view',
          '#postViewArea',
          '.post_ct',
          '.post-view',
          '.contents_style',
          '.view',
          'body',
        ].map((selector) => textOf(selector)).find((text) => text && text.length > 120) || firstText(['body']) || '';

        return {
          title,
          summary: body.length > maxLen ? body.slice(0, maxLen - 1) + '…' : body,
        };
      })()
    `);
    return {
      title: squeezeText(result?.title, 120),
      summary: squeezeText(result?.summary, DEFAULT_SUMMARY_LEN),
    };
  });
}

async function generateReply(postTitle, postSummary, commentText) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const systemPrompt = [
    '너는 IT 블로그 운영자다.',
    '네이버 블로그 댓글에 사람이 직접 쓴 것처럼 자연스럽고 따뜻한 한국어 답글을 JSON으로만 작성한다.',
    '답글은 반드시 2~4문장으로 쓴다.',
    '첫 문장에서는 댓글의 핵심 포인트를 정확히 짚어 공감하거나 반응한다.',
    '둘째 문장 이후에는 글 내용이나 운영 맥락을 반영한 구체적인 한마디를 덧붙인다.',
    '마지막 문장은 너무 상투적인 감사 인사 대신 자연스러운 마무리로 끝낸다.',
  ].join(' ');
  const userPrompt = [
    `[글 제목] ${postTitle || ''}`,
    `[글 요약] ${postSummary || ''}`,
    `[댓글] ${commentText || ''}`,
    '',
    '규칙:',
    '- 70~160자',
    '- 반드시 2~4문장',
    '- 댓글의 구체 표현이나 핵심 의도를 반영',
    '- 블로그 운영자 1인칭 시점 유지',
    '- 기계적인 감사 인사만 반복 금지',
    '- "좋은 하루 되세요", "방문 감사합니다", "공감하고 갑니다" 같은 상투 표현 금지',
    '- 필요하면 이모지 0~1개만 자연스럽게 사용',
    '',
    'JSON만 응답: {"reply":"답글 내용","tone":"질문형|공감형|정보형"}',
  ].join('\n');
  const chain = Array.isArray(selectorOverrides['blog.commenter.reply']?.chain)
    ? selectorOverrides['blog.commenter.reply'].chain
    : buildCommenterFallbackChain(600, 0.75);
  let result = await callWithFallback({
    chain,
    systemPrompt,
    userPrompt,
    logMeta: { team: 'blog', purpose: 'commenter', bot: 'commenter', requestType: 'reply' },
  });
  let reply = normalizeText(result?.text || '');
  let tone = '';
  let parsed = null;
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : JSON.parse(reply);
  } catch {
    parsed = null;
  }
  if (parsed) {
    reply = normalizeText(parsed.reply || reply);
    tone = normalizeText(parsed.tone || '');
  }

  if (!reply || reply.length < 70) {
    result = await callWithFallback({
      chain,
      systemPrompt,
      userPrompt: [
        userPrompt,
        '',
        '추가 지시:',
        '이전 답글이 너무 짧았습니다.',
        '이번에는 반드시 2~4문장으로, 더 구체적으로 써주세요.',
        '댓글 작성자가 언급한 포인트를 한 번 짚고, 글 내용과 연결되는 한 문장을 추가하세요.',
        '반드시 70자 이상 160자 이하로 맞춰주세요.',
        'JSON만 응답하세요.',
      ].join('\n'),
      logMeta: { team: 'blog', purpose: 'commenter', bot: 'commenter', requestType: 'reply_retry' },
    });
    reply = normalizeText(result?.text || reply);
    try {
      const match = reply.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : JSON.parse(reply);
    } catch {
      parsed = null;
    }
    if (parsed) {
      reply = normalizeText(parsed.reply || reply);
      tone = normalizeText(parsed.tone || tone);
    }
  }

  return {
    reply,
    tone,
  };
}

function validateReply(reply, commentText, config = getCommenterConfig()) {
  const normalizedReply = normalizeText(reply);
  const normalizedComment = normalizeText(commentText);

  if (!normalizedReply || normalizedReply.length < config.minReplyLen) {
    return { ok: false, reason: 'too_short' };
  }
  if (normalizedReply.length > config.maxReplyLen) {
    return { ok: false, reason: 'too_long' };
  }
  if (normalizedComment && normalizedReply.includes(normalizedComment.slice(0, Math.min(20, normalizedComment.length)))) {
    return { ok: false, reason: 'copied_comment' };
  }

  const roboticPatterns = ['감사합니다 방문해', '좋은 하루 되세요', '공감하고 갑니다'];
  for (const pattern of roboticPatterns) {
    if (normalizedReply.includes(pattern)) {
      return { ok: false, reason: `robotic:${pattern}` };
    }
  }

  return { ok: true };
}

function assessInboundComment(comment) {
  const text = normalizeText(comment?.comment_text || '');
  const lower = text.toLowerCase();
  if (!text) {
    return { ok: false, reason: 'empty_comment' };
  }

  const hasUrl = /https?:\/\/|www\./i.test(text);
  const promoPatterns = [
    /협찬/i,
    /노출\s*순위/i,
    /유입이?\s*뚫/i,
    /이 방법/i,
    /제 블로그/i,
    /들러주시면/i,
    /방문하시면/i,
    /도움이\s*되실/i,
    /광고/i,
    /홍보/i,
  ];
  if (promoPatterns.some((pattern) => pattern.test(text))) {
    return { ok: true, reason: hasUrl ? 'promotional_comment_reply_allowed_with_url' : 'promotional_comment_reply_allowed' };
  }

  if (hasUrl && !/blog\.naver\.com/i.test(lower)) {
    return { ok: true, reason: 'external_url_comment_reply_allowed' };
  }

  const courtesyPatterns = [
    /좋은\s*포스팅/i,
    /좋은\s*글\s*잘\s*보고\s*갑니다/i,
    /잘\s*읽고\s*갑니다/i,
    /좋은\s*하루\s*되세요/i,
    /행복한\s*(중살|주말|하루|시간)\s*보내세요/i,
    /항상\s*좋은\s*일만/i,
    /행복한\s*시간/i,
    /감사합니다/i,
    /공감하고\s*갑니다/i,
    /응원하고\s*갑니다/i,
    /잘\s*보고\s*갑니다/i,
  ];

  const commenterConfig = getCommenterConfig();
  const courtesyReflectionMinLength = Math.max(
    40,
    Number(commenterConfig.allowCourtesyReflectionMinLength || 55),
  );
  const reflectionPatterns = [
    /느끼/i,
    /생각/i,
    /와닿/i,
    /공감/i,
    /도움/i,
    /배우/i,
    /깨닫/i,
    /습관/i,
    /중요성/i,
    /인상/i,
    /좋더라/i,
    /좋네요/i,
  ];

  const hasQuestionIntent = /[?？]|궁금|어떻게|왜|어디|무엇|뭔가|알려|추천/i.test(text);
  const hasSpecificDiscussion = /차이|비교|방법|설명|후기|리뷰|추천|근거|전략|실행|운영|구조|포인트/i.test(text);
  const hasReflectionSignal = reflectionPatterns.some((pattern) => pattern.test(text));
  const courtesyHits = courtesyPatterns.filter((pattern) => pattern.test(text)).length;

  if (
    !hasQuestionIntent
    && !hasSpecificDiscussion
    && hasReflectionSignal
    && text.length >= courtesyReflectionMinLength
  ) {
    return { ok: true, reason: 'courtesy_reflection_allowed' };
  }

  if (
    !hasQuestionIntent
    && !hasSpecificDiscussion
    && (
      (text.length < 35 && courtesyHits >= 1)
      || courtesyHits >= 2
    )
  ) {
    return { ok: true, reason: 'generic_greeting_reply_allowed' };
  }

  return { ok: true };
}

async function requeuePromotionalReplyCandidates(limit = 10, options = {}) {
  const numericLimit = Math.max(1, Number(limit || 10));
  const dryRun = Boolean(options?.dryRun);
  const rows = await pgPool.query('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE reply_at IS NULL
      AND status = 'skipped'
      AND COALESCE(error_message, '') IN ('promotional_comment', 'promotional_comment_with_url', 'external_url_comment')
      AND detected_at >= now() - interval '30 days'
    ORDER BY detected_at DESC
    LIMIT $1
  `, [Math.max(numericLimit * 4, numericLimit)]);

  const requeued = [];
  for (const row of rows) {
    if (requeued.length >= numericLimit) break;
    const inboundAssessment = assessInboundComment(row);
    if (!inboundAssessment.ok) continue;
    if (![
      'promotional_comment_reply_allowed',
      'promotional_comment_reply_allowed_with_url',
      'external_url_comment_reply_allowed',
    ].includes(String(inboundAssessment.reason || ''))) continue;

    const candidate = {
      id: row.id,
      commenterName: row.commenter_name || '',
      commentText: row.comment_text || '',
      detectedAt: row.detected_at || null,
      previousError: row.error_message || null,
      reassessedReason: inboundAssessment.reason,
    };

    if (!dryRun) {
      await pgPool.run('blog', `
        UPDATE ${TABLE}
        SET status = 'pending',
            error_message = NULL,
            meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
      `, [
        row.id,
        JSON.stringify({
          phase: 'promotional_reply_backfill',
          previous_error: row.error_message || null,
          reassessed_reason: inboundAssessment.reason,
          requeued_at: new Date().toISOString(),
        }),
      ]);
    }

    requeued.push(candidate);
  }

  return {
    dryRun,
    reviewed: Array.isArray(rows) ? rows.length : 0,
    requeuedCount: requeued.length,
    candidates: requeued,
  };
}

function normalizePostUrl(rawUrl) {
  const parsed = parseNaverBlogUrl(rawUrl);
  if (parsed?.ok && parsed.blogId && parsed.logNo) {
    return {
      ok: true,
      blogId: parsed.blogId,
      logNo: parsed.logNo,
      postUrl: `https://blog.naver.com/${parsed.blogId}/${parsed.logNo}`,
      viewUrl: `https://blog.naver.com/PostView.naver?blogId=${parsed.blogId}&logNo=${parsed.logNo}&redirect=Dlog&widgetTypeCall=true&directAccess=false`,
    };
  }

  const match = String(rawUrl || '').match(/blog\.naver\.com\/([^/?#]+)\/(\d{8,})/i);
  if (match) {
    return {
      ok: true,
      blogId: match[1],
      logNo: match[2],
      postUrl: `https://blog.naver.com/${match[1]}/${match[2]}`,
      viewUrl: `https://blog.naver.com/PostView.naver?blogId=${match[1]}&logNo=${match[2]}&redirect=Dlog&widgetTypeCall=true&directAccess=false`,
    };
  }

  return { ok: false, blogId: '', logNo: '', postUrl: '', viewUrl: '' };
}

function resolveNavigablePostUrl(rawUrl) {
  const normalized = normalizePostUrl(rawUrl);
  if (normalized?.ok && normalized.viewUrl) {
    return normalized.viewUrl;
  }
  return String(rawUrl || '').trim();
}

function parseCommentRef(commentRef) {
  const raw = String(commentRef || '').trim();
  if (!raw) return { raw: '', commentNo: '', commenterId: '', logNo: '' };
  const parts = raw.split('|').map((part) => String(part || '').trim());
  return {
    raw,
    logNo: parts[0] || '',
    commenterId: parts[1] || '',
    commentNo: parts[2] || '',
  };
}

async function getCommenterNetworkCandidates(limit = 10, ownBlogId = '') {
  return pgPool.query('blog', `
    SELECT DISTINCT ON (commenter_id)
      commenter_id,
      commenter_name,
      MAX(detected_at) OVER (PARTITION BY commenter_id) AS last_seen_at
    FROM ${TABLE}
    WHERE commenter_id IS NOT NULL
      AND commenter_id <> ''
      AND commenter_id <> $1
    ORDER BY commenter_id, detected_at DESC
    LIMIT $2
  `, [ownBlogId || '', limit]);
}

async function extractBuddyFeedPosts(page, ownBlogId, limit = 10) {
  const feedUrl = `https://section.blog.naver.com/connect/ViewMoreBuddyPosts.naver?blogId=${encodeURIComponent(ownBlogId)}&widgetSeq=1`;
  await goto(page, feedUrl);
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await humanDelay(1, 2, true);

  const extracted = await page.evaluate(`
    (() => {
      const maxItems = ${JSON.stringify(Math.max(1, limit))};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const uniquePush = (store, item) => {
        if (!item || !item.href) return;
        if (store.seen.has(item.href)) return;
        store.seen.add(item.href);
        store.items.push(item);
      };

      const store = { seen: new Set(), items: [] };
      const cards = Array.from(document.querySelectorAll('li.add_img, li[class*="list"], ul li')).slice(0, maxItems * 8);

      for (const card of cards) {
        const postAnchor = Array.from(card.querySelectorAll('a[href*="blog.naver.com"], a[href*="PostView.naver"], a[href*="m.blog.naver.com"]')).find((anchor) => {
          const href = String(anchor.href || '');
          return /blog\\.naver\\.com\\/[^/?#]+\\/\\d{8,}|logNo=\\d{8,}/i.test(href);
        });
        if (!postAnchor) continue;

        const blogAnchor = Array.from(card.querySelectorAll('a[href*="blog.naver.com"]')).find((anchor) => {
          const href = String(anchor.href || '');
          return /blog\\.naver\\.com\\/[^/?#]+\\/?$/i.test(href);
        });

        const title =
          textOf(postAnchor)
          || textOf(card.querySelector('.title'))
          || textOf(card.querySelector('.tit'))
          || textOf(card.querySelector('.template_briefContents')).slice(0, 80);

        const blogName =
          textOf(blogAnchor)
          || textOf(card.querySelector('.list_data a'))
          || textOf(card.querySelector('.name'))
          || '';

        const snippet =
          textOf(card.querySelector('.list_content'))
          || textOf(card.querySelector('.template_briefContents'))
          || textOf(card).slice(0, 240);

        uniquePush(store, {
          href: String(postAnchor.href || '').trim(),
          title,
          blogName,
          snippet,
        });

        if (store.items.length >= maxItems * 4) break;
      }

      return store.items;
    })()
  `);

  return extracted
    .map((item) => {
      const normalized = normalizePostUrl(item.href);
      return {
        ok: normalized.ok,
        targetBlogId: normalized.blogId,
        postUrl: normalized.postUrl,
        postTitle: squeezeText(item.title, 140),
        targetBlogName: squeezeText(item.blogName, 80),
        meta: { snippet: item.snippet || '', rawHref: item.href },
      };
    })
    .filter((item) => item.ok && item.targetBlogId && item.postUrl && item.targetBlogId !== ownBlogId)
    .slice(0, limit);
}

async function resolveLatestPostForBlog(page, blogId, testMode = false) {
  await goto(page, `https://blog.naver.com/${blogId}`);
  let frame = await waitForPostContentFrame(page, testMode);
  await frame.waitForSelector('a', { timeout: testMode ? 5000 : 15000 }).catch(() => {});
  await humanDelay(1, 2, true);
  frame = await waitForPostContentFrame(page, testMode);

  const candidate = await frame.evaluate(`
    (() => {
      const targetBlogId = ${JSON.stringify(blogId)};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();

      const anchors = Array.from(document.querySelectorAll('a[href*="blog.naver.com"], a[href*="PostView.naver"], a[href*="m.blog.naver.com"]'));
      for (const anchor of anchors) {
        const href = String(anchor.href || '').trim();
        const text = textOf(anchor);
        if (!href) continue;
        if (!new RegExp('blogId=' + targetBlogId + '|blog\\\\.naver\\\\.com/' + targetBlogId + '/', 'i').test(href)) continue;
        if (!/\\d{8,}/.test(href)) continue;
        if (!text || text.length < 4) continue;
        return { href, title: text };
      }
      return null;
    })()
  `);

  if (!candidate?.href) return null;
  const normalized = normalizePostUrl(candidate.href);
  if (!normalized.ok) return null;
  return {
    targetBlogId: normalized.blogId,
    postUrl: normalized.postUrl,
    postTitle: squeezeText(candidate.title, 140),
  };
}

async function collectNeighborCandidates({ testMode = false, persist = true, collectLimit = 0 } = {}) {
  const ownBlogId = await resolveBlogId();
  if (!ownBlogId) {
    throw new Error('neighbor_commenter_blog_id_required');
  }

  const config = getNeighborCommenterConfig();
  const effectiveCollectLimit = Math.max(1, Number(collectLimit || config.maxCollectPerCycle || 20));
  const recentUrls = await getRecentlyTargetedPostUrls(config.recentWindowDays);
  const recentBlogIds = await getRecentNeighborBlogIds(config.recentWindowDays);
  const collected = [];
  const seenUrls = new Set(recentUrls);

  const commenterNetwork = await getCommenterNetworkCandidates(effectiveCollectLimit, ownBlogId);

  await withBrowserPage(testMode, async (page) => {
    const buddyFeed = await extractBuddyFeedPosts(page, ownBlogId, effectiveCollectLimit);
    for (const item of buddyFeed) {
      if (seenUrls.has(item.postUrl) || recentBlogIds.has(item.targetBlogId)) continue;
      collected.push({
        targetBlogId: item.targetBlogId,
        targetBlogName: item.targetBlogName,
        sourceType: 'buddy_feed',
        sourceRef: 'ViewMoreBuddyPosts',
        postUrl: item.postUrl,
        postTitle: item.postTitle,
        meta: item.meta,
      });
      seenUrls.add(item.postUrl);
      if (collected.length >= effectiveCollectLimit) return;
    }

    for (const row of commenterNetwork) {
      const targetBlogId = String(row.commenter_id || '').trim();
      if (!targetBlogId || recentBlogIds.has(targetBlogId)) continue;
      const latest = await resolveLatestPostForBlog(page, targetBlogId, testMode).catch(() => null);
      if (!latest?.postUrl || seenUrls.has(latest.postUrl)) continue;
      collected.push({
        targetBlogId,
        targetBlogName: squeezeText(row.commenter_name || '', 80),
        sourceType: 'commenter_network',
        sourceRef: 'blog.comments',
        postUrl: latest.postUrl,
        postTitle: latest.postTitle,
        meta: { lastSeenAt: row.last_seen_at || null },
      });
      seenUrls.add(latest.postUrl);
      if (collected.length >= effectiveCollectLimit) return;
    }
  });

  if (!persist) {
    return collected;
  }

  const inserted = [];
  for (const candidate of collected) {
    const saved = await saveNeighborCandidate(candidate);
    if (saved.inserted) inserted.push({ ...candidate, id: saved.id });
  }
  return inserted;
}

async function generateNeighborComment(postTitle, postSummary, candidate, extraGuidance = '') {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const chain = Array.isArray(selectorOverrides['blog.commenter.neighbor']?.chain)
    ? selectorOverrides['blog.commenter.neighbor'].chain
    : buildCommenterFallbackChain(700, 0.8);
  const isNonNeighborVisit = String(candidate?.source_type || '') === 'commenter_network';

  const systemPrompt = [
    '너는 네이버 블로그 운영자다.',
    '다른 블로그의 최신 글에 남길 한국어 댓글을 JSON으로만 작성한다.',
    '친근하지만 과장하지 않고, 광고/영업처럼 보이면 안 된다.',
    '본문의 구체 포인트를 1개 이상 언급해야 한다.',
    '서로이웃처럼 따뜻하고 자연스러운 톤을 유지한다.',
    '기본 원칙은 비질문형 댓글이다. 특별한 이유가 없으면 물음표를 쓰지 않는다.',
    isNonNeighborVisit
      ? '이웃이 아닌 블로그에 처음 방문한 상황이므로 첫 문장은 가벼운 방문 인사로 시작하되, 바로 본문 이야기로 자연스럽게 넘어간다.'
      : '이미 이웃 새글을 보고 온 흐름처럼 자연스럽게 본문 이야기부터 시작한다.',
  ].join(' ');
  const userPrompt = [
    `[대상 블로그] ${candidate.targetBlogName || candidate.targetBlogId || ''}`,
    `[포스트 제목] ${postTitle || candidate.postTitle || ''}`,
    `[포스트 요약] ${postSummary || ''}`,
    `[유입 경로] ${candidate.sourceType === 'buddy_feed' ? '이웃 새글' : '우리 글 댓글 작성자'} `,
    `[방문 성격] ${isNonNeighborVisit ? '비이웃 첫 방문' : '이웃 새글 방문'}`,
    '',
    '규칙:',
    '- 2~4문장',
    '- 55~180자',
    '- 글 내용의 구체 포인트를 짚기',
    '- "소통해요", "자주 들를게요", "잘 보고 갑니다" 같은 상투 표현 금지',
    '- 질문형 문장 금지',
    '- 홍보/링크 유도/구매 유도 금지',
    isNonNeighborVisit
      ? '- 첫 문장은 "처음 들렀는데" 또는 "방문해보니"처럼 가벼운 방문 인사를 담되, 과하게 친한 척하지 않기'
      : '- 첫 문장부터 본문 포인트로 바로 들어가기',
    extraGuidance ? `- 추가 지시: ${extraGuidance}` : '',
    '',
    'JSON만 응답: {"comment":"댓글 내용","tone":"친근형|공감형|관찰형"}',
  ].filter(Boolean).join('\n');

  const result = await callWithFallback({
    chain,
    systemPrompt,
    userPrompt,
    logMeta: { team: 'blog', purpose: 'neighbor-commenter', bot: 'neighbor-commenter', requestType: 'comment' },
  });

  let text = normalizeText(result?.text || '');
  let parsed = null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    comment: normalizeText(parsed?.comment || text),
    tone: normalizeText(parsed?.tone || ''),
  };
}

function buildNeighborSpecificityGuidance(postTitle, postSummary) {
  const source = [String(postTitle || ''), String(postSummary || '')].filter(Boolean).join(' ');
  const tokens = source
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token, index, list) => list.indexOf(token) === index)
    .slice(0, 6);
  if (!tokens.length) {
    return '글에서 인상적인 장면이나 표현을 한 번은 직접 짚어 주세요.';
  }
  return `다음 표현 중 최소 1개를 자연스럽게 반영해 주세요: ${tokens.join(', ')}`;
}

function validateNeighborComment(comment, summary, config = getNeighborCommenterConfig()) {
  const normalized = normalizeText(comment);
  if (!normalized || normalized.length < config.minCommentLen) {
    return { ok: false, reason: 'too_short' };
  }
  if (normalized.length > config.maxCommentLen) {
    return { ok: false, reason: 'too_long' };
  }
  if (/소통해요|잘 보고 갑니다|자주 들를게요|좋은 글 감사합니다/.test(normalized)) {
    return { ok: false, reason: 'too_generic' };
  }
  if (/[?？]|궁금하|알고 싶|혹시/.test(normalized)) {
    return { ok: false, reason: 'question_style' };
  }
  const summaryTokens = String(summary || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
  if (summaryTokens.length > 0 && !summaryTokens.some((token) => normalized.includes(token))) {
    return { ok: false, reason: 'missing_specific_point' };
  }
  return { ok: true };
}

function validateNeighborCommentWithCandidate(comment, summary, candidate, config = getNeighborCommenterConfig()) {
  const base = validateNeighborComment(comment, summary, config);
  if (!base.ok) return base;

  const normalized = normalizeText(comment);
  const isNonNeighborVisit = String(candidate?.source_type || '') === 'commenter_network';
  if (isNonNeighborVisit && !/처음 들렀|방문해보니|처음 방문했는데|들렀는데/.test(normalized)) {
    return { ok: false, reason: 'missing_first_visit_greeting' };
  }

  return { ok: true };
}

async function openReplyEditor(page, comment) {
  const parsedCommentRef = parseCommentRef(comment?.comment_ref);
  const payload = JSON.stringify({
    commentText: comment.comment_text,
    commenterName: comment.commenter_name,
    commenterId: comment.commenter_id || parsedCommentRef.commenterId || '',
    commentNo: parsedCommentRef.commentNo || '',
  });
  return page.evaluate(`
    (() => {
      const { commentText, commenterName, commenterId, commentNo } = ${payload};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const resolveReplyArea = (commentNode) => {
        if (!commentNode) return null;
        const sibling = commentNode.nextElementSibling;
        return (
          commentNode.querySelector('.u_cbox_reply_area')
          || commentNode.querySelector('[class*="reply_area"]')
          || (sibling && sibling.matches && sibling.matches('.u_cbox_reply_area, [class*="reply_area"]') ? sibling : null)
        );
      };
      const resolveCommentTarget = (node) => {
        if (!node) return null;
        return (
          node.closest('li.u_cbox_comment')
          || node.closest('li[class*="comment"]')
          || node.closest('div.u_cbox_comment_box')
          || node.closest('[class*="comment"]')
          || null
        );
      };

      if (commentNo) {
        const targetedButton = Array.from(document.querySelectorAll('button, a')).find((node) => {
          if (!visible(node)) return false;
          const cls = String(node.className || '');
          const dataAction = String(node.getAttribute('data-action') || '');
          const dataParam = String(node.getAttribute('data-param') || '');
          const text = textOf(node);
          const isReplyToggle =
            /reply#toggle/.test(dataAction)
            || /u_cbox_btn_reply|replyButton|btn_reply/i.test(cls)
            || /답글|답변/.test(text);
          const matchesCommentNo =
            cls.includes('idx-commentNo-' + commentNo)
            || dataParam === commentNo;
          return isReplyToggle && matchesCommentNo;
        });
        if (targetedButton) {
          document.querySelectorAll('[data-blog-target-comment],[data-blog-target-reply-button],[data-blog-target-reply-area]').forEach((node) => {
            node.removeAttribute('data-blog-target-comment');
            node.removeAttribute('data-blog-target-reply-button');
            node.removeAttribute('data-blog-target-reply-area');
          });
          const fallbackTarget = resolveCommentTarget(targetedButton);
          if (fallbackTarget) {
            fallbackTarget.setAttribute('data-blog-target-comment', 'true');
            if (commentNo) fallbackTarget.setAttribute('data-blog-target-comment-no', commentNo);
          }
          targetedButton.setAttribute('data-blog-target-reply-button', 'true');
          const replyArea = resolveReplyArea(fallbackTarget);
          if (replyArea) {
            replyArea.setAttribute('data-blog-target-reply-area', 'true');
          }
          return true;
        }
      }

      const selectors = ['li.u_cbox_comment', 'li[class*="comment"]', 'div[class*="comment"]', 'article', 'section'];
      const candidates = [];
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          if (!visible(node)) continue;
          const text = textOf(node);
          if (!text) continue;
          let score = 0;
          if (commentText && text.includes(commentText.slice(0, Math.min(20, commentText.length)))) score += 3;
          if (commenterName && text.includes(commenterName)) score += 2;
          if (commenterId && text.includes(commenterId)) score += 1;
          if (score > 0) candidates.push({ node, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const matchedNode = candidates[0] && candidates[0].node;
      const target = matchedNode && (resolveCommentTarget(matchedNode) || matchedNode);
      if (target) {
        document.querySelectorAll('[data-blog-target-comment],[data-blog-target-reply-button],[data-blog-target-reply-area]').forEach((node) => {
          node.removeAttribute('data-blog-target-comment');
          node.removeAttribute('data-blog-target-reply-button');
          node.removeAttribute('data-blog-target-reply-area');
        });
        target.setAttribute('data-blog-target-comment', 'true');
        if (commentNo) target.setAttribute('data-blog-target-comment-no', commentNo);
        const buttons = Array.from(target.querySelectorAll('button, a, input[type="submit"], [role="button"]')).filter(visible);
        const replyButton = buttons.find((btn) => {
          const text = textOf(btn);
          const cls = String(btn.className || '');
          const dataAction = String(btn.getAttribute('data-action') || '');
          return /답글|답변/.test(text) || /btn_reply|reply/i.test(cls) || /reply#toggle/.test(dataAction);
        });
        if (replyButton) {
          replyButton.setAttribute('data-blog-target-reply-button', 'true');
          const replyArea = resolveReplyArea(target);
          if (replyArea) {
            replyArea.setAttribute('data-blog-target-reply-area', 'true');
          }
          return true;
        }
      }

      const globalReplyButtons = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
        .filter(visible)
        .filter((btn) => {
          const text = textOf(btn);
          const cls = String(btn.className || '');
          const dataAction = String(btn.getAttribute('data-action') || '');
          return (/답글|답변/.test(text) || /btn_reply|reply/i.test(cls) || /reply#toggle/.test(dataAction)) && !/widget_recent_reply/i.test(cls);
        });
      if (!commentNo && globalReplyButtons.length === 1) {
        const replyButton = globalReplyButtons[0];
        const fallbackTarget = resolveCommentTarget(replyButton);
        const fallbackText = textOf(fallbackTarget);
        const looksRelated =
          (commentText && fallbackText.includes(commentText.slice(0, Math.min(20, commentText.length))))
          || (commenterName && fallbackText.includes(commenterName))
          || (commenterId && fallbackText.includes(commenterId));
        if (!looksRelated) {
          return false;
        }
        document.querySelectorAll('[data-blog-target-comment],[data-blog-target-reply-button],[data-blog-target-reply-area]').forEach((node) => {
          node.removeAttribute('data-blog-target-comment');
          node.removeAttribute('data-blog-target-reply-button');
          node.removeAttribute('data-blog-target-reply-area');
        });
        if (fallbackTarget) {
          fallbackTarget.setAttribute('data-blog-target-comment', 'true');
          if (commentNo) fallbackTarget.setAttribute('data-blog-target-comment-no', commentNo);
        }
        replyButton.setAttribute('data-blog-target-reply-button', 'true');
        const replyArea = resolveReplyArea(fallbackTarget);
        if (replyArea) {
          replyArea.setAttribute('data-blog-target-reply-area', 'true');
        }
        return true;
      }
      return false;
    })()
  `);
}

async function waitForReplyThread(page, comment, testMode = false) {
  const timeoutMs = testMode ? 12000 : 15000;
  const commentSnippet = String(comment?.comment_text || '').slice(0, 20);
  const commenterName = String(comment?.commenter_name || '').trim();
  const payload = JSON.stringify({ snippet: commentSnippet, name: commenterName });
  const predicate = `
    (() => {
      const { snippet, name } = ${payload};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const replyButtons = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
        .filter(visible)
        .filter((btn) => {
          const text = textOf(btn);
          const cls = String(btn.className || '');
          const dataAction = String(btn.getAttribute('data-action') || '');
          return (/답글|답변/.test(text) || /btn_reply|reply/i.test(cls) || /reply#toggle/.test(dataAction)) && !/widget_recent_reply/i.test(cls);
        });
      if (replyButtons.length > 0) return true;

      const comments = Array.from(document.querySelectorAll('li.u_cbox_comment, li[class*="comment"], .u_cbox_comment_box, [class*="comment"]'))
        .filter(visible);
      return comments.some((node) => {
        const text = textOf(node);
        return (snippet && text.includes(snippet)) || (name && text.includes(name));
      });
    })()
  `;
  return page.waitForFunction(predicate, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function activateReplyMode(page) {
  const targetMeta = await inspectTargetReplyButtonLite(page).catch(() => null);
  const nativeTarget = await page.$('[data-blog-target-reply-button="true"]');
  if (nativeTarget) {
    await nativeTarget.evaluate((node) => {
      if (node && node.scrollIntoView) {
        node.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    }).catch(() => {});
    await nativeTarget.click({ force: true }).catch(() => {});
    await sleep(120);
    if (await isReplyModeOpen(page)) return true;
  }
  const clicked = await page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const isReplyOpen = () => {
        const targetComment = document.querySelector('[data-blog-target-comment="true"]');
        const replyArea = document.querySelector('[data-blog-target-reply-area="true"]');
        const hasVisibleEditor = (root) => {
          if (!root) return false;
          const replyEditors = Array.from(root.querySelectorAll([
            'textarea',
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'div[id*="write_textarea"]',
            '.u_cbox_text.u_cbox_text_mention',
          ].join(', ')));
          return replyEditors.some(visible);
        };
        if (visible(replyArea) && hasVisibleEditor(replyArea)) return true;
        const stateOnButton = document.querySelector('[data-blog-target-comment="true"] .u_cbox_btn_reply_on[data-blog-target-reply-button="true"], [data-blog-target-comment="true"] .u_cbox_btn_reply_on');
        if (visible(stateOnButton)) {
          const scopedReplyArea = targetComment && (
            targetComment.querySelector('.u_cbox_reply_area')
            || targetComment.querySelector('[class*="reply_area"]')
          );
          if (visible(scopedReplyArea) && hasVisibleEditor(scopedReplyArea)) return true;
        }
        return false;
      };
      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const targetCommentNo = String(targetComment?.getAttribute('data-blog-target-comment-no') || '');
      const targetButton = targetComment
        ? Array.from(targetComment.querySelectorAll('a,button')).find((node) => {
            if (!visible(node)) return false;
            const cls = String(node.className || '');
            const dataAction = String(node.getAttribute('data-action') || '');
            const dataParam = String(node.getAttribute('data-param') || '');
            const text = textOf(node);
            if (!(/reply#toggle/.test(dataAction) || /u_cbox_btn_reply|replyButton|btn_reply/i.test(cls) || /답글|답변/.test(text))) return false;
            return !targetCommentNo || cls.includes('idx-commentNo-' + targetCommentNo) || dataParam === targetCommentNo;
          })
        : document.querySelector('[data-blog-target-reply-button="true"]');
      const node = targetButton;
      if (!node) return false;
      document.querySelectorAll('[data-blog-target-reply-button="true"]').forEach((item) => item.removeAttribute('data-blog-target-reply-button'));
      node.setAttribute('data-blog-target-reply-button', 'true');
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      const attemptClick = () => {
        node.focus && node.focus();
        node.dispatchEvent(new MouseEvent('pointerdown', eventInit));
        node.dispatchEvent(new MouseEvent('mousedown', eventInit));
        node.dispatchEvent(new MouseEvent('pointerup', eventInit));
        node.dispatchEvent(new MouseEvent('mouseup', eventInit));
        node.dispatchEvent(new MouseEvent('click', eventInit));
        if (typeof node.click === 'function') {
          try { node.click(); } catch {}
        }
      };
      attemptClick();
      return isReplyOpen() || String(node.getAttribute('aria-expanded') || '').trim().toLowerCase() === 'true';
    })()
  `).catch(() => false);

  if (!clicked) return false;

  await sleep(120);
  if (await isReplyModeOpen(page)) return true;

  if (nativeTarget && (targetMeta?.tagName === 'a' || targetMeta?.role === 'button')) {
    await nativeTarget.focus().catch(() => {});
    await nativeTarget.press('Enter').catch(() => {});
    await sleep(120);
    if (await isReplyModeOpen(page)) return true;
    await nativeTarget.press('Space').catch(() => {});
    await sleep(120);
    if (await isReplyModeOpen(page)) return true;
  }

  return page.waitForFunction(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const hasVisibleEditor = (root) => {
        if (!root) return false;
        const replyEditors = Array.from(root.querySelectorAll([
          'textarea',
          'div[contenteditable="true"]',
          'div[role="textbox"]',
          'div[id*="write_textarea"]',
          '.u_cbox_text.u_cbox_text_mention',
        ].join(', ')));
        return replyEditors.some(visible);
      };

      const replyArea = document.querySelector('[data-blog-target-reply-area="true"]');
      if (visible(replyArea) && hasVisibleEditor(replyArea)) {
        return true;
      }
      const stateOnButton = document.querySelector('[data-blog-target-comment=\"true\"] .u_cbox_btn_reply_on[data-blog-target-reply-button=\"true\"], [data-blog-target-comment=\"true\"] .u_cbox_btn_reply_on');
      if (visible(stateOnButton)) {
        const targetComment = document.querySelector('[data-blog-target-comment=\"true\"]');
        const scopedReplyArea = targetComment && (
          targetComment.querySelector('.u_cbox_reply_area')
          || targetComment.querySelector('[class*="reply_area"]')
        );
        if (visible(scopedReplyArea) && hasVisibleEditor(scopedReplyArea)) {
          return true;
        }
      }
      const targetReplyButton = document.querySelector('[data-blog-target-reply-button="true"]');
      const ariaExpanded = String(targetReplyButton?.getAttribute('aria-expanded') || '').trim().toLowerCase();
      return ariaExpanded === 'true' && visible(stateOnButton);
    })()
  `, { timeout: 8000 }).then(() => true).catch(() => false);
}

async function inspectActivateReplyModeLite(page) {
  return page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const targetReplyButton = document.querySelector('[data-blog-target-reply-button="true"]');
      const replyArea = document.querySelector('[data-blog-target-reply-area="true"]')
        || targetComment?.querySelector('.u_cbox_reply_area')
        || targetComment?.querySelector('[class*="reply_area"]')
        || null;
      const globalWriteWrap = document.querySelector('.u_cbox_write_wrap')
        || document.querySelector('.u_cbox_write')
        || document.querySelector('.u_cbox_write_area');
      const replyEditors = Array.from((replyArea || document).querySelectorAll([
        'textarea',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        'div[id*="write_textarea"]',
        '.u_cbox_text.u_cbox_text_mention',
      ].join(', '))).filter(visible);
      const globalEditors = Array.from((globalWriteWrap || document).querySelectorAll([
        'textarea',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        'div[id*="write_textarea"]',
        '.u_cbox_text.u_cbox_text_mention',
      ].join(', '))).filter(visible);
      return {
        targetReplyButtonFound: Boolean(targetReplyButton),
        targetReplyButtonExpanded: String(targetReplyButton?.getAttribute('aria-expanded') || '').trim().toLowerCase(),
        targetReplyButtonClassName: String(targetReplyButton?.className || '').slice(0, 120),
        replyAreaVisible: visible(replyArea),
        replyEditorCount: replyEditors.length,
        replyEditorIds: replyEditors.slice(0, 4).map((node) => String(node.id || '')),
        globalWriteVisible: visible(globalWriteWrap),
        globalEditorCount: globalEditors.length,
        globalEditorIds: globalEditors.slice(0, 4).map((node) => String(node.id || '')),
      };
    })()
  `).catch(() => ({
    targetReplyButtonFound: false,
    targetReplyButtonExpanded: '',
    targetReplyButtonClassName: '',
    replyAreaVisible: false,
    replyEditorCount: 0,
    replyEditorIds: [],
    globalWriteVisible: false,
    globalEditorCount: 0,
    globalEditorIds: [],
  }));
}

function isReplyModeStateReady(state) {
  return Boolean(
    state
    && state.replyAreaVisible
    && Number(state.replyEditorCount || 0) > 0
  );
}

async function inspectTargetReplyButtonLite(page) {
  return page.evaluate(`
    (() => {
      const node = document.querySelector('[data-blog-target-reply-button="true"]');
      if (!node) return null;
      return {
        tagName: String(node.tagName || '').toLowerCase(),
        text: String((node.innerText || node.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        id: String(node.id || ''),
        role: String(node.getAttribute('role') || ''),
        href: String(node.getAttribute('href') || ''),
        className: String(node.className || '').slice(0, 160),
        dataAction: String(node.getAttribute('data-action') || ''),
        dataParam: String(node.getAttribute('data-param') || ''),
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
        ariaExpanded: String(node.getAttribute('aria-expanded') || '').trim().toLowerCase(),
        parentClassName: String(node.parentElement?.className || '').slice(0, 160),
      };
    })()
  `).catch(() => null);
}

async function waitForReplySubmitReady(page, testMode = false, customTimeoutMs = 0) {
  const timeoutMs = Number(customTimeoutMs || 0) > 0
    ? Number(customTimeoutMs)
    : (testMode ? 8000 : 15000);
  return page.waitForFunction(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const isReplySubmit = (node) => {
        if (!visible(node)) return false;
        const dataAction = String(node.getAttribute('data-action') || '');
        const uiSelector = String(node.getAttribute('data-ui-selector') || '');
        const cls = String(node.className || '');
        const inputType = String(node.getAttribute('type') || '').toLowerCase();
        const text = textOf(node).replace(/\\s+/g, '');
        if (dataAction.includes('write#request')) return true;
        if (uiSelector === 'writeButton' || /^writeButton_/i.test(uiSelector)) return true;
        if (/u_cbox_btn_upload|btn_register|btn_write/i.test(cls)) return true;
        if (inputType === 'submit') return true;
        return /등록|완료|게시/.test(text);
      };
      const roots = [
        document.querySelector('[data-blog-target-reply-area="true"]'),
        document.querySelector('[data-blog-commenter-editor="true"]')?.closest('.u_cbox_write_box, .u_cbox_reply_write, .u_cbox_reply_area, .u_cbox_comment_box'),
        document.querySelector('[data-blog-commenter-editor="true"]')?.closest('form'),
      ].filter(Boolean);
      return roots.some((root) =>
        Array.from(root.querySelectorAll('button, a, input[type="submit"], [role="button"]')).some(isReplySubmit),
      );
    })()
  `, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function inspectReplySubmitLite(page, { fast = false } = {}) {
  return page.evaluate(`
    (() => {
      const fastMode = ${JSON.stringify(Boolean(fast))};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const targetReplyArea = document.querySelector('[data-blog-target-reply-area="true"]');
      const targetEditor = document.querySelector('[data-blog-commenter-editor="true"]');
      const replyFormRoot =
        targetEditor && targetEditor.closest('form')
        || targetEditor && targetEditor.closest('.u_cbox_write_box')
        || targetEditor && targetEditor.closest('.u_cbox_write_wrap')
        || targetReplyArea && targetReplyArea.querySelector('form')
        || targetReplyArea && targetReplyArea.querySelector('.u_cbox_write_box')
        || targetReplyArea && targetReplyArea.querySelector('.u_cbox_write_wrap')
        || null;
      const localEditorRoot =
        targetEditor && targetEditor.closest('.u_cbox_write_box, .u_cbox_reply_write, .u_cbox_reply_area, .u_cbox_comment_box')
        || null;

      const isReplySubmit = (node) => {
        if (!visible(node)) return false;
        const dataAction = String(node.getAttribute('data-action') || '');
        const uiSelector = String(node.getAttribute('data-ui-selector') || '');
        const cls = String(node.className || '');
        const inputType = String(node.getAttribute('type') || '').toLowerCase();
        const text = textOf(node).replace(/\\s+/g, '');
        if (dataAction.includes('write#request')) return true;
        if (uiSelector === 'writeButton' || /^writeButton_/i.test(uiSelector)) return true;
        if (/u_cbox_btn_upload|btn_register|btn_write/i.test(cls)) return true;
        if (inputType === 'submit') return true;
        return /등록|완료|게시/.test(text);
      };

      const roots = fastMode
        ? [replyFormRoot, localEditorRoot, targetReplyArea].filter(Boolean)
        : [replyFormRoot, localEditorRoot, targetReplyArea, document].filter(Boolean);
      const uniqueRoots = roots.filter((root, index) => roots.indexOf(root) === index);
      const submitCandidates = uniqueRoots.flatMap((root) =>
        Array.from(root.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
      )
        .filter(isReplySubmit)
        .slice(0, 5)
        .map((node) => ({
          text: textOf(node).slice(0, 40),
          id: String(node.id || ''),
          className: String(node.className || '').slice(0, 120),
          dataAction: String(node.getAttribute('data-action') || ''),
          uiSelector: String(node.getAttribute('data-ui-selector') || ''),
        }));

      return {
        fastMode,
        targetReplyAreaVisible: visible(targetReplyArea),
        replyFormRootFound: Boolean(replyFormRoot),
        localEditorRootFound: Boolean(localEditorRoot),
        editor: targetEditor ? {
          id: String(targetEditor.id || ''),
          className: String(targetEditor.className || '').slice(0, 120),
          title: String(targetEditor.getAttribute('title') || ''),
          dataAreaCode: String(targetEditor.getAttribute('data-area-code') || ''),
          visible: visible(targetEditor),
        } : null,
        submitCandidates,
      };
    })()
  `).catch(() => ({
    fastMode: Boolean(fast),
    targetReplyAreaVisible: false,
    replyFormRootFound: false,
    localEditorRootFound: false,
    editor: null,
    submitCandidates: [],
  }));
}

async function expandReplyThreads(page) {
  return page.evaluate(`
    (() => {
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(document.querySelectorAll('a, button'))
        .filter(visible)
        .filter((node) => {
          const text = textOf(node);
          const cls = String(node.className || '');
          return /댓글\\s*\\d+|댓글 더보기|이전 댓글|더보기/.test(text)
            || /u_cbox_btn_more|btn_more|comment_more/i.test(cls);
        })
        .slice(0, 8);

      let clicked = 0;
      for (const node of candidates) {
        try {
          node.scrollIntoView({ block: 'center', behavior: 'instant' });
          node.click();
          clicked += 1;
        } catch {
          // ignore
        }
      }
      return clicked;
    })()
  `).catch(() => 0);
}

async function openCommentPanel(page, logNo = '', testMode = false) {
  const payload = JSON.stringify({ currentLogNo: logNo });
  const result = await page.evaluate(`
    (() => {
      const { currentLogNo } = ${payload};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const clickNode = (node) => {
        if (!node) return false;
        node.scrollIntoView({ block: 'center', behavior: 'instant' });
        try { node.click(); } catch {}
        const rect = node.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        node.dispatchEvent(new MouseEvent('pointerdown', eventInit));
        node.dispatchEvent(new MouseEvent('mousedown', eventInit));
        node.dispatchEvent(new MouseEvent('pointerup', eventInit));
        node.dispatchEvent(new MouseEvent('mouseup', eventInit));
        node.dispatchEvent(new MouseEvent('click', eventInit));
        return true;
      };

      const root = currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '_ct') : null;
      if (root) {
        root.style.display = 'block';
        root.style.visibility = 'visible';
      }

      const exactToggle =
        (currentLogNo && document.querySelector('#Comi' + currentLogNo))
        || document.querySelector('#btn_comment_2');
      if (exactToggle) {
        clickNode(exactToggle);
      }

      const writeButton = document.querySelector('.commentbox_header .btn_write_comment._naverCommentWriteBtn, .commentbox_header .btn_write_comment');
      if (writeButton && visible(writeButton)) {
        clickNode(writeButton);
      }

      const commentRoot = root || document.querySelector('[id^="naverComment_"][id$="_ct"], [id^="naverComment_"].u_cbox, .u_cbox_wrap');
      if (commentRoot) {
        commentRoot.scrollIntoView({ block: 'center', behavior: 'instant' });
      }

      return {
        rootExists: !!root,
        rootVisible: visible(root),
        writeVisible: visible(writeButton),
        toggleExists: !!exactToggle,
      };
    })()
  `).catch(() => null);

  if (!result?.rootVisible) {
    await sleep(testMode ? 500 : 1200);
  }
  return Boolean(result?.toggleExists || result?.rootExists);
}

async function waitForCommentPanel(page, logNo = '') {
  const payload = JSON.stringify({ currentLogNo: logNo });
  await page.waitForFunction(`
    (() => {
      const { currentLogNo } = ${payload};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const hasMountedCommentContent = () => {
        const host = currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo) : null;
        const mountedRoots = [host, document].filter(Boolean);
        return mountedRoots.some((root) =>
          Array.from(root.querySelectorAll([
            'li.u_cbox_comment',
            'div.u_cbox_comment_box',
            '.u_cbox_btn_reply',
            'textarea[id*="write_textarea"]',
            '.u_cbox_write_box',
            '.u_cbox_comment_write',
            '.u_cbox_text_mention',
            '.btn_write_comment',
          ].join(', '))).some(visible)
        );
      };

      const directRoots = [
        currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '_ct') : null,
        currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo) : null,
      ].filter(Boolean);
      if (directRoots.some(visible) && hasMountedCommentContent()) {
        return true;
      }

      return hasMountedCommentContent();
    })()
  `, { timeout: 25000 });
}

function resolvePostContentFrame(page) {
  return page.frames().find((item) => item.name() === 'mainFrame' || /PostView\.naver/.test(item.url())) || null;
}

async function waitForPostContentFrame(page, testMode = false) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = resolvePostContentFrame(page);
    if (frame) {
      await frame.waitForSelector('body', { timeout: testMode ? 5000 : 15000 }).catch(() => {});
      return frame;
    }
    await sleep(testMode ? 300 : 800);
  }
  return page.mainFrame();
}

async function waitForCommentCapableFrame(page, logNo = '', testMode = false) {
  const selectorHints = [
    logNo ? `#Comi${logNo}` : '',
    '#btn_comment_2',
    logNo ? `#naverComment_201_${logNo}_ct` : '',
    '.commentbox_header',
    '.u_cbox_wrap',
  ].filter(Boolean);

  const fallbackFrame = await waitForPostContentFrame(page, testMode);
  let bestCandidate = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        await frame.waitForSelector('body', { timeout: testMode ? 1500 : 3000 }).catch(() => {});
        const surface = await frame.evaluate(`
          (() => {
            const selectors = ${JSON.stringify(selectorHints)};
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            };
            const commentSurfaceSelectors = [
              '.u_cbox_wrap',
              '.u_cbox_write_wrap',
              '.u_cbox_comment_box',
              '.u_cbox_btn_reply',
              'textarea[id*="write_textarea"]',
            ];
            const viewerSelectors = [
              '.cpv__root',
              '.cpv__error',
              '.cpv__content',
            ];
            return {
              hasCommentDom: selectors.some((selector) => Boolean(document.querySelector(selector))),
              hasVisibleCommentSurface: commentSurfaceSelectors.some((selector) =>
                Array.from(document.querySelectorAll(selector)).some(visible),
              ),
              hasVisibleViewerSurface: viewerSelectors.some((selector) =>
                Array.from(document.querySelectorAll(selector)).some(visible),
              ),
            };
          })()
        `).catch(() => null);
        if (surface?.hasVisibleCommentSurface && !surface?.hasVisibleViewerSurface) {
          return frame;
        }
        if (!bestCandidate && surface?.hasCommentDom && !surface?.hasVisibleViewerSurface) {
          bestCandidate = frame;
        }
      } catch {
        // ignore
      }
    }
    await sleep(testMode ? 300 : 800);
  }

  return bestCandidate || fallbackFrame;
}

function extractLogNo(postUrl) {
  const match = String(postUrl || '').match(/(\d{9,})/);
  return match ? match[1] : '';
}

async function inspectReplyControls(page) {
  return page.evaluate(`
    (() => {
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const replyButtons = Array.from(document.querySelectorAll('a,button')).filter(visible).filter((btn) => {
        const text = textOf(btn);
        const cls = String(btn.className || '');
        return /답글|답변/.test(text) || /u_cbox_btn_reply|btn_reply|replyButton/.test(cls);
      }).map((btn) => ({
        text: textOf(btn).slice(0, 80),
        className: String(btn.className || '').slice(0, 200),
        id: btn.id || '',
      }));

      const editors = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"], div[id*="write_textarea"]'))
        .filter(visible)
        .map((el) => ({
          id: el.id || '',
          className: String(el.className || '').slice(0, 160),
        }));

      return {
        url: location.href,
        replyButtonCount: replyButtons.length,
        editorCount: editors.length,
        replyButtons: replyButtons.slice(0, 5),
        editors: editors.slice(0, 5),
        snippet: textOf(document.body).slice(0, 400),
      };
    })()
  `);
}

async function inspectReplyControlsLite(page) {
  return page.evaluate(`
    (() => {
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const replyButtons = Array.from(document.querySelectorAll('a,button')).filter(visible).filter((btn) => {
        const text = textOf(btn);
        const cls = String(btn.className || '');
        return /답글|답변/.test(text) || /u_cbox_btn_reply|btn_reply|replyButton/.test(cls);
      });

      const editors = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"], div[id*="write_textarea"]'))
        .filter(visible);

      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const targetReplyArea = document.querySelector('[data-blog-target-reply-area="true"]');
      const targetReplyButton = document.querySelector('[data-blog-target-reply-button="true"]');

      return {
        url: location.href,
        replyButtonCount: replyButtons.length,
        editorCount: editors.length,
        targetCommentFound: Boolean(targetComment),
        targetReplyAreaFound: Boolean(targetReplyArea),
        targetReplyAreaVisible: visible(targetReplyArea),
        targetReplyButtonFound: Boolean(targetReplyButton),
        targetReplyButtonText: textOf(targetReplyButton).slice(0, 40),
      };
    })()
  `);
}

async function saveCommentDebugSnapshot(page, comment, stage) {
  try {
    ensureDir(BLOG_COMMENTER_DEBUG_DIR);
    const logNo = extractLogNo(comment?.post_url);
    const stamp = Date.now();
    const prefix = path.join(BLOG_COMMENTER_DEBUG_DIR, `${stamp}-${stage}-${logNo || 'unknown'}`);
    const payload = await page.evaluate(`
      (() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) =>
          String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
        const targetComment = document.querySelector('[data-blog-target-comment="true"]');
        const targetReplyArea = document.querySelector('[data-blog-target-reply-area="true"]');
        const targetReplyButton = document.querySelector('[data-blog-target-reply-button="true"]');
        const targetEditor = document.querySelector('[data-blog-commenter-editor="true"]');
        const isReplySubmitCandidate = (node) => {
          if (!visible(node)) return false;
          const text = textOf(node);
          const cls = String(node.className || '');
          const dataAction = String(node.getAttribute('data-action') || '');
          const uiSelector = String(node.getAttribute('data-ui-selector') || '');
          const inputType = String(node.getAttribute('type') || '').toLowerCase();
          const normalizedText = text.replace(/\s+/g, '');
          if (dataAction.includes('write#request')) return true;
          if (uiSelector === 'writeButton' || /^writeButton_/i.test(uiSelector)) return true;
          if (/u_cbox_btn_upload|btn_register|btn_write/i.test(cls)) return true;
          if (inputType === 'submit') return true;
          return /등록|완료|게시/.test(normalizedText);
        };
        const scopedRoots = [
          targetReplyArea,
          targetEditor && targetEditor.closest('.u_cbox_write_box, .u_cbox_reply_write, .u_cbox_reply_area, .u_cbox_comment_box'),
          targetEditor && targetEditor.closest('.u_cbox_write_wrap, .u_cbox_write, .u_cbox_write_area'),
        ].filter(Boolean);
        let submitButton = null;
        for (const root of scopedRoots) {
          submitButton = Array.from(root.querySelectorAll('button, a, input[type="submit"], [role="button"]')).find(isReplySubmitCandidate) || null;
          if (submitButton) break;
        }
        if (!submitButton) {
          submitButton = Array.from(
            document.querySelectorAll('button, a, input[type="submit"], [role="button"]'),
          ).find(isReplySubmitCandidate) || null;
        }
        const commentSelectors = ['.u_cbox_wrap', '.u_cbox_write_wrap', '.u_cbox_comment_box', '.u_cbox_btn_reply', 'textarea[id*="write_textarea"]'];
        const viewerSelectors = ['.cpv__root', '.cpv__error', '.cpv__content'];
        return {
          url: location.href,
          title: document.title,
          bodySnippet: textOf(document.body).slice(0, 1200),
          frameUrl: location.href,
          replyButtonCount: Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
            .filter((node) => visible(node) && /답글|답변|reply/i.test(textOf(node) + ' ' + String(node.className || ''))).length,
          editorCount: Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"], div[id*="write_textarea"]'))
            .filter(visible).length,
          targetCommentFound: Boolean(targetComment),
          targetReplyAreaFound: Boolean(targetReplyArea),
          targetReplyAreaVisible: visible(targetReplyArea),
          targetReplyButtonFound: Boolean(targetReplyButton),
          targetReplyButtonText: textOf(targetReplyButton).slice(0, 80),
          commentSurfaceState: {
            hasVisibleCommentSurface: commentSelectors.some((selector) =>
              Array.from(document.querySelectorAll(selector)).some(visible),
            ),
            hasVisibleViewerSurface: viewerSelectors.some((selector) =>
              Array.from(document.querySelectorAll(selector)).some(visible),
            ),
          },
          replyTextPreview: textOf(targetEditor).slice(0, 160),
          submitButtonState: submitButton ? {
            found: true,
            text: textOf(submitButton).slice(0, 80),
            className: String(submitButton.className || '').slice(0, 160),
            dataAction: String(submitButton.getAttribute('data-action') || ''),
            uiSelector: String(submitButton.getAttribute('data-ui-selector') || ''),
            disabled: Boolean(
              submitButton.disabled
              || submitButton.getAttribute('aria-disabled') === 'true'
              || /\\bdisabled\\b/i.test(String(submitButton.className || ''))
            ),
            visible: visible(submitButton),
          } : {
            found: false,
            text: '',
            className: '',
            dataAction: '',
            uiSelector: '',
            disabled: false,
            visible: false,
          },
          editorState: targetEditor ? {
            found: true,
            tagName: String(targetEditor.tagName || '').toLowerCase(),
            contentEditable: targetEditor.getAttribute('contenteditable') === 'true',
            visible: visible(targetEditor),
            textLength: textOf(targetEditor).length,
            id: String(targetEditor.id || ''),
            className: String(targetEditor.className || '').slice(0, 160),
          } : {
            found: false,
            tagName: '',
            contentEditable: false,
            visible: false,
            textLength: 0,
            id: '',
            className: '',
          },
          html: (document.documentElement && document.documentElement.outerHTML) || '',
        };
      })()
    `).catch(() => null);
    if (payload) {
      fs.writeFileSync(`${prefix}.json`, JSON.stringify(payload, null, 2), 'utf8');
      fs.writeFileSync(`${prefix}.html`, payload.html || '', 'utf8');
    }
    return prefix;
  } catch {
    return '';
  }
}

async function detectCommentSurfaceState(page) {
  return page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const commentSelectors = [
        '.u_cbox_wrap',
        '.u_cbox_write_wrap',
        '.u_cbox_comment_box',
        '.u_cbox_btn_reply',
        'textarea[id*="write_textarea"]',
      ];
      const viewerSelectors = [
        '.cpv__root',
        '.cpv__error',
        '.cpv__content',
      ];

      const hasVisibleCommentSurface = commentSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some(visible),
      );
      const hasVisibleViewerSurface = viewerSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some(visible),
      );

      return {
        url: location.href,
        title: document.title,
        hasVisibleCommentSurface,
        hasVisibleViewerSurface,
      };
    })()
  `).catch(() => ({
    url: '',
    title: '',
    hasVisibleCommentSurface: false,
    hasVisibleViewerSurface: false,
  }));
}

async function resolveReplyVerificationFrame(currentFrame, browserPage, comment, testMode = false) {
  if (!browserPage) {
    return { frame: currentFrame, refreshed: false, surface: null };
  }

  const currentSurface = await detectCommentSurfaceState(currentFrame);
  if (currentSurface.hasVisibleCommentSurface && !currentSurface.hasVisibleViewerSurface) {
    return { frame: currentFrame, refreshed: false, surface: currentSurface };
  }

  const logNo = extractLogNo(comment?.post_url);
  const refreshedFrame = await waitForCommentCapableFrame(browserPage, logNo, testMode);
  const refreshedSurface = await detectCommentSurfaceState(refreshedFrame);

  if (refreshedSurface.hasVisibleCommentSurface || !currentSurface.hasVisibleCommentSurface) {
    return { frame: refreshedFrame, refreshed: refreshedFrame !== currentFrame, surface: refreshedSurface };
  }

  return { frame: currentFrame, refreshed: false, surface: currentSurface };
}

async function mountCommentPanel(page, logNo = '', testMode = false) {
  const directRootSelector = [
    logNo ? `#naverComment_201_${logNo}_ct` : '',
    logNo ? `#naverComment_201_${logNo}` : '',
    '.u_cbox_wrap',
    '.u_cbox_write_box',
    '.u_cbox_comment_write',
    '.u_cbox_write_area',
    '.u_cbox_btn_reply',
    '.u_cbox_text_mention',
    '[id*="write_textarea"]',
  ].filter(Boolean).join(', ');
  const openPayload = JSON.stringify({ currentLogNo: logNo });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(`
      (() => {
        const { currentLogNo } = ${openPayload};
        window.scrollTo(0, document.body.scrollHeight);
        const hiddenRoot = currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '_ct') : null;
        if (hiddenRoot && hiddenRoot instanceof HTMLElement) {
          hiddenRoot.style.display = 'block';
          hiddenRoot.style.visibility = 'visible';
        }
        const anchors = [
          currentLogNo ? document.querySelector('#Comi' + currentLogNo) : null,
          document.querySelector('#btn_comment_2'),
          document.querySelector('.commentbox_header .btn_write_comment._naverCommentWriteBtn'),
          document.querySelector('.commentbox_header .btn_write_comment'),
          currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '_ct') : null,
        ].filter(Boolean);
        const target = anchors[0];
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        return true;
      })()
    `).catch(() => {});

    await humanDelay(1, 2, testMode);
    await openCommentPanel(page, logNo, testMode).catch(() => false);

    const mounted = await page.waitForFunction(`
      (() => {
        const selector = ${JSON.stringify(directRootSelector)};
        const currentLogNo = ${JSON.stringify(logNo)};
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const hasMountedCommentContent = () => {
          const host = currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo) : null;
          const mountedRoots = [host, document].filter(Boolean);
          return mountedRoots.some((root) =>
            Array.from(root.querySelectorAll([
              'li.u_cbox_comment',
              'div.u_cbox_comment_box',
              '.u_cbox_btn_reply',
              'textarea[id*="write_textarea"]',
              '.u_cbox_write_box',
              '.u_cbox_comment_write',
              '.u_cbox_text_mention',
              '.btn_write_comment',
            ].join(', '))).some(visible)
          );
        };

        const directRoots = [
          currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '_ct') : null,
          currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo) : null,
          currentLogNo ? document.querySelector('#Comi' + currentLogNo) : null,
        ].filter(Boolean);

        if (directRoots.some(visible) && hasMountedCommentContent()) {
          return true;
        }

        return Boolean(Array.from(document.querySelectorAll(selector)).find(visible)) && hasMountedCommentContent();
      })()
    `, { timeout: testMode ? 12000 : 18000 }).then(() => true).catch(() => false);

    if (mounted) {
      return true;
    }

    await humanDelay(2, 3, testMode);
  }

  return false;
}

async function focusReplyEditor(page) {
  await page.waitForFunction(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const scope = document.querySelector('[data-blog-target-reply-area="true"]')
        || targetComment?.querySelector('.u_cbox_reply_area')
        || targetComment?.querySelector('[class*="reply_area"]')
        || null;
      if (!scope) return false;
      const roots = [scope];
      const nodes = roots.flatMap((root) => Array.from(root.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]')));
      return nodes.some((node) => visible(node));
    })()
  `, { timeout: 15000 });

  return page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const scope = document.querySelector('[data-blog-target-reply-area="true"]')
        || targetComment?.querySelector('.u_cbox_reply_area')
        || targetComment?.querySelector('[class*="reply_area"]')
        || null;
      if (!scope) return null;
      const roots = [scope];
      const nodes = roots
        .flatMap((root) => Array.from(root.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]')))
        .filter(visible);
      const scoreNode = (node) => {
        let score = 0;
        const id = String(node.id || '');
        const dataAreaCode = String(node.getAttribute('data-area-code') || '');
        const title = String(node.getAttribute('title') || '');
        if (/__reply_textarea_/i.test(id)) score += 6;
        if (dataAreaCode === 'RPC.replyinput') score += 5;
        if (/답글|답변/.test(title)) score += 2;
        if (scope.contains(node)) score += 1;
        return score;
      };
      const target = nodes
        .map((node) => ({ node, score: scoreNode(node) }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.node)[0];
      if (!target) return null;
      document.querySelectorAll('[data-blog-commenter-editor="true"]').forEach((node) => node.removeAttribute('data-blog-commenter-editor'));
      target.setAttribute('data-blog-commenter-editor', 'true');
      target.focus();
      return {
        selector: '[data-blog-commenter-editor="true"]',
        tagName: String(target.tagName || '').toLowerCase(),
        contentEditable: target.getAttribute('contenteditable') === 'true',
        id: String(target.id || ''),
      };
    })()
  `);
}

async function inspectReplyEditorCandidates(page) {
  return page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const targetComment = document.querySelector('[data-blog-target-comment="true"]');
      const scope = document.querySelector('[data-blog-target-reply-area="true"]')
        || targetComment?.querySelector('.u_cbox_reply_area')
        || targetComment?.querySelector('[class*="reply_area"]')
        || null;
      const scoreNode = (node) => {
        let score = 0;
        const id = String(node.id || '');
        const dataAreaCode = String(node.getAttribute('data-area-code') || '');
        const title = String(node.getAttribute('title') || '');
        if (/__reply_textarea_/i.test(id)) score += 6;
        if (dataAreaCode === 'RPC.replyinput') score += 5;
        if (/답글|답변/.test(title)) score += 2;
        if (scope && scope.contains(node)) score += 1;
        return score;
      };
      const nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]'))
        .filter(visible)
        .map((node) => ({
          id: String(node.id || ''),
          title: String(node.getAttribute('title') || ''),
          dataAreaCode: String(node.getAttribute('data-area-code') || ''),
          className: String(node.className || '').slice(0, 120),
          inReplyArea: Boolean(scope && scope.contains(node)),
          score: scoreNode(node),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      return {
        hasScope: Boolean(scope),
        candidates: nodes,
      };
    })()
  `).catch(() => ({
    hasScope: false,
    candidates: [],
  }));
}

async function focusCommentEditor(page, logNo = '', timeoutMs = 15000) {
  const directSelector = [
    logNo ? `#naverComment_201_${logNo}__write_textarea` : '',
    'div.u_cbox_text.u_cbox_text_mention',
    'div[contenteditable="true"]:not([data-blog-target-reply-area="true"] *)',
  ].filter(Boolean).join(', ');

  await page.waitForFunction(`
    (() => {
      const selector = ${JSON.stringify(directSelector)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return Boolean(Array.from(document.querySelectorAll(selector)).find(visible));
    })()
  `, { timeout: timeoutMs });

  return page.evaluate(`
    (() => {
      const currentLogNo = ${JSON.stringify(logNo)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const inReplyArea = (node) =>
        Boolean(node && node.closest('.u_cbox_reply_area,[data-blog-target-reply-area="true"]'));

      const preferred = currentLogNo ? document.querySelector('#naverComment_201_' + currentLogNo + '__write_textarea') : null;
      const candidates = [
        preferred,
        ...Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"], div[id*="write_textarea"]')),
      ].filter(Boolean).filter((node) => visible(node) && !inReplyArea(node));

      const target = candidates[0];
      if (!target) return null;
      document.querySelectorAll('[data-blog-commenter-editor="true"]').forEach((node) => node.removeAttribute('data-blog-commenter-editor'));
      target.setAttribute('data-blog-commenter-editor', 'true');
      target.focus();
      return {
        selector: '[data-blog-commenter-editor="true"]',
        tagName: String(target.tagName || '').toLowerCase(),
        contentEditable: target.getAttribute('contenteditable') === 'true',
      };
    })()
  `);
}

async function submitReply(page, browserPage = null) {
  if (browserPage && process.env.BLOG_COMMENTER_KEYBOARD_SUBMIT === 'true') {
    traceCommenter('postReply:submit-keyboard-start');
    await browserPage.keyboard.press('Tab').catch(() => {});
    await sleep(150);
    await browserPage.keyboard.press('Enter').catch(() => {});
    traceCommenter('postReply:submit-keyboard-done');
    return;
  }

  traceCommenter('postReply:submit-locate-start', { selectorCount: 1 });
  const submitState = await page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const isReplySubmit = (node) => {
        if (!visible(node)) return false;
        const tag = String(node.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'a' && tag !== 'input') return false;
        const dataAction = String(node.getAttribute('data-action') || '');
        const uiSelector = String(node.getAttribute('data-ui-selector') || '');
        const cls = String(node.className || '');
        const text = textOf(node).replace(/\s+/g, '');
        const role = String(node.getAttribute('role') || '');
        const inputType = String(node.getAttribute('type') || '').toLowerCase();
        if (dataAction.includes('write#request')) return true;
        if (uiSelector === 'writeButton' || /^writeButton_/i.test(uiSelector)) return true;
        if (/u_cbox_btn_upload|btn_register|btn_write/i.test(cls)) return true;
        if (inputType === 'submit') return true;
        if ((role === 'button' || tag === 'button') && /등록|완료|게시/.test(text)) return true;
        return false;
      };
      const targetReplyArea = document.querySelector('[data-blog-target-reply-area="true"]');
      const targetEditor = document.querySelector('[data-blog-commenter-editor="true"]');
      const replyFormRoot =
        targetEditor && targetEditor.closest('form')
        || targetEditor && targetEditor.closest('.u_cbox_write_box')
        || targetEditor && targetEditor.closest('.u_cbox_write_wrap')
        || targetReplyArea && targetReplyArea.querySelector('form')
        || targetReplyArea && targetReplyArea.querySelector('.u_cbox_write_box')
        || targetReplyArea && targetReplyArea.querySelector('.u_cbox_write_wrap')
        || null;
      const roots = [
        replyFormRoot,
        targetReplyArea,
        targetEditor && targetEditor.closest('.u_cbox_write_box, .u_cbox_reply_write, .u_cbox_reply_area'),
        targetEditor && targetEditor.closest('.u_cbox_write_wrap, .u_cbox_write, .u_cbox_write_area'),
      ].filter(Boolean);

      const scoreNode = (node, root) => {
        let score = 0;
        const text = textOf(node);
        const cls = String(node.className || '');
        const dataAction = String(node.getAttribute('data-action') || '');
        const uiSelector = String(node.getAttribute('data-ui-selector') || '');
        if (replyFormRoot && replyFormRoot.contains(node)) score += 8;
        if (root === targetReplyArea) score += 6;
        if (targetEditor && targetEditor.closest('.u_cbox_write_box, .u_cbox_reply_write, .u_cbox_reply_area, .u_cbox_comment_box')?.contains(node)) score += 4;
        if (targetEditor && targetEditor.closest('.u_cbox_write_wrap, .u_cbox_write, .u_cbox_write_area')?.contains(node)) score += 3;
        if (/등록|완료|게시/.test(text)) score += 3;
        if (dataAction.includes('write#request')) score += 3;
        if (uiSelector === 'writeButton' || /^writeButton_/i.test(uiSelector)) score += 2;
        if (/u_cbox_btn_upload|btn_register|btn_write/i.test(cls)) score += 2;
        return score;
      };

      let node = null;
      let bestScore = -1;
      for (const root of roots) {
        for (const candidate of Array.from(root.querySelectorAll('button, a, input[type="submit"], [role="button"]'))) {
          if (!isReplySubmit(candidate)) continue;
          const score = scoreNode(candidate, root);
          if (score > bestScore) {
            bestScore = score;
            node = candidate;
          }
        }
      }
      document.querySelectorAll('[data-blog-commenter-submit="true"]').forEach((item) => item.removeAttribute('data-blog-commenter-submit'));
      if (!node) {
        return {
          clicked: false,
          selectorAssigned: false,
          text: '',
          className: '',
          dataAction: '',
          uiSelector: '',
        };
      }

      node.setAttribute('data-blog-commenter-submit', 'true');
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      try { node.focus(); } catch {}
      try { node.click(); } catch {}
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
      node.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 0 }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 0 }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 0 }));
      node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      return {
        clicked: true,
        selectorAssigned: true,
        text: textOf(node).slice(0, 80),
        className: String(node.className || '').slice(0, 160),
        dataAction: String(node.getAttribute('data-action') || ''),
        uiSelector: String(node.getAttribute('data-ui-selector') || ''),
      };
    })()
  `).catch(() => ({
    clicked: false,
    selectorAssigned: false,
    text: '',
    className: '',
    dataAction: '',
    uiSelector: '',
  }));

  traceCommenter('postReply:submit-locate-done', submitState);

  if (submitState?.selectorAssigned) {
    const nativeTarget = await page.$('[data-blog-commenter-submit="true"]').catch(() => null);
    if (nativeTarget) {
      await nativeTarget.evaluate((node) => {
        if (node && node.scrollIntoView) {
          node.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
      }).catch(() => {});
      await nativeTarget.click({ force: true }).catch(() => {});
    }
  }

  if (submitState?.clicked) {
    traceCommenter('postReply:submit-click-done', { scoped: true });
    if (browserPage) {
      await sleep(120);
      await browserPage.keyboard.press('Enter').catch(() => {});
    }
    return;
  }

  if (browserPage) {
    traceCommenter('postReply:submit-keyboard-fallback');
    await browserPage.keyboard.press('Tab').catch(() => {});
    await sleep(150);
    await browserPage.keyboard.press('Enter').catch(() => {});
    return;
  }

  throw new Error('reply_submit_not_found');
}

async function submitComment(page) {
  const clicked = await page.evaluate(`
    (() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('button[type="button"], button, a'));
      const submit = candidates.find((btn) => {
        if (!visible(btn)) return false;
        const dataAction = String(btn.getAttribute('data-action') || '');
        const uiSelector = String(btn.getAttribute('data-ui-selector') || '');
        return dataAction === 'write#request' && uiSelector === 'writeButton';
      });
      if (!submit) return false;
      submit.scrollIntoView({ block: 'center', behavior: 'instant' });
      submit.click();
      return true;
    })()
  `);

  if (!clicked) {
    throw new Error('comment_submit_not_found');
  }
}

async function getSympathyState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const textOf = (node) =>
      String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

    const getReactionModule = () =>
      document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module[data-markuserreaction="true"]')
        || document.querySelector('.my_reaction .u_likeit_list_module[data-markuserreaction="true"]')
        || document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module')
        || document.querySelector('.my_reaction .u_likeit_list_module')
        || document.querySelector('.area_sympathy .my_reaction')
        || document.querySelector('.my_reaction')
        || document;

    const findPrimarySympathyButton = () => {
      const scope = getReactionModule();
      const likeButton = scope.querySelector('a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]');
      if (likeButton) return likeButton;
      const faceButton = scope.querySelector('a.u_likeit_button._face[role="button"]');
      if (visible(faceButton)) return faceButton;
      return null;
    };

    const isPrimarySympathyButton = (node) => {
      if (!node) return false;
      const text = textOf(node);
      const cls = String(node.className || '');
      const href = String(node.getAttribute('href') || '');
      return /공감/.test(text) && /u_likeit_list_button/.test(cls) && /ratingbutton-like/i.test(href);
    };

    const candidates = Array.from(document.querySelectorAll('a,button')).filter(visible);
    const target = findPrimarySympathyButton()
      || candidates.find(isPrimarySympathyButton)
      || candidates.find((node) => {
        const text = textOf(node);
        const cls = String(node.className || '');
        return /공감/.test(text) && (/u_likeit_button/.test(cls) || node.id?.startsWith?.('Sympathy'));
      });

    if (!target) {
      return { found: false, active: false };
    }

    const ariaPressed = String(target.getAttribute('aria-pressed') || '').trim().toLowerCase();
    const ariaSelected = String(target.getAttribute('aria-selected') || '').trim().toLowerCase();
    const active = ariaPressed === 'true' || ariaSelected === 'true' || /\bon\b/.test(String(target.className || ''));
    return {
      found: true,
      active,
      text: String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim(),
      className: String(target.className || ''),
      href: String(target.getAttribute('href') || ''),
    };
  });
}

async function activateSympathyInFrame(contentFrame, { testMode = false, postUrl = null } = {}) {
  await contentFrame.waitForSelector('body', { timeout: testMode ? 5000 : 15000 }).catch(() => {});
  await humanDelay(1, 2, testMode);

  const before = await getSympathyState(contentFrame);
  if (before.found && before.active) {
    return { ok: true, alreadyActive: true, postUrl };
  }

  const clicked = await contentFrame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const textOf = (node) =>
      String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

    const getReactionModule = () =>
      document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module[data-markuserreaction="true"]')
        || document.querySelector('.my_reaction .u_likeit_list_module[data-markuserreaction="true"]')
        || document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module')
        || document.querySelector('.my_reaction .u_likeit_list_module')
        || document.querySelector('.area_sympathy .my_reaction')
        || document.querySelector('.my_reaction')
        || document;

    const clickNode = (target) => {
      if (!target) return false;
      if (visible(target)) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    };

    const findPrimarySympathyButton = () => {
      const scope = getReactionModule();
      const likeButton = scope.querySelector('a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]');
      if (likeButton) return likeButton;
      const faceButton = scope.querySelector('a.u_likeit_button._face[role="button"]');
      if (visible(faceButton)) return faceButton;
      return null;
    };

    const isPrimarySympathyButton = (node) => {
      if (!node) return false;
      const text = textOf(node);
      const cls = String(node.className || '');
      const href = String(node.getAttribute('href') || '');
      const ariaPressed = String(node.getAttribute('aria-pressed') || '').trim().toLowerCase();
      const ariaSelected = String(node.getAttribute('aria-selected') || '').trim().toLowerCase();
      if (ariaPressed === 'true' || ariaSelected === 'true' || /\bon\b/.test(cls)) return false;
      return /공감/.test(text) && /u_likeit_list_button/.test(cls) && /ratingbutton-like/i.test(href);
    };

    const candidates = Array.from(document.querySelectorAll('a,button')).filter(visible);
    const target = findPrimarySympathyButton()
      || candidates.find(isPrimarySympathyButton)
      || candidates.find((node) => {
        const text = textOf(node);
        const cls = String(node.className || '');
        const ariaPressed = String(node.getAttribute('aria-pressed') || '').trim().toLowerCase();
        const ariaSelected = String(node.getAttribute('aria-selected') || '').trim().toLowerCase();
        if (ariaPressed === 'true' || ariaSelected === 'true' || /\bon\b/.test(cls)) return false;
        return /공감/.test(text) && (/u_likeit_button/.test(cls) || node.id?.startsWith?.('Sympathy'));
      });

    if (!target) return { ok: false, mode: null };
    return {
      ok: clickNode(target),
      mode: target.matches?.('a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]') ? 'like' : 'face',
    };
  });

  if (!clicked?.ok) {
    throw new Error('sympathy_button_not_found');
  }

  await humanDelay(1, 2, testMode);
  let after = await getSympathyState(contentFrame);

  if (!after.found || !after.active) {
    await contentFrame.evaluate(() => {
      const likeButton = document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module[data-markuserreaction="true"] a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]')
        || document.querySelector('.my_reaction .u_likeit_list_module[data-markuserreaction="true"] a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]')
        || document.querySelector('.area_sympathy .my_reaction .u_likeit_list_module a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]')
        || document.querySelector('.my_reaction .u_likeit_list_module a.u_likeit_list_button._button[data-type="like"][href*="#ratingbutton-like"]');
      if (!likeButton) return false;
      likeButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      likeButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      likeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);
    await humanDelay(1, 2, testMode);
    after = await getSympathyState(contentFrame);
  }

  if (!after.found || !after.active) {
    throw new Error('sympathy_not_confirmed');
  }

  return { ok: true, alreadyActive: false, postUrl, mode: clicked.mode };
}

async function clickSympathy(postUrl, { testMode = false } = {}) {
  return withBrowserPage(testMode, async (page) => {
    const targetPostUrl = resolveNavigablePostUrl(postUrl);
    await goto(page, targetPostUrl);
    let contentFrame = await waitForPostContentFrame(page, testMode);
    await humanDelay(1, 2, testMode);
    contentFrame = await waitForPostContentFrame(page, testMode);
    return activateSympathyInFrame(contentFrame, { testMode, postUrl: targetPostUrl });
  });
}

async function verifyReplyPosted(page, replyText, comment, testMode = false, browserPage = null) {
  const needle = normalizeText(replyText).slice(0, 24);
  const commentRef = parseCommentRef(comment?.comment_ref);
  const normalizedPost = normalizePostUrl(comment?.post_url || '');
  const replyEditorId = (normalizedPost.ok && commentRef.commentNo)
    ? `naverComment_201_${normalizedPost.logNo}__reply_textarea_${commentRef.commentNo}`
    : '';
  if (!needle && !replyEditorId) return false;

  const timeoutMs = testMode ? 4000 : 15000;
  const waitForReplySignal = async (targetPage) => targetPage.waitForFunction(`
    (() => {
      const expected = ${JSON.stringify(needle)};
      const replyEditorId = ${JSON.stringify(replyEditorId)};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const isEditorArea = (el) => {
        if (!el) return false;
        return Boolean(
          el.closest(
            [
              '.u_cbox_write_box',
              '.u_cbox_comment_write',
              '.u_cbox_reply_write',
              '.u_cbox_text_wrap',
              '.u_cbox_write_area',
              '[id*="write"]',
              '[class*="write"]',
              '[class*="textarea"]',
            ].join(', '),
          ),
        );
      };

      const candidates = Array.from(
        document.querySelectorAll(
          [
            'li.u_cbox_comment',
            'li[class*="comment"]',
            'li[class*="reply"]',
            'div.u_cbox_comment_box',
            'div[class*="reply_area"]',
            'div[class*="reply"]',
            'div[class*="comment"]',
          ].join(', '),
        ),
      ).filter((node) => visible(node) && !isEditorArea(node));

      if (expected && candidates.some((node) => textOf(node).includes(expected))) {
        return true;
      }

      if (replyEditorId) {
        const replyEditor = document.getElementById(replyEditorId);
        const replyEditorVisible = visible(replyEditor);
        const submitButton = Array.from(
          document.querySelectorAll(
            [
              'button.u_cbox_btn_upload',
              'button[class*="upload"]',
              'button[data-action="reply#submit"]',
              'button[data-action="comment#submit"]',
              'input[type="submit"]',
            ].join(', '),
          ),
        ).find((node) => visible(node));

        const submitDisabled = Boolean(
          submitButton
          && (
            submitButton.disabled
            || submitButton.getAttribute('aria-disabled') === 'true'
            || /\bdisabled\b/i.test(String(submitButton.className || ''))
          )
        );

        if (!replyEditorVisible && (submitDisabled || !submitButton)) {
          return true;
        }
      }

      return false;
    })()
  `, { timeout: timeoutMs }).then(() => true).catch(() => false);

  let matched = await waitForReplySignal(page);
  if (matched) {
    return true;
  }

  if (browserPage) {
    const refreshed = await resolveReplyVerificationFrame(page, browserPage, comment, testMode);
    if (refreshed.refreshed || refreshed.surface?.hasVisibleViewerSurface) {
      matched = await waitForReplySignal(refreshed.frame);
      if (matched) {
        return true;
      }
    }
  }

  return matched;
}

async function verifyCommentPosted(page, commentText, testMode = false) {
  const needle = normalizeText(commentText).slice(0, 24);
  if (!needle) return false;

  const timeoutMs = testMode ? 5000 : 15000;
  return page.waitForFunction(`
    (() => {
      const expected = ${JSON.stringify(needle)};
      const textOf = (el) =>
        String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const isEditorArea = (el) => {
        if (!el) return false;
        return Boolean(
          el.closest(
            [
              '.u_cbox_write_box',
              '.u_cbox_comment_write',
              '.u_cbox_reply_write',
              '.u_cbox_text_wrap',
              '.u_cbox_write_area',
              '[id*="write"]',
              '[class*="write"]',
              '[class*="textarea"]',
            ].join(', '),
          ),
        );
      };

      const candidates = Array.from(
        document.querySelectorAll(
          [
            'li.u_cbox_comment',
            'li[class*="comment"]',
            'div.u_cbox_comment_box',
            'div[class*="comment"]',
          ].join(', '),
        ),
      ).filter((node) => visible(node) && !isEditorArea(node));

      return candidates.some((node) => textOf(node).includes(expected));
    })()
  `, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function typeReply(frame, browserPage, selector, replyText, config, testMode) {
  const durationMs = calcDelayMs(config.typingMinSec, config.typingMaxSec, testMode);
  const perCharDelay = Math.max(15, Math.min(180, Math.round(durationMs / Math.max(replyText.length, 1))));
  const target = await frame.$(selector);
  if (!target) throw new Error('reply_editor_not_found');

  const editorPayload = JSON.stringify({ targetSelector: selector, nextText: replyText });
  const editorMeta = await frame.evaluate(`
    (() => {
      const { targetSelector, nextText } = ${editorPayload};
      const dispatchEditableEvents = (node) => {
        const events = [
          new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: nextText }),
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextText }),
          new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }),
          new Event('change', { bubbles: true }),
          new Event('blur', { bubbles: true }),
        ];
        for (const event of events) {
          node.dispatchEvent(event);
        }
      };

      const node = document.querySelector(targetSelector);
      if (!node) {
        return { found: false };
      }

      node.focus();
      const isEditable = node.getAttribute('contenteditable') === 'true';
      const tagName = String(node.tagName || '').toLowerCase();

      if (isEditable) {
        node.innerHTML = '';
        node.textContent = nextText;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection && selection.removeAllRanges();
        selection && selection.addRange(range);
        dispatchEditableEvents(node);
      } else if (tagName === 'textarea' || tagName === 'input') {
        node.value = nextText;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return {
        found: true,
        tagName,
        isEditable,
        textLength: String(node.textContent || node.value || '').trim().length,
      };
    })()
  `);

  if (!editorMeta?.found) {
    throw new Error('reply_editor_not_found');
  }

  if ((editorMeta?.textLength || 0) >= Math.min(20, replyText.length)) {
    return;
  }

  await target.click({ clickCount: 3 }).catch(() => {});
  await browserPage.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control').catch(() => {});
  await browserPage.keyboard.press('KeyA').catch(() => {});
  await browserPage.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control').catch(() => {});
  await browserPage.keyboard.press('Backspace').catch(() => {});
  await browserPage.keyboard.type(replyText, { delay: perCharDelay });

  const lengthPayload = JSON.stringify({ targetSelector: selector });
  const typedLength = await frame.evaluate(`
    (() => {
      const { targetSelector } = ${lengthPayload};
      const node = document.querySelector(targetSelector);
      return String((node && (node.textContent || node.value)) || '').trim().length;
    })()
  `).catch(() => 0);

  if (typedLength < Math.min(20, replyText.length)) {
    throw new Error(`reply_editor_text_not_applied:${typedLength}`);
  }
}

async function postReply(comment, replyText, { testMode = false, dryRun = false, operationTimeoutMs = 0 } = {}) {
  const config = getCommenterConfig();
  const targetPostUrl = resolveNavigablePostUrl(comment.post_url);
  const logNo = extractLogNo(targetPostUrl || comment.post_url);
  return withBrowserPage(testMode, async (page) => {
    traceCommenter('postReply:start', {
      commentId: comment.id,
      logNo,
      targetPostUrl,
      dryRun,
      testMode,
      operationTimeoutMs: Number(operationTimeoutMs || 0),
    });
    await goto(page, targetPostUrl);
    let contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
    traceCommenter('postReply:frame-ready', { commentId: comment.id, logNo });
    await humanDelay(config.pageReadMinSec, config.pageReadMaxSec, testMode);
    contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
    traceCommenter('postReply:frame-refreshed', { commentId: comment.id, logNo });
    const mounted = await mountCommentPanel(contentFrame, logNo, testMode);
    traceCommenter('postReply:panel-mounted', { commentId: comment.id, mounted });
    let opened = false;
    if (mounted) {
      await waitForCommentPanel(contentFrame, logNo).catch(() => false);
      await humanDelay(1, 2, testMode);
      await waitForReplyThread(contentFrame, comment, testMode).catch(() => false);
      traceCommenter('postReply:reply-thread-ready', { commentId: comment.id });
      opened = await openReplyEditor(contentFrame, comment);
      traceCommenter('postReply:reply-button-targeted', { commentId: comment.id, opened });
      if (opened) {
        opened = await activateReplyMode(contentFrame);
        if (!opened) {
          const replyModeState = await inspectActivateReplyModeLite(contentFrame).catch(() => null);
          if (isReplyModeStateReady(replyModeState)) {
            opened = true;
            traceCommenter('postReply:reply-mode-promoted-from-state', {
              commentId: comment.id,
              replyEditorCount: replyModeState?.replyEditorCount || 0,
            });
          }
        }
        traceCommenter('postReply:reply-mode-activated', { commentId: comment.id, opened });
        if (opened) {
          const submitReady = await waitForReplySubmitReady(contentFrame, testMode);
          traceCommenter('postReply:reply-submit-ready', { commentId: comment.id, submitReady });
        }
      } else {
        const expanded = await expandReplyThreads(contentFrame);
        traceCommenter('postReply:reply-thread-expanded', { commentId: comment.id, expanded });
        if (expanded > 0) {
          await humanDelay(1, 2, testMode);
          await waitForReplyThread(contentFrame, comment, testMode).catch(() => false);
          opened = await openReplyEditor(contentFrame, comment);
          traceCommenter('postReply:reply-button-retargeted', { commentId: comment.id, opened });
          if (opened) {
            opened = await activateReplyMode(contentFrame);
            if (!opened) {
              const replyModeState = await inspectActivateReplyModeLite(contentFrame).catch(() => null);
              if (isReplyModeStateReady(replyModeState)) {
                opened = true;
                traceCommenter('postReply:reply-mode-promoted-from-state-reactivated', {
                  commentId: comment.id,
                  replyEditorCount: replyModeState?.replyEditorCount || 0,
                });
              }
            }
            traceCommenter('postReply:reply-mode-reactivated', { commentId: comment.id, opened });
            if (opened) {
              const submitReady = await waitForReplySubmitReady(contentFrame, testMode);
              traceCommenter('postReply:reply-submit-ready-reactivated', { commentId: comment.id, submitReady });
            }
          }
        }
      }
    }

    if (!opened) {
      traceCommenter('postReply:reply-open-retry-start', { commentId: comment.id, logNo });
      await openCommentPanel(contentFrame, logNo, testMode).catch(() => false);
      await humanDelay(1, 2, testMode);
      const remounted = await mountCommentPanel(contentFrame, logNo, testMode);
      traceCommenter('postReply:reply-open-remounted', { commentId: comment.id, remounted });
      if (remounted) {
        await waitForReplyThread(contentFrame, comment, testMode).catch(() => false);
        opened = await openReplyEditor(contentFrame, comment);
        traceCommenter('postReply:reply-button-retargeted-second', { commentId: comment.id, opened });
        if (opened) {
          opened = await activateReplyMode(contentFrame);
          if (!opened) {
            const replyModeState = await inspectActivateReplyModeLite(contentFrame).catch(() => null);
            if (isReplyModeStateReady(replyModeState)) {
              opened = true;
              traceCommenter('postReply:reply-mode-promoted-from-state-second', {
                commentId: comment.id,
                replyEditorCount: replyModeState?.replyEditorCount || 0,
              });
            }
          }
          traceCommenter('postReply:reply-mode-reactivated-second', { commentId: comment.id, opened });
          if (opened) {
            const submitReady = await waitForReplySubmitReady(contentFrame, testMode);
            traceCommenter('postReply:reply-submit-ready-second', { commentId: comment.id, submitReady });
          }
        }
      }
    }

    if (!opened) {
      const debug = await inspectReplyControlsLite(contentFrame).catch(() => null);
      let snapshotPrefix = '';
      if (shouldCaptureHeavyCommentDebug()) {
        const heavyDebug = await inspectReplyControls(contentFrame).catch(() => null);
        snapshotPrefix = await saveCommentDebugSnapshot(contentFrame, comment, mounted ? 'reply-open-failed' : 'comment-panel-not-mounted');
        traceCommenter('postReply:reply-open-failed', {
          commentId: comment.id,
          mounted,
          debug: heavyDebug,
          snapshotPrefix,
        });
      } else {
        traceCommenter('postReply:reply-open-failed-lite', {
          commentId: comment.id,
          mounted,
          debug,
        });
      }
      throw new Error(`reply_button_not_found:${JSON.stringify({ ...(debug || {}), snapshotPrefix }).slice(0, 500)}`);
    }

    await humanDelay(1, 2, testMode);
    let editor = null;
    let usedCommentEditorFallback = false;
    try {
      editor = await focusReplyEditor(contentFrame);
    } catch (error) {
      traceCommenter('postReply:reply-editor-fallback', {
        commentId: comment.id,
        reason: String(error?.message || error),
      });
      editor = await focusCommentEditor(contentFrame, logNo, testMode ? 8000 : 15000).catch(() => null);
      usedCommentEditorFallback = Boolean(editor?.selector);
    }
    traceCommenter('postReply:editor-focused', {
      commentId: comment.id,
      hasEditor: Boolean(editor?.selector),
      selector: editor?.selector || '',
      usedCommentEditorFallback,
    });
    if (!editor?.selector) {
      throw new Error('reply_editor_not_found');
    }

    if (testMode || dryRun) {
      const submitReady = await waitForReplySubmitReady(contentFrame, testMode).catch(() => false);
      const submitState = await inspectReplySubmitLite(contentFrame).catch(() => null);
      return {
        ok: true,
        dryRun: true,
        stage: 'reply_editor_ready',
        editorSelector: editor.selector,
        editorId: editor.id || '',
        submitReady,
        submitState,
      };
    }

    await typeReply(contentFrame, page, editor.selector, replyText, config, testMode);
    traceCommenter('postReply:typed', {
      commentId: comment.id,
      replyLength: String(replyText || '').length,
    });
    await humanDelay(1, 2, testMode);
    let submitted = false;
    try {
      await submitReply(contentFrame, page);
      submitted = true;
    } catch (error) {
      traceCommenter('postReply:submit-retry-start', {
        commentId: comment.id,
        reason: String(error?.message || error),
      });
      await openCommentPanel(contentFrame, logNo, testMode).catch(() => false);
      await humanDelay(1, 2, testMode);
      await activateReplyMode(contentFrame).catch(() => false);
      await waitForReplySubmitReady(contentFrame, testMode).catch(() => false);
      await humanDelay(1, 2, testMode);
      await submitReply(contentFrame, page);
      submitted = true;
    }
    traceCommenter('postReply:submitted', { commentId: comment.id, submitted });
    const posted = await verifyReplyPosted(contentFrame, replyText, comment, testMode, page);
    traceCommenter('postReply:verified', { commentId: comment.id, posted });
    if (!posted) {
      const snapshotPrefix = await saveCommentDebugSnapshot(contentFrame, comment, 'reply-submit-not-confirmed');
      const debug = await inspectReplyControlsLite(contentFrame).catch(() => null);
      traceCommenter('postReply:submit-not-confirmed', {
        commentId: comment.id,
        debug,
        snapshotPrefix,
      });
      throw new Error(`reply_submit_not_confirmed:${JSON.stringify({ ...(debug || {}), snapshotPrefix }).slice(0, 500)}`);
    }
    await humanDelay(config.betweenCommentsMinSec, config.betweenCommentsMaxSec, testMode);
    traceCommenter('postReply:done', { commentId: comment.id });
    return { ok: true };
  }, {
    timeoutMs: Number(operationTimeoutMs || 0),
    timeoutCode: 'reply_process_timeout',
  });
}

async function diagnoseReplyUi(comment, { testMode = true, operationTimeoutMs = 10000 } = {}) {
  const targetPostUrl = resolveNavigablePostUrl(comment?.post_url || '');
  const logNo = extractLogNo(targetPostUrl || comment?.post_url || '');
  let stage = 'connect_browser';
  let frameUrl = '';
  const partialState = {
    mounted: false,
    replyThreadReady: false,
    replyButtonTargeted: false,
    targetReplyButton: null,
    replyModeOpened: false,
    replyModeState: null,
    replyEditorFound: false,
    replyEditorError: '',
    editorSelector: '',
    editorId: '',
    editorCandidates: null,
  };
  try {
    return await withBrowserPage(Boolean(testMode), async (page) => {
      stage = 'goto_post';
      await goto(page, targetPostUrl);
      stage = 'resolve_comment_frame';
      let contentFrame = await waitForCommentCapableFrame(page, logNo, true);
      frameUrl = String(contentFrame?.url?.() || '');
      stage = 'mount_comment_panel';
      const mounted = await mountCommentPanel(contentFrame, logNo, true).catch(() => false);
      partialState.mounted = mounted;

      let replyThreadReady = false;
      let replyButtonTargeted = false;
      let replyModeOpened = false;
      let replyModeState = null;
      let editor = null;
      let replyEditorError = '';
      let editorCandidates = null;

      if (mounted) {
        stage = 'wait_comment_panel';
        await waitForCommentPanel(contentFrame, logNo).catch(() => false);
        stage = 'wait_reply_thread';
        replyThreadReady = await waitForReplyThread(contentFrame, comment, true).catch(() => false);
        partialState.replyThreadReady = replyThreadReady;
        stage = 'open_reply_editor';
        replyButtonTargeted = await openReplyEditor(contentFrame, comment).catch(() => false);
        partialState.replyButtonTargeted = replyButtonTargeted;
        partialState.targetReplyButton = await inspectTargetReplyButtonLite(contentFrame).catch(() => null);
        if (replyButtonTargeted) {
          stage = 'activate_reply_mode';
          replyModeOpened = await activateReplyMode(contentFrame).catch(() => false);
          replyModeState = await inspectActivateReplyModeLite(contentFrame).catch(() => null);
          if (!replyModeOpened && isReplyModeStateReady(replyModeState)) {
            replyModeOpened = true;
          }
          partialState.replyModeOpened = replyModeOpened;
          partialState.replyModeState = replyModeState;
        }
        if (!replyModeOpened) {
          stage = 'expand_reply_threads';
          const expanded = await expandReplyThreads(contentFrame).catch(() => 0);
          if (expanded > 0) {
            stage = 'wait_reply_thread_retry';
            await waitForReplyThread(contentFrame, comment, true).catch(() => false);
            stage = 'open_reply_editor_retry';
            replyButtonTargeted = await openReplyEditor(contentFrame, comment).catch(() => replyButtonTargeted);
            partialState.replyButtonTargeted = replyButtonTargeted;
            if (replyButtonTargeted) {
              stage = 'activate_reply_mode_retry';
              replyModeOpened = await activateReplyMode(contentFrame).catch(() => false);
              replyModeState = await inspectActivateReplyModeLite(contentFrame).catch(() => replyModeState);
              if (!replyModeOpened && isReplyModeStateReady(replyModeState)) {
                replyModeOpened = true;
              }
              partialState.replyModeOpened = replyModeOpened;
              partialState.replyModeState = replyModeState;
            }
          }
        }
        try {
          stage = 'focus_reply_editor';
          editor = await focusReplyEditor(contentFrame);
          partialState.replyEditorFound = Boolean(editor?.selector);
          partialState.editorSelector = editor?.selector || '';
          partialState.editorId = editor?.id || '';
        } catch (error) {
          replyEditorError = String(error?.message || error || 'reply_editor_not_found');
          partialState.replyEditorError = replyEditorError;
        }
      }

      stage = 'inspect_submit_state';
      editorCandidates = await inspectReplyEditorCandidates(contentFrame).catch(() => null);
      partialState.editorCandidates = editorCandidates;
      const submitState = await inspectReplySubmitLite(contentFrame, { fast: true }).catch(() => null);
      const controls = await inspectReplyControlsLite(contentFrame).catch(() => null);
      const submitReady = Boolean(
        replyModeOpened
        && (submitState?.replyFormRootFound || submitState?.targetReplyAreaVisible)
        && Array.isArray(submitState?.submitCandidates)
        && submitState.submitCandidates.length > 0
      );

      return {
        ok: Boolean(mounted && replyModeOpened && editor?.selector),
        stage,
        mounted,
        replyThreadReady,
        replyButtonTargeted,
        replyModeOpened,
        replyModeState,
        replyEditorFound: Boolean(editor?.selector),
        replyEditorError,
        editorSelector: editor?.selector || '',
        editorId: editor?.id || '',
        editorCandidates,
        submitReady,
        submitState,
        controls,
        logNo,
        frameUrl: String(contentFrame?.url?.() || ''),
      };
    }, {
      timeoutMs: Number(operationTimeoutMs || 0),
      timeoutCode: 'reply_diagnose_timeout',
    });
  } catch (error) {
    error.replyDiagnoseStage = stage;
    error.replyDiagnoseFrameUrl = frameUrl;
    error.replyDiagnoseState = partialState;
    throw error;
  }
}

async function _openCommentEditor(contentFrame, postUrl, logNo, testMode, editorTimeoutMs = null) {
  const mounted = await mountCommentPanel(contentFrame, logNo, testMode);
  if (!mounted) {
    const snapshotPrefix = await saveCommentDebugSnapshot(contentFrame, { post_url: postUrl }, 'comment-panel-not-mounted');
    throw new Error(`comment_panel_not_mounted:${snapshotPrefix}`);
  }

  await waitForCommentPanel(contentFrame, logNo).catch(() => false);
  await humanDelay(1, 2, testMode);
  const editor = await focusCommentEditor(
    contentFrame,
    logNo,
    Number(editorTimeoutMs || 0) > 0 ? Number(editorTimeoutMs) : (testMode ? 10000 : 30000),
  );
  if (!editor?.selector) {
    throw new Error('comment_editor_not_found');
  }

  return editor;
}

async function _submitCommentWithVerification(contentFrame, page, editor, normalizedComment, config, testMode, postUrl) {
  await typeReply(contentFrame, page, editor.selector, normalizedComment, config, testMode);
  await humanDelay(1, 2, testMode);
  await submitComment(contentFrame);

  const posted = await verifyCommentPosted(contentFrame, normalizedComment, testMode);
  if (!posted) {
    const snapshotPrefix = await saveCommentDebugSnapshot(contentFrame, { post_url: postUrl }, 'comment-submit-not-confirmed');
    throw new Error(`comment_submit_not_confirmed:${snapshotPrefix}`);
  }
}

async function _openCommentEditorWithRetry(page, postUrl, logNo, testMode) {
  let contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) {
        traceCommenter('postComment:panel-retry', {
          postUrl,
          attempt: attempt + 1,
        });
        await goto(page, postUrl);
        contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
        await humanDelay(1, 2, testMode);
      }

      const editor = await _openCommentEditor(
        contentFrame,
        postUrl,
        logNo,
        testMode,
        attempt > 0 ? (testMode ? 12000 : 35000) : (testMode ? 10000 : 30000),
      );
      return { contentFrame, editor };
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const retryable =
        message.startsWith('comment_panel_not_mounted:')
        || message === 'comment_editor_not_found'
        || /Waiting failed: 15000ms exceeded/.test(message);
      if (!retryable || attempt > 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error('comment_panel_not_mounted');
}

async function _recordDirectCommentActions(postUrl, normalizedComment, withSympathy, sympathy) {
  const targetBlog = await resolveBlogId();

  await recordCommentAction('comment_post', {
    targetBlog,
    targetPostUrl: postUrl,
    commentText: normalizedComment,
    success: true,
    meta: { mode: 'direct_comment_test', withSympathy, sympathy },
  }).catch(() => {});

  if (!withSympathy || !sympathy?.ok) return;

  await recordCommentAction('comment_post_sympathy', {
    targetBlog,
    targetPostUrl: postUrl,
    success: true,
    meta: { mode: 'direct_comment_test', sympathy },
  }).catch(() => {});
}

async function postComment(postUrl, commentText, { testMode = false, withSympathy = false, operationTimeoutMs = 0 } = {}) {
  const config = getCommenterConfig();
  const targetPostUrl = resolveNavigablePostUrl(postUrl);
  const logNo = extractLogNo(targetPostUrl || postUrl);
  const normalizedComment = normalizeText(commentText);
  if (!normalizedComment) {
    throw new Error('comment_text_required');
  }

  return withBrowserPage(testMode, async (page) => {
    traceCommenter('postComment:start', {
      postUrl: targetPostUrl,
      withSympathy,
      textLength: normalizedComment.length,
    });
    await goto(page, targetPostUrl);
    let contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
    await humanDelay(1, 2, testMode);
    contentFrame = await waitForCommentCapableFrame(page, logNo, testMode);
    const opened = await _openCommentEditorWithRetry(page, targetPostUrl, logNo, testMode);
    contentFrame = opened.contentFrame;
    const editor = opened.editor;
    await _submitCommentWithVerification(contentFrame, page, editor, normalizedComment, config, testMode, targetPostUrl);
    traceCommenter('postComment:comment-posted', { postUrl: targetPostUrl, withSympathy });

    let sympathy = null;
    if (withSympathy) {
      await humanDelay(2, 3, testMode);
      sympathy = await activateSympathyInFrame(contentFrame, { testMode, postUrl: targetPostUrl }).catch((error) => ({ ok: false, error: error.message, attempt: 1 }));
      if (!sympathy?.ok) {
        traceCommenter('postComment:sympathy-retry', sympathy);
        await humanDelay(2, 4, testMode);
        sympathy = await activateSympathyInFrame(contentFrame, { testMode, postUrl: targetPostUrl }).catch((error) => ({ ok: false, error: error.message, attempt: 2 }));
      }
    }

    await _recordDirectCommentActions(targetPostUrl, normalizedComment, withSympathy, sympathy);

    traceCommenter('postComment:done', {
      postUrl: targetPostUrl,
      withSympathy,
      sympathyOk: sympathy?.ok === true,
    });
    return { ok: true, postUrl: targetPostUrl, commentText: normalizedComment, sympathy };
  }, {
    timeoutMs: Number(operationTimeoutMs || 0),
    timeoutCode: 'comment_post_timeout',
  });
}

async function processComment(comment, options = {}) {
  const alreadyReplied = await hasSuccessfulReplyForComment(comment);
  if (alreadyReplied) {
    await updateCommentStatus(comment.id, 'replied', {
      meta: { phase: 'dedupe', reason: 'existing_successful_reply' },
    });
    return { ok: false, skipped: true, reason: 'already_replied' };
  }

  const inboundAssessment = assessInboundComment(comment);
  if (!inboundAssessment.ok) {
    await updateCommentStatus(comment.id, 'skipped', {
      errorMessage: inboundAssessment.reason,
      meta: { phase: 'inbound_filter' },
    });
    return { ok: false, skipped: true, reason: inboundAssessment.reason };
  }

  const postInfo = await getPostSummary(comment.post_url, options);
  let generated = await generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
  let validation = validateReply(generated.reply, comment.comment_text);

  if (!validation.ok) {
    generated = await generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
    validation = validateReply(generated.reply, comment.comment_text);
  }

  if (!validation.ok) {
    await updateCommentStatus(comment.id, 'skipped', {
      errorMessage: validation.reason,
      meta: { phase: 'validate' },
    });
    return { ok: false, skipped: true, reason: validation.reason };
  }

  await postReply(comment, generated.reply, options);
  if (options?.testMode) {
    return { ok: true, dryRun: true, reply: generated.reply };
  }
  await updateCommentStatus(comment.id, 'replied', {
    replyText: generated.reply,
    meta: { tone: generated.tone || null },
  });
  await recordCommentAction('reply', {
    targetBlog: await resolveBlogId(),
    targetPostUrl: comment.post_url,
    commentText: generated.reply,
    success: true,
    meta: { commentId: comment.id, commenterName: comment.commenter_name || null },
  });
  return { ok: true, reply: generated.reply };
}

function _checkOpsAndWindow(config, { testMode = false, enabledForceEnv = '' } = {}) {
  const forceEnabled = enabledForceEnv === 'true';
  if (!env.IS_OPS && !process.env.BLOG_COMMENTER_ALLOW_DEV) {
    return { skipped: true, reason: 'ops_only' };
  }
  if (!config.enabled && !testMode && !forceEnabled) {
    return { skipped: true, reason: 'disabled' };
  }
  if (!testMode && !forceEnabled && !isWithinActiveWindow(config)) {
    return { skipped: true, reason: 'inactive_window' };
  }
  return null;
}

async function _postCommenterAlarm({ fromBot, alertLevel, message, shouldSend }) {
  if (!shouldSend) return;
  await postAlarm({
    team: 'blog',
    fromBot,
    alertLevel,
    message,
  }).catch(() => {});
}

async function runCommentReply({ testMode = false } = {}) {
  const config = getCommenterConfig();
  const guardResult = _checkOpsAndWindow(config, {
    testMode,
    enabledForceEnv: process.env.BLOG_COMMENTER_FORCE,
  });
  if (guardResult) return guardResult;

  await ensureSchema();

  const requeued = await requeueRecoverableReplyFailures(testMode ? 1 : 5).catch(() => 0);
  const courtesyBackfill = await requeueCourtesyReflectionCandidates(testMode ? 2 : 10, { dryRun: false }).catch(() => ({
    dryRun: false,
    reviewed: 0,
    requeuedCount: 0,
    candidates: [],
  }));
  const promotionalBackfill = await requeuePromotionalReplyCandidates(testMode ? 2 : 10, { dryRun: false }).catch(() => ({
    dryRun: false,
    reviewed: 0,
    requeuedCount: 0,
    candidates: [],
  }));

  const todayCount = await getTodayReplyCount();
  if (todayCount >= config.maxDaily) {
    return { skipped: true, reason: 'daily_limit', count: todayCount, requeued, courtesyBackfill, promotionalBackfill };
  }

  let newComments;
  try {
    newComments = await detectNewComments({ testMode });
  } catch (error) {
    if (testMode && ['managed_browser_not_running', 'managed_browser_required', 'managed_browser_not_ready'].includes(error?.code || error?.message)) {
      return { skipped: true, reason: error.code || error.message, testMode: true };
    }
    throw error;
  }
  const pending = await getPendingComments(Math.min(config.maxProcessPerCycle, testMode ? 1 : config.maxProcessPerCycle));
  const remaining = Math.max(0, config.maxDaily - todayCount);
  const targets = pending.slice(0, testMode ? 1 : remaining);

  let replied = 0;
  let failed = 0;
  let skipped = 0;

  for (const comment of targets) {
    try {
      const result = await processCommentWithTimeout(comment, { testMode });
      if (result.ok) replied += 1;
      else if (result.skipped) skipped += 1;
    } catch (error) {
      const uiError = isDirectReplyUiError(error);
      const rawErrorMessage = String(error?.message || 'reply_ui_unavailable');
      const summarizedUiError = uiError
        ? (
            rawErrorMessage.startsWith('reply_submit_not_confirmed:')
            || rawErrorMessage.startsWith('reply_button_not_found:')
            || rawErrorMessage === 'reply_editor_not_found'
          )
            ? rawErrorMessage
            : 'reply_ui_unavailable'
        : rawErrorMessage;
      if (uiError) {
        skipped += 1;
        await updateCommentStatus(comment.id, 'skipped', {
          errorMessage: summarizedUiError,
          meta: { phase: 'post', uiError: rawErrorMessage },
        });
      } else {
        failed += 1;
        await updateCommentStatus(comment.id, 'failed', {
          errorMessage: rawErrorMessage,
          meta: { phase: 'post' },
        });
      }
      await recordCommentAction('reply', {
        targetBlog: await resolveBlogId(),
        targetPostUrl: comment.post_url,
        commentText: comment.comment_text,
        success: false,
        meta: {
          commentId: comment.id,
          error: rawErrorMessage,
          terminalStatus: uiError ? 'skipped' : 'failed',
        },
      }).catch(() => {});
    }
  }

  const totalProcessed = replied + failed + skipped;
  const failureRate = totalProcessed > 0 ? failed / totalProcessed : 0;
  const exhaustedReplyWorkload = pending.length <= targets.length;
  const unmetReplyTarget = Math.max(0, remaining - replied);
  let externalFill = null;

  if (exhaustedReplyWorkload && unmetReplyTarget > 0) {
    externalFill = await runNeighborCommenter({
      testMode,
      limitOverride: testMode ? 1 : unmetReplyTarget,
      trigger: 'reply_gap_fill',
    }).catch((error) => ({
      ok: false,
      failed: true,
      reason: String(error?.message || error),
    }));
  }

  await _postCommenterAlarm({
    fromBot: 'blog-commenter',
    alertLevel: failureRate >= 0.5 ? 3 : 2,
    message: `답댓글 ${replied}건 완료, 실패 ${failed}건, 스킵 ${skipped}건 (오늘 총 ${todayCount + replied}/${config.maxDaily})${externalFill ? ` / 외부 댓글 보충 ${externalFill.posted || 0}건` : ''}`,
    shouldSend: replied > 0 || failed > 0,
  });

  return {
    ok: true,
    detected: newComments.length,
    pending: pending.length,
    replied,
    failed,
    skipped,
    total: todayCount + replied,
    requeued,
    courtesyBackfill,
    promotionalBackfill,
    exhaustedReplyWorkload,
    unmetReplyTarget,
    externalFill,
    testMode,
  };
}

async function _recordNeighborCommentSuccess(candidate, generated, posted) {
  await recordCommentAction('neighbor_comment', {
    targetBlog: candidate.target_blog_id,
    targetPostUrl: candidate.post_url,
    commentText: generated.comment,
    success: true,
    meta: {
      neighborCommentId: candidate.id,
      sourceType: candidate.source_type || null,
      targetBlogName: candidate.target_blog_name || null,
      tone: generated.tone || null,
    },
  });

  if (!posted?.sympathy?.ok) return;

  await recordCommentAction('neighbor_comment_sympathy', {
    targetBlog: candidate.target_blog_id,
    targetPostUrl: candidate.post_url,
    success: true,
    meta: {
      neighborCommentId: candidate.id,
      sourceType: candidate.source_type || null,
      targetBlogName: candidate.target_blog_name || null,
      sympathy: posted.sympathy,
    },
  });
}

async function processNeighborComment(candidate, { testMode = false } = {}) {
  const config = getNeighborCommenterConfig();
  traceCommenter('neighborComment:start', {
    candidateId: candidate.id,
    postUrl: candidate.post_url,
    sourceType: candidate.source_type || null,
    timeoutMs: config.processTimeoutMs,
  });
  const postInfo = await getPostSummary(candidate.post_url, { testMode });
  traceCommenter('neighborComment:summary-ready', {
    candidateId: candidate.id,
    summaryLength: String(postInfo.summary || '').length,
  });
  let generated = await generateNeighborComment(postInfo.title || candidate.post_title, postInfo.summary, candidate);
  let validation = validateNeighborCommentWithCandidate(generated.comment, postInfo.summary, candidate);

  if (!validation.ok && validation.reason === 'missing_specific_point') {
    generated = await generateNeighborComment(
      postInfo.title || candidate.post_title,
      postInfo.summary,
      candidate,
      buildNeighborSpecificityGuidance(postInfo.title || candidate.post_title, postInfo.summary),
    );
    validation = validateNeighborCommentWithCandidate(generated.comment, postInfo.summary, candidate);
  }

  if (!validation.ok) {
    traceCommenter('neighborComment:validation-failed', {
      candidateId: candidate.id,
      reason: validation.reason,
    });
    await updateNeighborCommentStatus(candidate.id, 'skipped', {
      commentText: generated.comment,
      errorMessage: validation.reason,
      meta: { phase: 'validate', tone: generated.tone || null },
    });
    return { ok: false, skipped: true, reason: validation.reason };
  }

  traceCommenter('neighborComment:posting', {
    candidateId: candidate.id,
    commentLength: String(generated.comment || '').length,
  });
  const posted = await postComment(candidate.post_url, generated.comment, {
    testMode,
    withSympathy: true,
    operationTimeoutMs: testMode ? Math.min(config.processTimeoutMs, 45000) : config.processTimeoutMs,
  });

  await updateNeighborCommentStatus(candidate.id, 'posted', {
    commentText: generated.comment,
    meta: { tone: generated.tone || null, sourceType: candidate.source_type || null },
  });
  await _recordNeighborCommentSuccess(candidate, generated, posted);
  traceCommenter('neighborComment:posted', {
    candidateId: candidate.id,
    sympathyOk: posted?.sympathy?.ok === true,
  });
  return { ok: true, comment: generated.comment, sympathy: posted?.sympathy || null };
}

async function runNeighborSympathy({ testMode = false } = {}) {
  const config = getNeighborCommenterConfig();
  const guardResult = _checkOpsAndWindow(config, {
    testMode,
    enabledForceEnv: process.env.BLOG_NEIGHBOR_COMMENTER_FORCE,
  });
  if (guardResult) return guardResult;

  await ensureSchema();

  const todayCount = await getTodayActionCount('neighbor_sympathy');
  if (todayCount >= config.maxDaily) {
    return { skipped: true, reason: 'daily_limit', count: todayCount };
  }

  const replySuccess = await getTodayReplyCount();
  const todayNeighborCommentCount = await getTodayNeighborCommentCount();
  const cadence = buildAdaptiveNeighborCadence(config, {
    replySuccess,
    neighborSuccess: todayNeighborCommentCount,
    sympathySuccess: todayCount,
  });
  const newCandidates = await collectNeighborCandidates({
    testMode,
    persist: false,
    collectLimit: testMode ? 1 : cadence.effectiveCollectLimit,
  });
  const remaining = Math.max(0, config.maxDaily - todayCount);
  const effectiveLimit = testMode ? 1 : Math.min(cadence.effectiveSympathyLimit, remaining);
  const targets = newCandidates.slice(0, effectiveLimit);

  let liked = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of targets) {
    try {
      const sympathy = await clickSympathy(candidate.postUrl, { testMode });
      await recordCommentAction('neighbor_sympathy', {
        targetBlog: candidate.targetBlogId,
        targetPostUrl: candidate.postUrl,
        success: true,
        meta: {
          sourceType: candidate.sourceType || null,
          targetBlogName: candidate.targetBlogName || null,
          sympathy,
        },
      });
      liked += 1;
    } catch (error) {
      failed += 1;
      await recordCommentAction('neighbor_sympathy', {
        targetBlog: candidate.targetBlogId,
        targetPostUrl: candidate.postUrl,
        success: false,
        meta: {
          sourceType: candidate.sourceType || null,
          targetBlogName: candidate.targetBlogName || null,
          error: error.message,
        },
      }).catch(() => {});
    }
  }

  await _postCommenterAlarm({
    fromBot: 'blog-neighbor-sympathy',
    alertLevel: failed > 0 ? 3 : 2,
    message: `이웃 공감 ${liked}건 완료, 실패 ${failed}건, 스킵 ${skipped}건 (오늘 총 ${todayCount + liked}/${config.maxDaily})`,
    shouldSend: liked > 0 || failed > 0,
  });

  return {
    ok: true,
    detected: newCandidates.length,
    pending: targets.length,
    liked,
    failed,
    skipped,
    total: todayCount + liked,
    adaptiveCadence: cadence,
    testMode,
  };
}

async function runNeighborCommenter({ testMode = false, limitOverride = 0, trigger = '' } = {}) {
  const config = getNeighborCommenterConfig();
  const guardResult = _checkOpsAndWindow(config, {
    testMode,
    enabledForceEnv: process.env.BLOG_NEIGHBOR_COMMENTER_FORCE,
  });
  if (guardResult) return guardResult;

  await ensureSchema();

  const todayCount = await getTodayNeighborCommentCount();
  const todaySympathyCount = await getTodayActionCount('neighbor_comment_sympathy');
  const replySuccess = await getTodayReplyCount();
  if (todayCount >= config.maxDaily) {
    return { skipped: true, reason: 'daily_limit', count: todayCount };
  }

  const cadence = buildAdaptiveNeighborCadence(config, {
    replySuccess,
    neighborSuccess: todayCount,
    sympathySuccess: todaySympathyCount,
  });
  const newCandidates = await collectNeighborCandidates({
    testMode,
    collectLimit: testMode ? 1 : cadence.effectiveCollectLimit,
  });
  const pending = await getPendingNeighborComments(Math.min(cadence.effectiveProcessLimit, testMode ? 1 : cadence.effectiveProcessLimit));
  const remaining = Math.max(0, config.maxDaily - todayCount);
  const requestedLimit = Number(limitOverride || 0) > 0
    ? Math.min(remaining, Number(limitOverride || 0))
    : Math.min(cadence.effectiveProcessLimit, remaining);
  const targets = pending.slice(0, testMode ? 1 : requestedLimit);
  traceCommenter('neighborComment:cycle', {
    detected: newCandidates.length,
    pending: pending.length,
    targets: targets.length,
    processTimeoutMs: config.processTimeoutMs,
    trigger,
    limitOverride: Number(limitOverride || 0),
    adaptiveCadence: cadence,
    testMode,
  });

  let posted = 0;
  let sympathized = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of targets) {
    try {
      const alreadyCommented = await hasSuccessfulNeighborCommentForPost(candidate.post_url);
      if (alreadyCommented) {
        skipped += 1;
        await updateNeighborCommentStatus(candidate.id, 'skipped', {
          errorMessage: 'already_commented_post',
          meta: { phase: 'preflight', sourceType: candidate.source_type || null },
        });
        traceCommenter('neighborComment:skip-duplicate-post', {
          candidateId: candidate.id,
          postUrl: candidate.post_url,
        });
        continue;
      }

      const startedAt = Date.now();
      const result = await processNeighborCommentWithTimeout(candidate, { testMode });
      if (result.ok) posted += 1;
      if (result?.sympathy?.ok) sympathized += 1;
      else if (result.skipped) skipped += 1;
      traceCommenter('neighborComment:done', {
        candidateId: candidate.id,
        ok: result.ok === true,
        skipped: result.skipped === true,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      const uiTimeout = isNeighborCommentUiTimeoutError(error);
      if (uiTimeout) {
        skipped += 1;
        await updateNeighborCommentStatus(candidate.id, 'skipped', {
          errorMessage: 'comment_ui_timeout',
          meta: {
            phase: 'post',
            sourceType: candidate.source_type || null,
            timeoutError: String(error?.message || ''),
          },
        });
      } else {
        failed += 1;
        await updateNeighborCommentStatus(candidate.id, 'failed', {
          errorMessage: error.message,
          meta: { phase: 'post', sourceType: candidate.source_type || null },
        });
      }
      await recordCommentAction('neighbor_comment', {
        targetBlog: candidate.target_blog_id,
        targetPostUrl: candidate.post_url,
        commentText: candidate.comment_text || null,
        success: false,
        meta: {
          neighborCommentId: candidate.id,
          error: error.message,
          terminalStatus: uiTimeout ? 'skipped' : 'failed',
        },
      }).catch(() => {});
      traceCommenter('neighborComment:failed', {
        candidateId: candidate.id,
        error: error.message,
        terminalStatus: uiTimeout ? 'skipped' : 'failed',
      });
    }
  }

  await _postCommenterAlarm({
    fromBot: 'blog-neighbor-commenter',
    alertLevel: failed > 0 ? 3 : 2,
    message: `이웃 댓글 ${posted}건 완료, 댓글 공감 ${sympathized}건 완료, 실패 ${failed}건, 스킵 ${skipped}건 (오늘 댓글 총 ${todayCount + posted}/${config.maxDaily}, 댓글공감 총 ${todaySympathyCount + sympathized})`,
    shouldSend: posted > 0 || failed > 0,
  });

  return {
    ok: true,
    detected: newCandidates.length,
    pending: pending.length,
    posted,
    sympathized,
    failed,
    skipped,
    total: todayCount + posted,
    sympathyTotal: todaySympathyCount + sympathized,
    trigger,
    limitOverride: Number(limitOverride || 0),
    adaptiveCadence: cadence,
    testMode,
  };
}

module.exports = {
  getCommenterConfig,
  getNeighborCommenterConfig,
  resolveBlogId,
  ensureSchema,
  detectNewComments,
  collectNeighborCandidates,
  generateReply,
  generateNeighborComment,
  validateReply,
  assessInboundComment,
  validateNeighborComment,
  validateNeighborCommentWithCandidate,
  getPostSummary,
  clickSympathy,
  postComment,
  postReply,
  diagnoseReplyUi,
  processComment,
  processCommentWithTimeout,
  requeueRecoverableReplyFailures,
  requeueCourtesyReflectionCandidates,
  requeuePromotionalReplyCandidates,
  runNeighborCommenter,
  runNeighborSympathy,
  runCommentReply,
};

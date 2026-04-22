#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildHttpChecks,
  buildFileActivityHealth,
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');
const { loadStrategyBundle, resolveExecutionTarget } = require('../lib/strategy-loader.ts');
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const {
  getInstagramImageHostConfig,
  resolveInstagramHostedMediaUrl,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const { checkFacebookPublishReadiness } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const { assessInboundComment } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/commenter.ts'));
const { readDevelopmentBaseline, buildSinceClause } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/dev-baseline.ts'));
const { readCommenterRunResult } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/commenter-run-telemetry.ts'));
const { readMarketingDigestTelemetry, describeMarketingDigestAge } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest-telemetry.ts'));

const CONTINUOUS = ['ai.blog.node-server'];
const ALL_SERVICES = ['ai.blog.daily', 'ai.blog.node-server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const BLOG_STRATEGY_PATH = path.join(BLOG_ROOT, 'output', 'strategy', 'latest-strategy.json');
const DAILY_LOG = path.join(BLOG_ROOT, 'blog-daily.log');
const SHORTFORM_DIR = path.join(BLOG_ROOT, 'output', 'shortform');
const INSTA_CARD_DIR = path.join(BLOG_ROOT, 'output', 'images', 'insta');
const runtimeConfig = getBlogHealthRuntimeConfig();
const DAILY_LOG_STALE_MS = Number(runtimeConfig.dailyLogStaleMs || (36 * 60 * 60 * 1000));
const NODE_SERVER_HEALTH_URL = runtimeConfig.nodeServerHealthUrl || 'http://127.0.0.1:3100/health';
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.n8nHealthUrl || 'http://127.0.0.1:5678/healthz';
const IMAGE_PROVIDER = String(process.env.BLOG_IMAGE_PROVIDER || 'drawthings').toLowerCase();
const IMAGE_BASE_URL = String(process.env.BLOG_IMAGE_BASE_URL || 'http://127.0.0.1:7860');
const DRAWTHINGS_HEALTH_URL = new URL('/sdapi/v1/options', IMAGE_BASE_URL.endsWith('/') ? IMAGE_BASE_URL : `${IMAGE_BASE_URL}/`).toString();
const DEFAULT_BLOG_WEBHOOK_URL = process.env.N8N_BLOG_WEBHOOK || runtimeConfig.blogWebhookUrl || 'http://127.0.0.1:5678/webhook/blog-pipeline';
const TEAM_JAY_ROOT = path.join(env.PROJECT_ROOT, 'elixir', 'team_jay');
const SOCIAL_ASSET_DUE_HOUR = Number(process.env.BLOG_SOCIAL_ASSET_DUE_HOUR || runtimeConfig.socialAssetDueHour || 7);
const FACEBOOK_READINESS_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`;
const FACEBOOK_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:facebook -- --json`;
const INSTAGRAM_READINESS_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:instagram -- --json`;
const INSTAGRAM_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:instagram -- --json`;
const SOCIAL_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:social -- --json`;
const ENGAGEMENT_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:engagement -- --json`;
const MARKETING_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:marketing -- --json`;
const BLOG_OPS_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:ops -- --json`;
const BLOG_NEIGHBOR_COLLECT_DIAG_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'neighbor-collect-diagnostics.json');
const BLOG_ENGAGEMENT_GAP_RUN_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'engagement-gap-run.json');
const BLOG_NEIGHBOR_REPLAY_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'neighbor-ui-replay.json');
const BLOG_NEIGHBOR_SYMPATHY_REPLAY_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'neighbor-sympathy-replay.json');

function nowKst() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function toKstDateString(value = null) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readNeighborCollectDiagnostics() {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_COLLECT_DIAG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readLastEngagementGapRun(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_ENGAGEMENT_GAP_RUN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const executedAt = Date.parse(String(parsed.executedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(executedAt) && Number.isFinite(baselineAt) && executedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function readNeighborUiReplay(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_REPLAY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const replayedAt = Date.parse(String(parsed.replayedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(replayedAt) && Number.isFinite(baselineAt) && replayedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function readNeighborSympathyReplay(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_SYMPATHY_REPLAY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const replayedAt = Date.parse(String(parsed.replayedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(replayedAt) && Number.isFinite(baselineAt) && replayedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractSympathyReplayTarget(replay = null) {
  const candidate = replay && typeof replay === 'object' ? replay.candidate || {} : {};
  return {
    postUrl: String(candidate.postUrl || '').trim(),
    targetBlogName: String(candidate.targetBlogName || '').trim(),
  };
}

function matchesSympathyReplayTarget(row = {}, replayTarget = {}) {
  const rowMeta = row && typeof row === 'object' ? row.meta || {} : {};
  const replayMeta = rowMeta && typeof rowMeta.replay === 'object' ? rowMeta.replay : {};
  const rowPostUrl = String(replayMeta.postUrl || rowMeta.postUrl || '').trim();
  const rowTargetBlogName = String(replayMeta.targetBlogName || rowMeta.targetBlogName || '').trim();
  if (replayTarget.postUrl && rowPostUrl && replayTarget.postUrl === rowPostUrl) return true;
  if (replayTarget.targetBlogName && rowTargetBlogName && replayTarget.targetBlogName === rowTargetBlogName) return true;
  return false;
}

function calcExpectedByWindow(target, startHour, endHour) {
  const numericTarget = Math.max(0, Number(target || 0));
  const start = Number(startHour || 0);
  const end = Number(endHour || 23);
  const now = nowKst();
  const currentHour = now.getHours() + (now.getMinutes() / 60);

  if (numericTarget <= 0 || end <= start) {
    return {
      target: numericTarget,
      expectedNow: 0,
      progressRatio: 0,
      active: false,
    };
  }

  if (currentHour <= start) {
    return {
      target: numericTarget,
      expectedNow: 0,
      progressRatio: 0,
      active: false,
    };
  }

  if (currentHour >= end) {
    return {
      target: numericTarget,
      expectedNow: numericTarget,
      progressRatio: 1,
      active: false,
    };
  }

  const progressRatio = clamp((currentHour - start) / (end - start), 0, 1);
  return {
    target: numericTarget,
    expectedNow: Math.ceil(numericTarget * progressRatio),
    progressRatio,
    active: true,
  };
}

function buildAdaptiveNeighborCadenceView({
  replySuccess = 0,
  neighborSuccess = 0,
  sympathySuccess = 0,
  replyPlan,
  neighborPlan,
  adaptiveEnabled = true,
  adaptiveMinGapToBoost = 2,
  adaptiveBoostCap = 12,
  adaptiveCollectBoostCap = 20,
  adaptiveSympathyBoostCap = 8,
  baseProcess = 20,
  baseCollect = 20,
} = {}) {
  const neighborDeficit = Math.max(0, Number(neighborPlan?.expectedNow || 0) - Number(neighborSuccess || 0));
  const sympathyDeficit = Math.max(0, Number(neighborPlan?.expectedNow || 0) - Number(sympathySuccess || 0));
  const combinedCommentSuccess = Number(replySuccess || 0) + Number(neighborSuccess || 0);
  const combinedCommentExpectedNow = Number(replyPlan?.expectedNow || 0) + Number(neighborPlan?.expectedNow || 0);
  const combinedCommentDeficit = Math.max(0, combinedCommentExpectedNow - combinedCommentSuccess);
  const drivingGap = Math.max(neighborDeficit, Math.min(Number(neighborPlan?.expectedNow || 0), combinedCommentDeficit));
  const shouldBoost = Boolean(adaptiveEnabled) && Boolean(neighborPlan?.active) && drivingGap >= Math.max(1, Number(adaptiveMinGapToBoost || 2));
  const processBoost = shouldBoost ? Math.min(Math.max(2, Number(adaptiveBoostCap || 12)), drivingGap) : 0;
  const collectBoost = shouldBoost ? Math.min(Math.max(2, Number(adaptiveCollectBoostCap || 20)), Math.max(processBoost, drivingGap * 2)) : 0;
  const sympathyBoost = Boolean(adaptiveEnabled) && Boolean(neighborPlan?.active) && sympathyDeficit >= Math.max(1, Number(adaptiveMinGapToBoost || 2))
    ? Math.min(Math.max(2, Number(adaptiveSympathyBoostCap || 8)), sympathyDeficit)
    : 0;
  return {
    enabled: Boolean(adaptiveEnabled),
    shouldBoost,
    combinedCommentSuccess,
    combinedCommentExpectedNow,
    combinedCommentDeficit,
    neighborDeficit,
    sympathyDeficit,
    processBoost,
    collectBoost,
    sympathyBoost,
    effectiveProcessLimit: Math.max(1, Number(baseProcess || 20)) + processBoost,
    effectiveCollectLimit: Math.max(1, Number(baseCollect || 20)) + collectBoost,
    effectiveSympathyLimit: Math.max(1, Number(baseProcess || 20)) + sympathyBoost,
  };
}

function classifyEngagementFailure(meta = {}) {
  const errorText = String(meta?.error || meta?.uiError || meta?.previous_error || '').trim();
  if (!errorText) {
    if (meta?.correction_reason === 'reply_verification_false_positive') return 'verification';
    return 'unknown';
  }

  if (
    errorText.includes('reply_button_not_found')
    || errorText.includes('reply_submit_not_found')
    || errorText.includes('reply_submit_not_confirmed')
    || errorText.includes('comment_submit_not_confirmed')
    || errorText.includes('sympathy_button_not_found')
    || errorText.includes('reply_ui_unavailable')
    || errorText.includes('reply_editor_not_found')
  ) {
    return 'ui';
  }

  if (
    errorText.includes('fetch failed')
    || errorText.includes('timeout')
    || errorText.includes('429')
    || errorText.includes('Claude Code')
    || errorText.includes('Groq')
  ) {
    return 'llm';
  }

  if (
    errorText.includes('ECONNREFUSED')
    || errorText.includes('__name is not defined')
    || errorText.includes('browser')
    || errorText.includes('ws 연결 실패')
  ) {
    return 'browser';
  }

  return 'unknown';
}

function summarizeEngagementFailure(meta = {}) {
  const raw = String(meta?.error || meta?.uiError || meta?.previous_error || meta?.message || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/snapshotPrefix[^,}\]]*/gi, 'snapshotPrefix')
    .slice(0, 140);
}

async function getNeighborRecoveryStatus(baseline = null) {
  const actionSinceClause = buildSinceClause('executed_at', baseline);
  try {
    const [latestSuccess, latestFailure] = await Promise.all([
      pgPool.get('blog', `
        SELECT executed_at
        FROM blog.comment_actions
        WHERE action_type = 'neighbor_comment'
          AND success = true
          ${actionSinceClause}
        ORDER BY executed_at DESC
        LIMIT 1
      `),
      pgPool.get('blog', `
        SELECT executed_at
        FROM blog.comment_actions
        WHERE action_type = 'neighbor_comment'
          AND success = false
          ${actionSinceClause}
        ORDER BY executed_at DESC
        LIMIT 1
      `),
    ]);
    const latestSuccessAt = latestSuccess?.executed_at ? new Date(latestSuccess.executed_at) : null;
    const latestFailureAt = latestFailure?.executed_at ? new Date(latestFailure.executed_at) : null;
    return {
      latestSuccessAt: latestSuccessAt ? latestSuccessAt.toISOString() : '',
      latestFailureAt: latestFailureAt ? latestFailureAt.toISOString() : '',
      recovered: Boolean(
        latestSuccessAt
        && latestFailureAt
        && latestSuccessAt.getTime() > latestFailureAt.getTime()
      ),
    };
  } catch {
    return { latestSuccessAt: '', latestFailureAt: '', recovered: false };
  }
}

function summarizeFacebookPublishFailure(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.includes('Facebook 페이지 게시 권한 부족:')) {
    return raw;
  }
  if (raw.includes('pages_manage_posts') || raw.includes('pages_read_engagement')) {
    /** @type {string[]} */
    const scopes = [];
    for (const scope of ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_metadata']) {
      if (raw.includes(scope) && !scopes.includes(scope)) scopes.push(scope);
    }
    if (scopes.length > 0) {
      return `Facebook 페이지 게시 권한 부족: ${scopes.join(', ')}`;
    }
  }
  return raw.slice(0, 120);
}

function extractJsonObjectText(output = '') {
  const text = String(output || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) return text;

  const jsonLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (jsonLine) return jsonLine;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function buildDoctorPriority(command = '', label = 'doctor') {
  if (!command) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  ${label}: command 미설정`],
      primaryArea: 'unknown',
      primaryReason: 'doctor command가 설정되지 않았습니다.',
      nextCommand: '',
      actionFocus: '',
    };
  }

  try {
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: BLOG_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText || '{}');
    const primary = payload?.primary || {};
    const primaryArea = String(primary.area || 'unknown');
    const hasActivePrimary = primaryArea !== 'clear' && primaryArea !== 'unknown';
    const latestDigestRun = payload?.latestDigestRun || null;
    const nextPreviewTitle = String(payload?.nextGeneralPreview?.title || '');
    const topRecommendation = Array.isArray(payload?.recommendations) ? String(payload.recommendations[0] || '') : '';
    const actions = Array.isArray(payload?.actions)
      ? payload.actions
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 2)
      : [];
    const ok = [
      `  ${label} primary: ${primaryArea} / ${String(primary.reason || '정보 없음')}`,
    ];
    if (hasActivePrimary && primary.nextCommand) ok.push(`  ${label} next: ${String(primary.nextCommand)}`);
    if (hasActivePrimary && primary.actionFocus) ok.push(`  ${label} focus: ${String(primary.actionFocus)}`);
    if (hasActivePrimary && primaryArea.startsWith('marketing') && latestDigestRun?.checkedAt) {
      const latestDigestAge = describeMarketingDigestAge(latestDigestRun);
      ok.push(`  ${label} latest digest: ${String(latestDigestRun.checkedAt).slice(0, 19)} / ${String(latestDigestRun.status || 'unknown')}${latestDigestAge.text ? ` / ${latestDigestAge.text}` : ''}`);
    }
    if (hasActivePrimary && primaryArea.startsWith('marketing') && nextPreviewTitle) {
      ok.push(`  ${label} next preview: ${nextPreviewTitle}`);
    }
    if (hasActivePrimary && primaryArea.startsWith('marketing') && topRecommendation) {
      ok.push(`  ${label} top reco: ${topRecommendation}`);
    }
    if (hasActivePrimary) {
      for (const action of actions) {
        ok.push(`  ${label} action: ${action}`);
      }
    }
    return {
      okCount: ok.length,
      warnCount: 0,
      ok,
      warn: [],
      primaryArea,
      primaryReason: String(primary.reason || '정보 없음'),
      nextCommand: hasActivePrimary ? String(primary.nextCommand || '') : '',
      actionFocus: hasActivePrimary ? String(primary.actionFocus || '') : '',
      latestDigestRun,
      nextPreviewTitle,
      topRecommendation,
      actions: hasActivePrimary ? actions : [],
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  ${label}: 확인 실패 (${reason})`],
      primaryArea: 'error',
      primaryReason: `${label} priority 확인 실패`,
      nextCommand: command,
      actionFocus: '',
      actions: [],
    };
  }
}

async function getCourtesyReflectionRecheck() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        id,
        commenter_name,
        LEFT(comment_text, 140) AS comment_text,
        detected_at
      FROM blog.comments
      WHERE detected_at >= now() - interval '14 days'
        AND status = 'skipped'
        AND COALESCE(error_message, '') = 'generic_greeting_comment'
      ORDER BY detected_at DESC
      LIMIT 25
    `);

    const reevaluable = [];
    for (const row of rows || []) {
      const reassessed = assessInboundComment({ comment_text: row.comment_text });
      if (reassessed?.ok && ['courtesy_reflection_allowed', 'generic_greeting_reply_allowed'].includes(String(reassessed?.reason || ''))) {
        reevaluable.push({
          id: row.id,
          commenterName: row.commenter_name,
          commentText: row.comment_text,
          detectedAt: row.detected_at,
          reassessedReason: reassessed.reason,
        });
      }
    }

    return {
      reviewedCount: Array.isArray(rows) ? rows.length : 0,
      reevaluableCount: reevaluable.length,
      reevaluableSamples: reevaluable.slice(0, 3),
    };
  } catch {
    return {
      reviewedCount: 0,
      reevaluableCount: 0,
      reevaluableSamples: [],
    };
  }
}

function countDatedFiles(dirPath = '', datePrefix = '') {
  try {
    if (!dirPath || !datePrefix || !fs.existsSync(dirPath)) return 0;
    const start = new Date(`${datePrefix}T00:00:00+09:00`);
    const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    return fs.readdirSync(dirPath).filter((name) => {
      const fullPath = path.join(dirPath, name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
      if (String(name).startsWith(datePrefix)) return true;
      const modifiedAt = stat.mtime instanceof Date ? stat.mtime : new Date(stat.mtime);
      return modifiedAt >= start && modifiedAt < end;
    }).length;
  } catch {
    return 0;
  }
}

function countDatedFilesBySuffix(dirPath = '', datePrefix = '', suffix = '') {
  try {
    if (!suffix) return countDatedFiles(dirPath, datePrefix);
    if (!dirPath || !datePrefix || !fs.existsSync(dirPath)) return 0;
    const start = new Date(`${datePrefix}T00:00:00+09:00`);
    const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    return fs.readdirSync(dirPath).filter((name) => {
      if (!String(name).endsWith(suffix)) return false;
      const fullPath = path.join(dirPath, name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
      if (String(name).startsWith(datePrefix)) return true;
      const modifiedAt = stat.mtime instanceof Date ? stat.mtime : new Date(stat.mtime);
      return modifiedAt >= start && modifiedAt < end;
    }).length;
  } catch {
    return 0;
  }
}

function getSocialAssetExpectation(now = nowKst()) {
  const dueHour = Number.isFinite(SOCIAL_ASSET_DUE_HOUR) ? SOCIAL_ASSET_DUE_HOUR : 7;
  const currentHour = now.getHours() + (now.getMinutes() / 60);
  return {
    dueHour,
    due: currentHour >= dueHour,
    timeLabel: `${String(dueHour).padStart(2, '0')}:00 KST`,
  };
}

async function buildNodeHealth() {
  const definitions = [
    {
      label: 'nodeServer',
      url: NODE_SERVER_HEALTH_URL,
      expectJson: true,
      timeoutMs: Number(runtimeConfig.nodeServerTimeoutMs || 3000),
      isOk: (data) => Boolean(data?.ok),
      okText: (data) => `  node-server API: 정상 (port ${data.port || 3100})`,
      warnText: '  node-server API: 응답 없음',
    },
    {
      label: 'n8n',
      url: N8N_HEALTH_URL,
      expectJson: true,
      timeoutMs: Number(runtimeConfig.n8nHealthTimeoutMs || 2500),
      isOk: (data) => data?.status === 'ok',
      okText: '  n8n healthz: 정상',
      warnText: '  n8n healthz: 응답 없음',
    },
  ];

  if (IMAGE_PROVIDER === 'drawthings' || IMAGE_PROVIDER === 'draw-things') {
    definitions.push({
      label: 'drawthings',
      url: DRAWTHINGS_HEALTH_URL,
      expectJson: true,
      timeoutMs: 2500,
      isOk: (data) => Boolean(data && typeof data === 'object'),
      okText: `  drawthings API: 정상 (${new URL(DRAWTHINGS_HEALTH_URL).host})`,
      warnText: `  drawthings API: 응답 없음 (${new URL(DRAWTHINGS_HEALTH_URL).host})`,
    });
  }

  const checks = await buildHttpChecks(definitions);
  const drawthingsConfigured = IMAGE_PROVIDER === 'drawthings' || IMAGE_PROVIDER === 'draw-things';
  const drawthingsOk = drawthingsConfigured
    ? Boolean(checks.results.drawthings && typeof checks.results.drawthings === 'object')
    : null;

  return {
    ok: checks.ok,
    warn: checks.warn,
    nodeServerOk: Boolean(checks.results.nodeServer?.ok),
    n8nOk: checks.results.n8n?.status === 'ok',
    drawthingsOk,
  };
}

function buildDailyRunHealth(dailyServiceStatus = null) {
  const base = buildFileActivityHealth({
    label: 'daily log',
    filePath: DAILY_LOG,
    staleMs: DAILY_LOG_STALE_MS,
    missingText: '  daily log: 파일 없음',
    staleText: (state) => `  daily log: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  daily log: 최근 ${state.minutesAgo}분 이내 활동`,
  });

  const serviceLooksScheduledOnly =
    dailyServiceStatus &&
    dailyServiceStatus.loaded === true &&
    dailyServiceStatus.running === false &&
    Number(dailyServiceStatus.exitCode || 0) === 0;

  if (!serviceLooksScheduledOnly || !Array.isArray(base.warn) || base.warn.length === 0) {
    return base;
  }

  return {
    ...base,
    warn: [
      `  daily log: ${base.minutesAgo}분 무활동 (launchd는 정상 등록, 재부팅 후 오늘 캘린더 실행을 놓쳤을 가능성)`,
    ],
  };
}

async function buildN8nPipelineHealth() {
  return buildResolvedWebhookHealth({
    workflowName: '블로그팀 동적 포스팅',
    pathSuffix: 'blog-pipeline',
    healthUrl: N8N_HEALTH_URL,
    defaultWebhookUrl: DEFAULT_BLOG_WEBHOOK_URL,
    probeBody: {
      postType: 'general',
      sessionId: 'n8n-blog-health-probe',
      pipeline: ['weather'],
      variations: {},
    },
    okLabel: 'blog pipeline webhook',
    warnLabel: 'blog pipeline webhook',
    timeoutMs: Number(runtimeConfig.webhookTimeoutMs || 5000),
  });
}

async function buildBookCatalogHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE source = 'canonical'), 0)::int AS canonical_count,
        COALESCE(count(*) FILTER (WHERE source = 'data4library'), 0)::int AS popular_count
      FROM blog.book_catalog
    `);
    const row = rows?.[0] || { total_count: 0, canonical_count: 0, popular_count: 0 };
    const ok = [
      `  book_catalog: ${row.total_count}권`,
      `  canonical: ${row.canonical_count}권`,
      `  data4library popular: ${row.popular_count}권`,
      '  note: 정보나루 승인 전에는 popular 0건이 자연스러울 수 있음',
    ];
    return {
      okCount: ok.length,
      warnCount: 0,
      ok,
      warn: [],
      totalCount: Number(row.total_count || 0),
      canonicalCount: Number(row.canonical_count || 0),
      popularCount: Number(row.popular_count || 0),
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  book_catalog: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      canonicalCount: 0,
      popularCount: 0,
    };
  } finally {
    await pgPool.closeAll().catch(() => {});
  }
}

async function buildBookReviewQueueHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE status = 'queued'), 0)::int AS queued_count,
        COALESCE(count(*) FILTER (WHERE queue_date = CURRENT_DATE), 0)::int AS today_count
      FROM blog.book_review_queue
    `);
    const row = rows?.[0] || { total_count: 0, queued_count: 0, today_count: 0 };
    const ok = [
      `  book_review_queue: ${row.total_count}건`,
      `  queued: ${row.queued_count}건`,
      `  today: ${row.today_count}건`,
    ];
    return {
      okCount: ok.length,
      warnCount: 0,
      ok,
      warn: [],
      totalCount: Number(row.total_count || 0),
      queuedCount: Number(row.queued_count || 0),
      todayCount: Number(row.today_count || 0),
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  book_review_queue: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      queuedCount: 0,
      todayCount: 0,
    };
  }
}

async function buildAutonomyHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE decision = 'auto_publish'), 0)::int AS auto_publish_count,
        COALESCE(count(*) FILTER (WHERE decision = 'master_review'), 0)::int AS master_review_count,
        COALESCE(max(autonomy_phase), 1)::int AS max_phase
      FROM blog.autonomy_decisions
      WHERE created_at >= NOW() - INTERVAL '14 days'
        AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
    `);
    const latest = await pgPool.get('blog', `
      SELECT post_type, category, title, decision, autonomy_phase, score, threshold, created_at
      FROM blog.autonomy_decisions
      WHERE COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = rows?.[0] || {
      total_count: 0,
      auto_publish_count: 0,
      master_review_count: 0,
      max_phase: 1,
    };

    const ok = [
      `  recent decisions: ${row.total_count}건`,
      `  auto publish: ${row.auto_publish_count}건`,
      `  master review: ${row.master_review_count}건`,
      `  max phase: ${row.max_phase}`,
    ];

    if (latest?.title) {
      ok.push(
        `  latest: ${latest.post_type}/${latest.decision} (${String(latest.title).slice(0, 60)})`,
      );
    }

    const warn = [];
    if (Number(row.total_count || 0) === 0) {
      warn.push('  autonomy decisions: 아직 축적 전');
    }

    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      totalCount: Number(row.total_count || 0),
      autoPublishCount: Number(row.auto_publish_count || 0),
      masterReviewCount: Number(row.master_review_count || 0),
      maxPhase: Number(row.max_phase || 1),
      latestDecision: latest || null,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  autonomy: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      autoPublishCount: 0,
      masterReviewCount: 0,
      maxPhase: 1,
      latestDecision: null,
    };
  }
}

async function buildInstagramHealth() {
  try {
    const config = await getInstagramConfig();
    const host = getInstagramImageHostConfig();
    const {
      readInstagramTokenAutoRefreshResult,
      AUTO_REFRESH_SCHEDULE_TEXT,
    } = require('../lib/instagram-token-automation.ts');
    const hostReady = Boolean(host.publicBaseUrl || host.githubPagesBaseUrl || host.opsStaticBaseUrl);
    const health = config.tokenHealth || {};
    const autoRefresh = readInstagramTokenAutoRefreshResult();
    const ok = [
      `  instagram token: ${health.hasAccessToken && health.hasIgUserId ? '준비됨' : '누락'}`,
      `  token expires: ${health.tokenExpiresAt || '미설정'}`,
      `  token auto refresh: ${AUTO_REFRESH_SCHEDULE_TEXT}`,
      `  public host: ${hostReady ? `${host.mode || 'configured'} 준비됨` : '미설정'}`,
    ];
    if (autoRefresh?.checkedAt) {
      ok.push(`  auto refresh last run: ${autoRefresh.checkedAt} / ${autoRefresh.mode || 'unknown'} / ${autoRefresh.ok ? 'ok' : 'failed'}`);
    }
    const warn = [];
    if (health.critical) warn.push(`  인스타 토큰 만료 임박: ${health.daysLeft}일 남음`);
    else if (health.needsRefresh) warn.push(`  인스타 토큰 갱신 권장: ${health.daysLeft}일 남음`);
    if (!hostReady) warn.push('  공개 미디어 호스팅 URL이 없어 릴스 업로드를 진행할 수 없습니다');
    if (autoRefresh?.checkedAt && autoRefresh.ok === false) {
      warn.push(`  최근 auto refresh 실패: ${String(autoRefresh.reason || 'unknown')}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      needsRefresh: Boolean(health.needsRefresh),
      critical: Boolean(health.critical),
      hostReady,
      autoRefresh: autoRefresh
        ? {
            checkedAt: autoRefresh.checkedAt || null,
            mode: autoRefresh.mode || 'unknown',
            ok: Boolean(autoRefresh.ok),
            reason: String(autoRefresh.reason || ''),
            schedule: autoRefresh.schedule || AUTO_REFRESH_SCHEDULE_TEXT,
          }
        : {
            checkedAt: null,
            mode: 'unknown',
            ok: true,
            reason: '',
            schedule: AUTO_REFRESH_SCHEDULE_TEXT,
          },
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  instagram: 확인 실패 (${error.message.slice(0, 120)})`],
      needsRefresh: false,
      critical: false,
      hostReady: false,
      autoRefresh: {
        checkedAt: null,
        mode: 'unknown',
        ok: false,
        reason: String(error.message || error),
        schedule: '매일 05:40, 17:40 KST',
      },
    };
  }
}

async function buildSocialAutomationHealth() {
  const now = nowKst();
  const todayPrefix = toKstDateString(now);
  const socialAssetExpectation = getSocialAssetExpectation(now);
  const reelCountToday = countDatedFiles(SHORTFORM_DIR, todayPrefix);
  const reelQaCountToday = countDatedFilesBySuffix(SHORTFORM_DIR, todayPrefix, '_qa.jpg');
  const instaCardCountToday = countDatedFiles(INSTA_CARD_DIR, todayPrefix);

  try {
    const [instagramRows, publishLogMeta, publishLogRows, facebookReadiness] = await Promise.all([
      pgPool.query('blog', `
        SELECT status, dry_run, error_msg, post_title, created_at
        FROM blog.instagram_crosspost
        ORDER BY created_at DESC
        LIMIT 8
      `),
      pgPool.get('blog', `SELECT to_regclass('blog.publish_log') IS NOT NULL AS exists`),
      pgPool.query('blog', `
        SELECT platform, status, title, error, dry_run, created_at
        FROM blog.publish_log
        ORDER BY created_at DESC
        LIMIT 8
      `).catch(() => []),
      checkFacebookPublishReadiness().catch((error) => ({
        ready: false,
        permissionScopes: [],
        error: String(error?.message || error),
      })),
    ]);

    const ok = [
      `  shortform reels today: ${reelCountToday}개`,
      `  reel QA sheets today: ${reelQaCountToday}개`,
      `  instagram cards today: ${instaCardCountToday}개`,
    ];
    const warn = [];

    const instaList = Array.isArray(instagramRows) ? instagramRows : [];
    const instaSummary = { success: 0, failed: 0, skipped: 0, dryRun: 0 };
    const instaTodaySummary = { success: 0, failed: 0, skipped: 0, dryRun: 0 };
    for (const row of instaList) {
      const status = String(row.status || '');
      const isTodayKst = toKstDateString(row.created_at) === todayPrefix;
      if (status === 'success') instaSummary.success += 1;
      else if (status === 'failed') instaSummary.failed += 1;
      else if (status === 'skipped') instaSummary.skipped += 1;
      if (row.dry_run) instaSummary.dryRun += 1;
      if (isTodayKst) {
        if (status === 'success') instaTodaySummary.success += 1;
        else if (status === 'failed') instaTodaySummary.failed += 1;
        else if (status === 'skipped') instaTodaySummary.skipped += 1;
        if (row.dry_run) instaTodaySummary.dryRun += 1;
      }
    }
    const latestInstagram = instaList[0] || null;
    const latestRealInstagram = instaList.find((row) => !row.dry_run) || null;
    const latestRealInstagramIsToday = latestRealInstagram
      ? toKstDateString(latestRealInstagram.created_at) === todayPrefix
      : false;
    const latestRealInstagramTitle = String(latestRealInstagram?.post_title || '');
    const latestRealInstagramError = String(latestRealInstagram?.error_msg || '');
    let latestRealHostedRecovery = false;
    try {
      const { findReelPathForTitle } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
      const latestRealReelPath = latestRealInstagramTitle ? findReelPathForTitle(latestRealInstagramTitle) : '';
      const latestRealHosted = latestRealReelPath
        ? resolveInstagramHostedMediaUrl(latestRealReelPath, { kind: 'reels' })
        : null;
      latestRealHostedRecovery = Boolean(
        latestRealHosted?.ready === true
        && (
          latestRealInstagramError.includes('Instagram 공개 비디오 파일이 아직 준비되지 않았습니다')
          || latestRealInstagramError.includes('Instagram 공개 비디오 URL이 아직 응답하지 않습니다')
        )
      );
    } catch {
      latestRealHostedRecovery = false;
    }
    const latestQaSheet = fs.existsSync(SHORTFORM_DIR)
      ? fs.readdirSync(SHORTFORM_DIR)
        .filter((name) => name.endsWith('_qa.jpg'))
        .map((name) => path.join(SHORTFORM_DIR, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
      : null;
    const latestReel = fs.existsSync(SHORTFORM_DIR)
      ? fs.readdirSync(SHORTFORM_DIR)
        .filter((name) => name.endsWith('_reel.mp4'))
        .map((name) => path.join(SHORTFORM_DIR, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
      : null;
    const latestCover = latestReel
      ? latestReel.replace(/\.mp4$/i, '_cover.jpg')
      : null;
    const latestCoverExists = Boolean(latestCover && fs.existsSync(latestCover));
    const latestReelHosted = latestReel
      ? resolveInstagramHostedMediaUrl(latestReel, { kind: 'reels' })
      : null;
    const latestCoverHosted = latestCoverExists
      ? resolveInstagramHostedMediaUrl(latestCover, { kind: 'thumbs' })
      : null;
    const latestQaHosted = latestQaSheet
      ? resolveInstagramHostedMediaUrl(latestQaSheet, { kind: 'thumbs' })
      : null;

    let latestInstagramHostedRecovery = false;
    if (instaList.length > 0) {
      ok.push(`  instagram recent: success ${instaSummary.success} / failed ${instaSummary.failed} / skipped ${instaSummary.skipped} (dry-run ${instaSummary.dryRun})`);
      ok.push(`  instagram latest: ${String(latestInstagram.status || 'unknown')} / ${String(latestInstagram.post_title || '').slice(0, 50)}`);
      ok.push(`  instagram today: success ${instaTodaySummary.success} / failed ${instaTodaySummary.failed} / skipped ${instaTodaySummary.skipped} (dry-run ${instaTodaySummary.dryRun})`);
      ok.push(`  instagram readiness command: ${INSTAGRAM_READINESS_COMMAND}`);
      ok.push(`  instagram doctor command: ${INSTAGRAM_DOCTOR_COMMAND}`);
      ok.push(`  social doctor command: ${SOCIAL_DOCTOR_COMMAND}`);
      ok.push(`  ops doctor command: ${BLOG_OPS_DOCTOR_COMMAND}`);
      if (latestRealInstagram) {
        ok.push(`  instagram latest real: ${String(latestRealInstagram.status || 'unknown')} / ${String(latestRealInstagram.post_title || '').slice(0, 50)}`);
      }
      latestInstagramHostedRecovery = latestInstagram && !latestInstagram.dry_run
        ? Boolean(
            latestRealHostedRecovery
            || (
              String(latestInstagram.error_msg || '').includes('Instagram 공개 비디오 URL이 아직 응답하지 않습니다')
              && latestRealInstagram
              && String(latestRealInstagram.post_title || '') === String(latestInstagram.post_title || '')
              && latestRealHostedRecovery
            )
          )
        : false;
      if (String(latestInstagram.status || '') === 'failed' && !latestInstagram.dry_run && !latestInstagramHostedRecovery) {
        warn.push(`  instagram latest failed: ${String(latestInstagram.error_msg || '').slice(0, 120)}`);
        warn.push(`  instagram diagnose: ${INSTAGRAM_READINESS_COMMAND}`);
        warn.push(`  instagram doctor: ${INSTAGRAM_DOCTOR_COMMAND}`);
      } else if (
        (latestInstagram && String(latestInstagram.status || '') === 'failed' && !latestInstagram.dry_run && latestInstagramHostedRecovery)
        || (latestRealInstagram && String(latestRealInstagram.status || '') === 'failed' && latestRealInstagramIsToday && latestRealHostedRecovery)
      ) {
        ok.push(`  instagram hosted recovery: ${String(latestRealInstagram.post_title || '').slice(0, 50)} / 공개 URL 현재 정상`);
      } else if (latestRealInstagram && String(latestRealInstagram.status || '') === 'failed' && latestRealInstagramIsToday) {
        warn.push(`  instagram today failed: ${String(latestRealInstagram.error_msg || '').slice(0, 120)}`);
        warn.push(`  instagram diagnose: ${INSTAGRAM_READINESS_COMMAND}`);
        warn.push(`  instagram doctor: ${INSTAGRAM_DOCTOR_COMMAND}`);
      } else if (latestRealInstagram && String(latestRealInstagram.status || '') === 'failed') {
        ok.push(`  instagram stale failure: ${toKstDateString(latestRealInstagram.created_at)} / 현재는 dry-run skip 기준`);
      }
    } else {
      warn.push('  instagram crosspost history: 아직 없음');
    }

    if (latestQaSheet) {
      ok.push(`  reel latest qa: ${path.basename(latestQaSheet)}`);
      if (latestQaHosted?.publicUrl) {
        ok.push(`  reel latest qa url: ${latestQaHosted.publicUrl}`);
      }
    } else if (reelCountToday > 0) {
      warn.push('  reel qa sheet: 오늘 릴스 QA 시트가 없습니다');
    }
    if (latestReel) {
      const bundleParts = [
        `reel=${path.basename(latestReel)}`,
        `cover=${latestCoverExists ? path.basename(latestCover) : 'missing'}`,
        `qa=${latestQaSheet ? path.basename(latestQaSheet) : 'missing'}`,
      ];
      ok.push(`  reel preview bundle: ${bundleParts.join(' / ')}`);
      const bundleUrlParts = [
        latestReelHosted?.publicUrl ? `reel=${latestReelHosted.publicUrl}` : '',
        latestCoverHosted?.publicUrl ? `cover=${latestCoverHosted.publicUrl}` : '',
        latestQaHosted?.publicUrl ? `qa=${latestQaHosted.publicUrl}` : '',
      ].filter(Boolean);
      if (bundleUrlParts.length > 0) {
        ok.push(`  reel preview urls: ${bundleUrlParts.join(' / ')}`);
      }
    }

    const publishLogExists = Boolean(publishLogMeta?.exists);
    let latestFacebookStatus = null;
    let latestFacebookErrorSummary = '';
    let facebookNeedsAttention = false;
    let facebookPageId = String(facebookReadiness?.pageId || '');
    let facebookPermissionScopes = Array.isArray(facebookReadiness?.permissionScopes)
      ? facebookReadiness.permissionScopes
      : [];
    const facebookReadinessErrorSummary = facebookReadiness?.error
      ? summarizeFacebookPublishFailure(facebookReadiness.error || '')
      : '';
    if (!publishLogExists) {
      warn.push('  facebook publish telemetry: blog.publish_log 테이블 없음');
    } else {
      const publishRows = Array.isArray(publishLogRows) ? publishLogRows : [];
      const facebookRows = publishRows.filter((row) => String(row.platform || '') === 'facebook');
      if (facebookReadiness?.ready) {
        ok.push(`  facebook readiness: ready / page ${String(facebookReadiness.pageId || '').slice(0, 24)}`);
        if (facebookPageId) {
        ok.push(`  facebook page id: ${facebookPageId}`);
        }
        ok.push(`  facebook readiness command: ${FACEBOOK_READINESS_COMMAND}`);
        ok.push(`  facebook doctor command: ${FACEBOOK_DOCTOR_COMMAND}`);
        ok.push(`  social doctor command: ${SOCIAL_DOCTOR_COMMAND}`);
        ok.push(`  ops doctor command: ${BLOG_OPS_DOCTOR_COMMAND}`);
      } else if (facebookReadiness?.error) {
        warn.push(`  facebook readiness: ${facebookReadinessErrorSummary}`);
        if (facebookPageId) {
          warn.push(`  facebook page id: ${facebookPageId}`);
        }
        if (facebookPermissionScopes.length > 0) {
          warn.push(`  facebook missing scopes: ${facebookPermissionScopes.join(', ')}`);
        }
        warn.push(`  facebook readiness command: ${FACEBOOK_READINESS_COMMAND}`);
        warn.push(`  facebook doctor command: ${FACEBOOK_DOCTOR_COMMAND}`);
        warn.push(`  social doctor command: ${SOCIAL_DOCTOR_COMMAND}`);
        warn.push(`  ops doctor command: ${BLOG_OPS_DOCTOR_COMMAND}`);
        facebookNeedsAttention = true;
        latestFacebookErrorSummary = latestFacebookErrorSummary || facebookReadinessErrorSummary;
      }
      if (facebookRows.length > 0) {
        const latestFacebook = facebookRows[0];
        latestFacebookStatus = String(latestFacebook.status || 'unknown');
        ok.push(`  facebook latest: ${String(latestFacebook.status || 'unknown')} / ${String(latestFacebook.title || '').slice(0, 50)}`);
        if (String(latestFacebook.status || '') === 'failed') {
          const summarizedFacebookError = summarizeFacebookPublishFailure(latestFacebook.error || '');
          latestFacebookErrorSummary = summarizedFacebookError;
          facebookNeedsAttention = true;
          if (summarizedFacebookError.includes('pages_manage_posts')) {
            facebookPermissionScopes = ['pages_manage_posts', 'pages_read_engagement'];
          }
          warn.push(`  facebook latest failed: ${summarizedFacebookError}`);
          if (summarizedFacebookError.includes('Facebook 페이지 게시 권한 부족:')) {
            if (facebookPermissionScopes.length > 0) {
              warn.push(`  facebook missing scopes: ${facebookPermissionScopes.join(', ')}`);
            }
            warn.push('  facebook action: Meta 앱에 pages_manage_posts, pages_read_engagement 권한을 다시 연결하세요');
            warn.push(`  facebook diagnose: ${FACEBOOK_READINESS_COMMAND}`);
            warn.push(`  facebook doctor: ${FACEBOOK_DOCTOR_COMMAND}`);
          }
        }
      } else {
        warn.push('  facebook publish history: 아직 없음');
      }
    }

    if (reelCountToday <= 0) {
      if (socialAssetExpectation.due) {
        warn.push('  shortform reels today: 오늘 생성 산출물이 없습니다');
      } else {
        ok.push(`  shortform reels today: 아직 생성 대기 (${socialAssetExpectation.timeLabel} 이후 점검)`);
      }
    }
    if (reelQaCountToday <= 0 && reelCountToday > 0) {
      warn.push('  reel QA sheets today: 릴스는 있으나 QA 시트가 없습니다');
    }
    if (instaCardCountToday <= 0) {
      if (socialAssetExpectation.due) {
        warn.push('  instagram cards today: 오늘 생성 산출물이 없습니다');
      } else {
        ok.push(`  instagram cards today: 아직 생성 대기 (${socialAssetExpectation.timeLabel} 이후 점검)`);
      }
    }

    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      reelCountToday,
      reelQaCountToday,
      instaCardCountToday,
      instagramRecent: instaSummary,
      instagramToday: instaTodaySummary,
      latestRealInstagramStatus: latestRealInstagram ? String(latestRealInstagram.status || 'unknown') : null,
      latestRealInstagramIsToday,
      latestRealHostedRecovery,
      instagramNeedsAttention: Boolean(
        (latestInstagram && String(latestInstagram.status || '') === 'failed' && !latestInstagram.dry_run && !latestInstagramHostedRecovery)
        || (latestRealInstagram && String(latestRealInstagram.status || '') === 'failed' && latestRealInstagramIsToday && !latestRealHostedRecovery)
      ),
      facebookReadiness: facebookReadiness || null,
      latestFacebookStatus,
      latestFacebookErrorSummary,
      facebookNeedsAttention,
      facebookPageId,
      facebookPermissionScopes,
      socialAssetDue: socialAssetExpectation.due,
      socialAssetDueHour: socialAssetExpectation.dueHour,
      publishLogExists,
      latestReel: latestReel || null,
      latestCover: latestCoverExists ? latestCover : null,
      latestQaSheet,
      latestReelUrl: latestReelHosted?.publicUrl || null,
      latestCoverUrl: latestCoverHosted?.publicUrl || null,
      latestQaUrl: latestQaHosted?.publicUrl || null,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  social automation: 확인 실패 (${String(error.message || error).slice(0, 120)})`],
      reelCountToday,
      reelQaCountToday,
      instaCardCountToday,
      instagramRecent: { success: 0, failed: 0, skipped: 0, dryRun: 0 },
      instagramToday: { success: 0, failed: 0, skipped: 0, dryRun: 0 },
      latestRealInstagramStatus: null,
      latestRealInstagramIsToday: false,
      latestRealHostedRecovery: false,
      instagramNeedsAttention: false,
      facebookReadiness: null,
      latestFacebookStatus: null,
      latestFacebookErrorSummary: '',
      facebookNeedsAttention: false,
      facebookPageId: '',
      facebookPermissionScopes: [],
      socialAssetDue: getSocialAssetExpectation().due,
      socialAssetDueHour: getSocialAssetExpectation().dueHour,
      publishLogExists: false,
      latestReel: null,
      latestCover: null,
      latestQaSheet: null,
      latestReelUrl: null,
      latestCoverUrl: null,
      latestQaUrl: null,
    };
  }
}

async function buildEngagementHealth() {
  try {
    const developmentBaseline = readDevelopmentBaseline();
    const lastGapRun = readLastEngagementGapRun(developmentBaseline);
    const neighborUiReplay = readNeighborUiReplay(developmentBaseline);
    const neighborSympathyReplay = readNeighborSympathyReplay(developmentBaseline);
    const sympathyReplayReason = String(
      neighborSympathyReplay?.result?.reason
      || neighborSympathyReplay?.result?.error
      || neighborSympathyReplay?.error
      || ''
    ).trim();
    const sympathyReplayConfirmsSkip = sympathyReplayReason === 'sympathy_module_unavailable';
    const latestSympathyReplayAt = (neighborSympathyReplay?.result?.ok || sympathyReplayConfirmsSkip) && neighborSympathyReplay?.replayedAt
      ? new Date(neighborSympathyReplay.replayedAt)
      : null;
    const sympathyReplayTarget = extractSympathyReplayTarget(neighborSympathyReplay);
    const actionSinceClause = buildSinceClause('executed_at', developmentBaseline);
    const commentSinceClause = buildSinceClause('detected_at', developmentBaseline);
    const replyConfig = runtimeConfig.commenter || {};
    const neighborConfig = runtimeConfig.neighborCommenter || {};

    const [actionAggRows, failureMetaRows, commentRows, neighborRows, latestReplyReplayCandidate, skippedReasonRows, skippedReason14dRows, latestCommentRow, courtesyReflectionRecheck, pendingBacklogRow, neighborRecovery] = await Promise.all([
      pgPool.query('blog', `
        SELECT action_type, success, COUNT(*)::int AS cnt
        FROM blog.comment_actions
        WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
          ${actionSinceClause}
        GROUP BY 1, 2
      `),
      pgPool.query('blog', `
        SELECT action_type, meta, executed_at
        FROM blog.comment_actions
        WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
          AND success = false
          ${actionSinceClause}
        ORDER BY executed_at DESC
        LIMIT 50
      `),
      pgPool.query('blog', `
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(CASE WHEN reply_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS replied,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          ${commentSinceClause}
      `),
      pgPool.query('blog', `
        SELECT status, COUNT(*)::int AS cnt
        FROM blog.neighbor_comments
        WHERE timezone('Asia/Seoul', created_at)::date = timezone('Asia/Seoul', now())::date
          ${commentSinceClause.replace(/detected_at/g, 'created_at')}
        GROUP BY 1
      `),
      pgPool.get('blog', `
        SELECT
          c.id,
          c.status,
          c.commenter_name,
          c.post_url,
          LEFT(c.comment_text, 80) AS comment_text,
          a.executed_at,
          true AS from_failure
        FROM blog.comment_actions a
        JOIN blog.comments c
          ON (a.meta->>'commentId')::int = c.id
        WHERE a.action_type = 'reply'
          AND a.success = false
          ${buildSinceClause('a.executed_at', developmentBaseline)}
        ORDER BY a.executed_at DESC
        LIMIT 1
      `).then((row) => row || pgPool.get('blog', `
        SELECT
          id,
          status,
          commenter_name,
          post_url,
          LEFT(comment_text, 80) AS comment_text,
          detected_at AS executed_at,
          false AS from_failure
        FROM blog.comments
        WHERE detected_at >= now() - interval '7 days'
          ${commentSinceClause}
        ORDER BY detected_at DESC
        LIMIT 1
      `)),
      pgPool.query('blog', `
        SELECT COALESCE(error_message, '') AS reason, COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          AND status = 'skipped'
          ${commentSinceClause}
        GROUP BY 1
        ORDER BY cnt DESC, reason ASC
        LIMIT 5
      `),
      pgPool.query('blog', `
        SELECT COALESCE(error_message, '') AS reason, COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE detected_at >= now() - interval '14 days'
          AND status = 'skipped'
          ${commentSinceClause}
        GROUP BY 1
        ORDER BY cnt DESC, reason ASC
        LIMIT 5
      `),
      pgPool.get('blog', `
        SELECT
          id,
          status,
          commenter_name,
          LEFT(comment_text, 80) AS comment_text,
          error_message,
          detected_at
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          ${commentSinceClause}
        ORDER BY detected_at DESC
        LIMIT 1
      `),
      getCourtesyReflectionRecheck(),
      pgPool.get('blog', `
        SELECT COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE status = 'pending'
          AND reply_at IS NULL
          ${commentSinceClause}
      `),
      getNeighborRecoveryStatus(developmentBaseline),
    ]);

    const actionMap = new Map();
    for (const row of actionAggRows || []) {
      actionMap.set(`${row.action_type}:${row.success ? 'ok' : 'fail'}`, Number(row.cnt || 0));
    }

    const commenterRun = readCommenterRunResult();
    const effectiveFailureMetaRows = (failureMetaRows || []).filter((row) => {
      if (!neighborRecovery?.recovered) return true;
      if (String(row.action_type || '') !== 'neighbor_comment') return true;
      const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
      if (!executedAt || Number.isNaN(executedAt.getTime())) return true;
      return executedAt.getTime() > new Date(neighborRecovery.latestSuccessAt).getTime();
    }).filter((row) => {
      if (!String(row.action_type || '').includes('sympathy')) return true;
      const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
      if (!latestSympathyReplayAt || Number.isNaN(latestSympathyReplayAt.getTime()) || !executedAt || Number.isNaN(executedAt.getTime())) return true;
      if (sympathyReplayConfirmsSkip && !matchesSympathyReplayTarget(row, sympathyReplayTarget)) return true;
      return executedAt.getTime() > latestSympathyReplayAt.getTime();
    }).filter((row) => {
      if (String(row.action_type || '') !== 'reply') return true;
      if (!commenterRun?.executedAt || Number(commenterRun?.failed || 0) > 0) return true;
      const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
      const runAt = commenterRun?.executedAt ? new Date(commenterRun.executedAt) : null;
      if (!executedAt || Number.isNaN(executedAt.getTime()) || !runAt || Number.isNaN(runAt.getTime())) return true;
      const sample = summarizeEngagementFailure(row.meta || {});
      if (!String(sample || '').includes('isReplyModeOpen is not defined')) return true;
      return executedAt.getTime() > runAt.getTime();
    });
    const staleNeighborFailureCount = Math.max(0, Number((failureMetaRows || []).length) - Number(effectiveFailureMetaRows.length));
    const staleSympathyFailureCount = Array.isArray(failureMetaRows)
      ? failureMetaRows.filter((row) => {
          if (!String(row?.action_type || '').includes('sympathy')) return false;
          const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
          return Boolean(
            latestSympathyReplayAt
            && !Number.isNaN(latestSympathyReplayAt.getTime())
            && executedAt
            && !Number.isNaN(executedAt.getTime())
            && executedAt.getTime() <= latestSympathyReplayAt.getTime()
            && (!sympathyReplayConfirmsSkip || matchesSympathyReplayTarget(row, sympathyReplayTarget))
          );
        }).length
      : 0;

    const failureByKind = { ui: 0, llm: 0, browser: 0, verification: 0, unknown: 0 };
    const failureSamples = [];
    for (const row of effectiveFailureMetaRows || []) {
      const kind = classifyEngagementFailure(row.meta || {});
      failureByKind[kind] = Number(failureByKind[kind] || 0) + 1;
      const sample = summarizeEngagementFailure(row.meta || {});
      if (sample && failureSamples.length < 3) {
        failureSamples.push({
          actionType: String(row.action_type || ''),
          kind,
          sample,
        });
      }
    }

    const replySuccess = Number(actionMap.get('reply:ok') || 0);
    const replyFailure = Number(actionMap.get('reply:fail') || 0);
    const neighborCommentSuccess = Number(actionMap.get('neighbor_comment:ok') || 0);
    const neighborCommentFailure = Number(actionMap.get('neighbor_comment:fail') || 0);
    const sympathySuccess =
      Number(actionMap.get('neighbor_sympathy:ok') || 0) +
      Number(actionMap.get('neighbor_comment_sympathy:ok') || 0) +
      Number(actionMap.get('comment_post_sympathy:ok') || 0);
    const sympathyFailure =
      Number(actionMap.get('neighbor_sympathy:fail') || 0) +
      Number(actionMap.get('neighbor_comment_sympathy:fail') || 0) +
      Number(actionMap.get('comment_post_sympathy:fail') || 0);
    const sympathyModuleUnavailableSkips = Number(actionMap.get('neighbor_sympathy_skip:ok') || 0);

    const inbound = commentRows?.[0] || { total: 0, replied: 0, pending: 0, failed: 0 };
    const neighborStatusMap = new Map((neighborRows || []).map((row) => [row.status, Number(row.cnt || 0)]));
    const skippedReasonSummary = (skippedReasonRows || [])
      .map((row) => `${String(row.reason || 'unknown')} ${Number(row.cnt || 0)}건`)
      .join(' / ');
    const skippedReason14dSummary = (skippedReason14dRows || [])
      .map((row) => `${String(row.reason || 'unknown')} ${Number(row.cnt || 0)}건`)
      .join(' / ');

    const strategy = loadStrategyBundle().plan;
    const replyPlan = calcExpectedByWindow(
      resolveExecutionTarget('replyTargetPerCycle', strategy, replyConfig.maxDaily || 20),
      replyConfig.activeStartHour || 9,
      replyConfig.activeEndHour || 21
    );
    const neighborPlan = calcExpectedByWindow(
      resolveExecutionTarget('neighborCommentTargetPerCycle', strategy, neighborConfig.maxDaily || 20),
      neighborConfig.activeStartHour || 9,
      neighborConfig.activeEndHour || 21
    );
    const sympathyPlan = calcExpectedByWindow(
      resolveExecutionTarget('sympathyTargetPerCycle', strategy, neighborConfig.maxDaily || 20),
      neighborConfig.activeStartHour || 9,
      neighborConfig.activeEndHour || 21
    );
    const adaptiveNeighborCadence = buildAdaptiveNeighborCadenceView({
      replySuccess,
      neighborSuccess: neighborCommentSuccess,
      sympathySuccess,
      replyPlan,
      neighborPlan,
      adaptiveEnabled: neighborConfig.adaptiveEnabled !== false,
      adaptiveMinGapToBoost: neighborConfig.adaptiveMinGapToBoost || 2,
      adaptiveBoostCap: neighborConfig.adaptiveBoostCap || 12,
      adaptiveCollectBoostCap: neighborConfig.adaptiveCollectBoostCap || 20,
      adaptiveSympathyBoostCap: neighborConfig.adaptiveSympathyBoostCap || 8,
      baseProcess: neighborConfig.maxProcessPerCycle || 20,
      baseCollect: neighborConfig.maxCollectPerCycle || 20,
    });
    const neighborCollectDiagnostics = readNeighborCollectDiagnostics();

    const ok = [
      `  replies: ${replySuccess}/${replyPlan.target} (expected now ${replyPlan.expectedNow})`,
      `  neighbor comments: ${neighborCommentSuccess}/${neighborPlan.target} (expected now ${neighborPlan.expectedNow})`,
      `  sympathies: ${sympathySuccess}/${sympathyPlan.target} (expected now ${sympathyPlan.expectedNow})`,
      `  inbound comments today: ${Number(inbound.total || 0)}건 / replied ${Number(inbound.replied || 0)} / pending ${Number(inbound.pending || 0)}`,
      `  neighbor queue today: posted ${Number(neighborStatusMap.get('posted') || 0)} / failed ${Number(neighborStatusMap.get('failed') || 0)} / pending ${Number(neighborStatusMap.get('pending') || 0)}`,
      `  adaptive comment cadence: ${adaptiveNeighborCadence.shouldBoost ? 'boosted' : 'baseline'} / combined comments ${adaptiveNeighborCadence.combinedCommentSuccess}/${adaptiveNeighborCadence.combinedCommentExpectedNow} / process ${adaptiveNeighborCadence.effectiveProcessLimit} / collect ${adaptiveNeighborCadence.effectiveCollectLimit}`,
    ];
    if (developmentBaseline?.startedAtIso) {
      ok.push(`  development baseline: ${developmentBaseline.startedAtIso}`);
    }
    if (Number(pendingBacklogRow?.cnt || 0) > 0) {
      ok.push(`  reply pending backlog: ${Number(pendingBacklogRow.cnt || 0)}건`);
    }

    const warn = [];
    if (replyPlan.active && replySuccess < replyPlan.expectedNow) {
      warn.push(`  replies behind target: ${replySuccess}/${replyPlan.expectedNow} (today fail ${replyFailure})`);
    }
    if (neighborPlan.active && neighborCommentSuccess < neighborPlan.expectedNow) {
      warn.push(`  neighbor comments behind target: ${neighborCommentSuccess}/${neighborPlan.expectedNow} (today fail ${neighborCommentFailure})`);
    }
    if (sympathyPlan.active && sympathySuccess < sympathyPlan.expectedNow) {
      warn.push(`  sympathies behind target: ${sympathySuccess}/${sympathyPlan.expectedNow} (today fail ${sympathyFailure})`);
    }
    if (adaptiveNeighborCadence.shouldBoost) {
      warn.push(`  adaptive cadence boosted: replies+neighbor ${adaptiveNeighborCadence.combinedCommentSuccess}/${adaptiveNeighborCadence.combinedCommentExpectedNow} / neighbor gap ${adaptiveNeighborCadence.neighborDeficit} / sympathy gap ${adaptiveNeighborCadence.sympathyDeficit}`);
    }
    if (Number(inbound.pending || 0) > 0) {
      warn.push(`  inbound pending comments: ${Number(inbound.pending || 0)}건`);
    }
    if (
      replyPlan.active
      && replySuccess < replyPlan.expectedNow
      && Number(inbound.total || 0) === 0
      && Number(pendingBacklogRow?.cnt || 0) === 0
    ) {
      ok.push('  reply workload idle: baseline 이후 inbound 댓글과 pending backlog가 없어 replies gap이 유지되고 있습니다');
    }
    if (lastGapRun?.executedAt) {
      const attemptedSummary = Array.isArray(lastGapRun.attempted)
        ? lastGapRun.attempted.map((item) => String(item?.label || '')).filter(Boolean).join(' -> ')
        : '';
      ok.push(`  last engagement gap run: ${String(lastGapRun.executedAt)} / ${lastGapRun.allIdle ? 'all idle' : 'workload handled'}${attemptedSummary ? ` / attempted ${attemptedSummary}` : ''}`);
      if (lastGapRun.allIdle && lastGapRun.idleReason) {
        ok.push(`  last gap run idle reason: ${String(lastGapRun.idleReason)}`);
      }
    }
    if (neighborUiReplay?.ok) {
      if (neighborUiReplay?.result?.ok) {
        ok.push(`  neighbor replay latest: success / comment ${Number(neighborUiReplay?.candidate?.id || 0)} / ${String(neighborUiReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`);
      } else if (neighborUiReplay?.result?.skipped) {
        ok.push(`  neighbor replay latest: skipped / ${String(neighborUiReplay?.result?.reason || 'unknown')}`);
      } else if (neighborUiReplay?.reason) {
        warn.push(`  neighbor replay latest: failed / ${String(neighborUiReplay.reason).slice(0, 120)}`);
      }
    }
    if (neighborSympathyReplay?.ok) {
      if (neighborSympathyReplay?.result?.ok) {
        ok.push(`  neighbor sympathy replay latest: success / comment ${Number(neighborSympathyReplay?.candidate?.id || 0)} / ${String(neighborSympathyReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`);
      } else if (neighborSympathyReplay?.result?.skipped) {
        ok.push(`  neighbor sympathy replay latest: skipped / ${String(neighborSympathyReplay?.result?.reason || 'unknown')}`);
      } else if (neighborSympathyReplay?.result?.error || neighborSympathyReplay?.error) {
        warn.push(`  neighbor sympathy replay latest: failed / ${String(neighborSympathyReplay?.result?.error || neighborSympathyReplay?.error).slice(0, 120)}`);
      }
    }
    if (sympathyModuleUnavailableSkips > 0) {
      ok.push(`  neighbor sympathy skipped: module unavailable ${sympathyModuleUnavailableSkips}건`);
    }
    if (staleSympathyFailureCount > 0) {
      ok.push(`  stale sympathy failures: ${staleSympathyFailureCount}건은 최근 replay 확인 이후 우선 병목에서 제외`);
    }
    if (Number(inbound.total || 0) > 0 && Number(inbound.pending || 0) === 0 && Number(inbound.replied || 0) === 0 && Number(inbound.failed || 0) === 0) {
      warn.push('  reply workload empty: 오늘 inbound는 들어왔지만 reply 후보로 올라간 댓글이 없습니다');
    }
    if (
      neighborPlan.active
      && neighborCommentSuccess < neighborPlan.expectedNow
      && Number(neighborStatusMap.get('posted') || 0) === 0
      && Number(neighborStatusMap.get('pending') || 0) === 0
      && neighborCollectDiagnostics
    ) {
      ok.push(
        `  neighbor collect diag: buddy ${Number(neighborCollectDiagnostics.buddyFeedSourceCount || 0)} / network ${Number(neighborCollectDiagnostics.commenterNetworkSourceCount || 0)} / resolved ${Number(neighborCollectDiagnostics.commenterNetworkResolvedCount || 0)} / collected ${Number(neighborCollectDiagnostics.rawCollectedCount || 0)} / inserted ${Number(neighborCollectDiagnostics.insertedCount || 0)}`
      );
      if (neighborCollectDiagnostics.relaxedRetryUsed) {
        ok.push(`  neighbor collect retry: recent window ${Number(neighborCollectDiagnostics.relaxedRecentWindowDays || 0)}일로 완화 재시도`);
      }
      ok.push(
        `  neighbor collect bottleneck: buddy recent ${Number(neighborCollectDiagnostics.buddyFeedRecentBlogSkipCount || 0)} / buddy seen ${Number(neighborCollectDiagnostics.buddyFeedSeenUrlSkipCount || 0)} / network recent ${Number(neighborCollectDiagnostics.commenterNetworkRecentBlogSkipCount || 0)} / network resolve fail ${Number(neighborCollectDiagnostics.commenterNetworkResolveFailedCount || 0)} / network seen ${Number(neighborCollectDiagnostics.commenterNetworkSeenUrlSkipCount || 0)}`
      );
    }
    const activeFailureCount = Array.isArray(effectiveFailureMetaRows) ? effectiveFailureMetaRows.length : 0;
    if (activeFailureCount > 0) {
      warn.push(`  failed engagement actions today: ${activeFailureCount}건`);
    }
    if (neighborRecovery?.recovered) {
      ok.push(`  neighbor hosted recovery: 최근 외부 댓글 성공이 최신 실패 이후 확인됨 (${String(neighborRecovery.latestSuccessAt || '').slice(0, 19)}Z)`);
      if (staleNeighborFailureCount > 0) {
        ok.push(`  stale neighbor failures: ${staleNeighborFailureCount}건은 현재 우선 병목에서 제외`);
      }
    }
    if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0 || (failureByKind.llm || 0) > 0) {
      ok.push(
        `  failure mix: ui ${failureByKind.ui || 0} / browser ${failureByKind.browser || 0} / llm ${failureByKind.llm || 0} / verification ${failureByKind.verification || 0}`
      );
    }
    for (const item of failureSamples) {
      ok.push(`  recent failure: ${item.kind}/${item.actionType} ${item.sample}`);
    }
    if (latestReplyReplayCandidate?.id) {
      const replayAgeLabel = latestReplyReplayCandidate.from_failure ? 'recent failure' : 'recent comment';
      ok.push(
        `  reply replay target: comment ${latestReplyReplayCandidate.id} (${String(latestReplyReplayCandidate.commenter_name || 'unknown').slice(0, 30)}) / ${replayAgeLabel}`
      );
      ok.push(`  reply replay command: npm run replay:reply-ui -- --comment-id ${latestReplyReplayCandidate.id} --json`);
      ok.push(`  engagement doctor command: ${ENGAGEMENT_DOCTOR_COMMAND}`);
      ok.push(`  ops doctor command: ${BLOG_OPS_DOCTOR_COMMAND}`);
    }
    if (skippedReasonSummary) {
      ok.push(`  skipped reasons today: ${skippedReasonSummary}`);
    }
    if (skippedReason14dSummary) {
      ok.push(`  skipped reasons 14d: ${skippedReason14dSummary}`);
    }
    if (Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
      ok.push(`  courtesy recheck 14d: ${courtesyReflectionRecheck.reevaluableCount}/${courtesyReflectionRecheck.reviewedCount} generic greeting skip이 현재 inbound reply 정책으로 다시 reply 후보가 될 수 있습니다`);
    }
    if (latestCommentRow?.id) {
      ok.push(
        `  latest inbound: comment ${latestCommentRow.id} / ${String(latestCommentRow.status || 'unknown')}${latestCommentRow.error_message ? ` / ${String(latestCommentRow.error_message)}` : ''}`
      );
    }
    if ((failureByKind.ui || 0) > 0) {
      warn.push(`  engagement UI failures: ${failureByKind.ui || 0}건`);
    }
    if ((failureByKind.browser || 0) > 0) {
      warn.push(`  engagement browser failures: ${failureByKind.browser || 0}건`);
    }
    if ((failureByKind.llm || 0) > 0) {
      warn.push(`  engagement LLM failures: ${failureByKind.llm || 0}건`);
    }

    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      developmentBaseline: developmentBaseline
        ? {
            active: true,
            startedAt: developmentBaseline.startedAtIso,
            source: developmentBaseline.source,
            note: developmentBaseline.note,
            path: developmentBaseline.path,
          }
        : null,
      replies: {
        success: replySuccess,
        failed: replyFailure,
        target: replyPlan.target,
        expectedNow: replyPlan.expectedNow,
      },
      neighborComments: {
        success: neighborCommentSuccess,
        failed: neighborCommentFailure,
        target: neighborPlan.target,
        expectedNow: neighborPlan.expectedNow,
      },
      sympathies: {
        success: sympathySuccess,
        failed: sympathyFailure,
        target: sympathyPlan.target,
        expectedNow: sympathyPlan.expectedNow,
        skippedModuleUnavailable: sympathyModuleUnavailableSkips,
      },
      inboundComments: {
        total: Number(inbound.total || 0),
        replied: Number(inbound.replied || 0),
        pending: Number(inbound.pending || 0),
        failed: Number(inbound.failed || 0),
      },
      replyPendingBacklog: Number(pendingBacklogRow?.cnt || 0),
      neighborQueue: {
        posted: Number(neighborStatusMap.get('posted') || 0),
        failed: Number(neighborStatusMap.get('failed') || 0),
        pending: Number(neighborStatusMap.get('pending') || 0),
      },
      neighborCollectDiagnostics,
      adaptiveNeighborCadence,
      neighborRecovery,
      staleNeighborFailureCount,
      staleSympathyFailureCount,
      failureByKind,
      failureSamples,
      latestReplyReplayCandidate: latestReplyReplayCandidate || null,
      skippedReasonSummary,
      skippedReason14dSummary,
      latestInbound: latestCommentRow
        ? {
            id: latestCommentRow.id,
            status: latestCommentRow.status,
            commenterName: latestCommentRow.commenter_name,
            commentText: latestCommentRow.comment_text,
            errorMessage: latestCommentRow.error_message,
            detectedAt: latestCommentRow.detected_at,
          }
        : null,
      courtesyReflectionRecheck,
      lastGapRun,
      neighborUiReplay,
      neighborSympathyReplay,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  engagement: 확인 실패 (${String(error.message || error).slice(0, 120)})`],
      replies: { success: 0, failed: 0, target: 0, expectedNow: 0 },
      neighborComments: { success: 0, failed: 0, target: 0, expectedNow: 0 },
      sympathies: { success: 0, failed: 0, target: 0, expectedNow: 0 },
      inboundComments: { total: 0, replied: 0, pending: 0, failed: 0 },
      replyPendingBacklog: 0,
      neighborQueue: { posted: 0, failed: 0, pending: 0 },
      neighborCollectDiagnostics: null,
      failureByKind: { ui: 0, llm: 0, browser: 0, verification: 0, unknown: 0 },
      failureSamples: [],
      latestReplyReplayCandidate: null,
      skippedReasonSummary: '',
      skippedReason14dSummary: '',
      latestInbound: null,
      courtesyReflectionRecheck: { reviewedCount: 0, reevaluableCount: 0, reevaluableSamples: [] },
      lastGapRun: null,
      neighborUiReplay: null,
      neighborSympathyReplay: null,
      staleSympathyFailureCount: 0,
    };
  }
}

async function buildPhase1Health() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase1.report', '--brief'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const summary = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.startsWith('phase1=')) || output;

    return {
      okCount: 1,
      warnCount: 0,
      ok: [`  ${summary}`],
      warn: [],
      summary,
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase1 report: 확인 실패 (${reason})`],
      summary: null,
    };
  }
}


async function buildPhase2BriefingHealthFor(type) {
  try {
    const output = execFileSync(
      'node',
      [path.join(BLOG_ROOT, 'scripts/check-ai-briefing-structure.ts'), '--json', '--latest', '--type', type],
      {
        cwd: BLOG_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText);
    const briefingIssues = Array.isArray(payload?.briefingIssues) ? payload.briefingIssues : [];
    const qualityIssues = Array.isArray(payload?.quality?.issues) ? payload.quality.issues : [];
    const ok = [
      `  briefing file: ${payload?.file || 'unknown'}`,
      `  briefing passed: ${payload?.briefingPassed ? 'yes' : 'no'}`,
      `  faq count: ${payload?.briefing?.questionFaqCount ?? 0}`,
      `  answered faq: ${payload?.briefing?.answeredFaqCount ?? 0}`,
    ];
    const warn = [];
    if (!payload?.briefingPassed) warn.push(`  briefing issues: ${briefingIssues.join(', ') || 'unknown'}`);
    for (const issue of qualityIssues.slice(0, 3)) {
      warn.push(`  ${issue.severity}: ${issue.msg}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      type,
      briefingPassed: Boolean(payload?.briefingPassed),
      questionFaqCount: Number(payload?.briefing?.questionFaqCount || 0),
      answeredFaqCount: Number(payload?.briefing?.answeredFaqCount || 0),
      file: payload?.file || null,
    };
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    try {
      const jsonText = extractJsonObjectText(stdout);
      const payload = JSON.parse(jsonText);
      const briefingIssues = Array.isArray(payload?.briefingIssues) ? payload.briefingIssues : [];
      const qualityIssues = Array.isArray(payload?.quality?.issues) ? payload.quality.issues : [];
      const ok = [
        `  briefing file: ${payload?.file || 'unknown'}`,
        `  briefing passed: ${payload?.briefingPassed ? 'yes' : 'no'}`,
        `  faq count: ${payload?.briefing?.questionFaqCount ?? 0}`,
        `  answered faq: ${payload?.briefing?.answeredFaqCount ?? 0}`,
      ];
      const warn = [];
      if (!payload?.briefingPassed) warn.push(`  briefing issues: ${briefingIssues.join(', ') || 'unknown'}`);
      for (const issue of qualityIssues.slice(0, 3)) {
        warn.push(`  ${issue.severity}: ${issue.msg}`);
      }
      return {
        okCount: ok.length,
        warnCount: warn.length,
        ok,
        warn,
        type,
        briefingPassed: Boolean(payload?.briefingPassed),
        questionFaqCount: Number(payload?.briefing?.questionFaqCount || 0),
        answeredFaqCount: Number(payload?.briefing?.answeredFaqCount || 0),
        file: payload?.file || null,
      };
    } catch {
      const reason = String(error?.message || error).slice(0, 160);
      return {
        okCount: 0,
        warnCount: 1,
        ok: [],
        warn: [`  phase2 briefing ${type}: 확인 실패 (${reason})`],
        type,
        briefingPassed: false,
        questionFaqCount: 0,
        answeredFaqCount: 0,
        file: null,
      };
    }
  }
}

async function buildPhase2BriefingHealth() {
  const [lecture, general] = await Promise.all([
    buildPhase2BriefingHealthFor('lecture'),
    buildPhase2BriefingHealthFor('general'),
  ]);

  const ok = [
    ...lecture.ok.map((line) => line.replace(/^  /, '  lecture: ')),
    ...general.ok.map((line) => line.replace(/^  /, '  general: ')),
  ];
  const warn = [
    ...lecture.warn.map((line) => line.replace(/^  /, '  lecture: ')),
    ...general.warn.map((line) => line.replace(/^  /, '  general: ')),
  ];

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    briefingPassed: Boolean(lecture.briefingPassed && general.briefingPassed),
    lecture,
    general,
  };
}

async function buildPhase3FeedbackHealth() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase3.feedback', '--json'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText);
    const ok = [
      `  status: ${payload?.health?.status || 'unknown'}`,
      `  feedback count: ${payload?.feedback?.feedback_count ?? 0}`,
      `  node failures: ${payload?.execution?.failed_count ?? 0}`,
      `  social failures: ${payload?.social?.failed_count ?? 0}`,
    ];
    const warn = [];
    const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
    if (payload?.health?.status && payload.health.status !== 'ok') {
      warn.push(`  phase3 status: ${payload.health.status}`);
    }
    for (const item of recommendations.slice(0, 2)) {
      warn.push(`  reco: ${item}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: payload?.health?.status || 'unknown',
      feedbackCount: Number(payload?.feedback?.feedback_count || 0),
      nodeFailures: Number(payload?.execution?.failed_count || 0),
      socialFailures: Number(payload?.social?.failed_count || 0),
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase3 feedback: 확인 실패 (${reason})`],
      status: 'error',
      feedbackCount: 0,
      nodeFailures: 0,
      socialFailures: 0,
    };
  }
}

async function buildPhase4CompetitionHealth() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase4.competition', '--json'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText || '{}');
    const health = payload?.health || {};
    const quality = payload?.quality || {};
    const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
    const ok = [
      `  status: ${health.status || 'unknown'}`,
      `  competitions: ${health.total_count ?? 0}`,
      `  completed: ${health.completed_count ?? 0}`,
      `  timeout: ${health.timeout_count ?? 0}`,
      `  avg quality diff: ${quality.avg_quality_diff ?? 'n/a'}`,
    ];
    const warn = [];
    if (health.status === 'warn' || health.status === 'error') {
      warn.push(`  phase4 status: ${health.status}`);
    }
    if ((health.status === 'warn' || health.status === 'error') && Number(health.timeout_count || 0) > 0) {
      warn.push(`  timeout competitions: ${Number(health.timeout_count || 0)}건`);
    }
    if (recommendations[0]) {
      warn.push(`  reco: ${recommendations[0]}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: health.status || 'unknown',
      totalCount: Number(health.total_count || 0),
      completedCount: Number(health.completed_count || 0),
      runningCount: Number(health.running_count || 0),
      pendingCount: Number(health.pending_count || 0),
      timeoutCount: Number(health.timeout_count || 0),
      avgQualityDiff: quality.avg_quality_diff ?? null,
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase4 competition: 확인 실패 (${reason})`],
      status: 'error',
      totalCount: 0,
      completedCount: 0,
      runningCount: 0,
      pendingCount: 0,
      timeoutCount: 0,
      avgQualityDiff: null,
    };
  }
}

async function buildMarketingExpansionHealth() {
  try {
    const digest = await buildMarketingDigest();
    const latestDigestRun = readMarketingDigestTelemetry();
    let strategy = digest?.strategy || null;
    if (!strategy) {
      try {
        if (fs.existsSync(BLOG_STRATEGY_PATH)) {
          const parsed = JSON.parse(fs.readFileSync(BLOG_STRATEGY_PATH, 'utf8'));
          strategy = parsed?.plan || null;
        }
      } catch {
        strategy = null;
      }
    }
    const ok = [
      `  status: ${digest?.health?.status || 'unknown'}`,
      `  reason: ${digest?.health?.reason || '없음'}`,
      `  sense signals: ${digest?.senseSummary?.signalCount ?? 0}`,
      `  revenue impact: ${((Number(digest?.revenueCorrelation?.revenueImpactPct || 0)) * 100).toFixed(1)}%`,
      `  snapshots(7d): ${digest?.snapshotTrend?.totalCount ?? 0}`,
      `  avg snapshot impact: ${((Number(digest?.snapshotTrend?.avgRevenueImpactPct || 0)) * 100).toFixed(1)}%`,
      `  autonomy decisions: ${digest?.autonomySummary?.totalCount ?? 0}`,
    ];
    if (strategy?.preferredCategory || strategy?.preferredTitlePattern) {
      ok.push(
        `  strategy: ${strategy?.preferredCategory || 'none'} / ${strategy?.preferredTitlePattern || 'none'}`,
      );
    }
    if (Number(strategy?.preferredCategoryWeightBoost || 0) > 0) {
      ok.push(`  strategy recovery boost: +${Number(strategy.preferredCategoryWeightBoost || 0)}`);
    }
    const adoption = digest?.strategyAdoption || null;
    if (adoption?.status) {
      ok.push(
        `  strategy adoption: ${adoption.status} (${Number(adoption?.preferredCategoryPatternCount || 0)}/${Number(adoption?.preferredCategoryCount || 0)})`,
      );
      ok.push(
        `  alignment coverage: ${Number(adoption?.alignmentCoverageCount || 0)}/${Number(adoption?.recentCount || 0)} (${(Number(adoption?.alignmentCoverageRatio || 0) * 100).toFixed(0)}%, measured ${Number(adoption?.metadataCoverageCount || 0)}, inferred ${Number(adoption?.inferredCoverageCount || 0)})`,
      );
      if (typeof adoption?.latestPreviewOverlap === 'number') {
        ok.push(
          `  latest title overlap: ${Number(adoption.latestPreviewOverlap || 0).toFixed(2)} (${adoption?.latestPreviewAligned ? 'preview aligned' : 'preview drift'})`,
        );
      }
      if (adoption?.latestAlignmentHint) {
        ok.push(`  latest alignment hint: ${adoption.latestAlignmentHint}`);
      }
    }
    const nextPreview = digest?.nextGeneralPreview || null;
    if (nextPreview?.category || nextPreview?.pattern) {
      ok.push(
        `  next preview: ${nextPreview?.category || 'none'} / ${nextPreview?.pattern || 'none'} / ${nextPreview?.predictedAdoption || 'warming_up'}`,
      );
    }
    if (nextPreview?.title) {
      ok.push(`  next title: ${nextPreview.title}`);
    }
    const hotspotCategory = strategy?.categoryPatternHotspot?.category || null;
    const hotspotPattern = strategy?.categoryPatternHotspot?.topPattern || null;
    if (hotspotCategory || hotspotPattern) {
      ok.push(
        `  pattern hotspot: ${hotspotCategory || 'none'} / ${hotspotPattern || 'none'}`,
      );
    }
    const hotspotTrendStatus = strategy?.hotspotTrend?.status || null;
    if (hotspotTrendStatus) {
      ok.push(
        `  hotspot trend: ${hotspotTrendStatus} (${Number(strategy?.hotspotTrend?.previousRatio || 0).toFixed(2)} -> ${Number(strategy?.hotspotTrend?.currentRatio || 0).toFixed(2)})`,
      );
    }
    if (digest?.channelPerformance?.latestDate) {
      ok.push(
        `  channels: ${digest?.channelPerformance?.totalChannels ?? 0}개 / watch ${digest?.channelPerformance?.watchChannels ?? 0}개`,
      );
    }
    if (latestDigestRun?.checkedAt) {
      const latestDigestAge = describeMarketingDigestAge(latestDigestRun);
      ok.push(`  latest digest run: ${String(latestDigestRun.checkedAt).slice(0, 19)} / ${String(latestDigestRun.status || 'unknown')}${latestDigestAge.text ? ` / ${latestDigestAge.text}` : ''}`);
    }
    const warn = [];
    if (digest?.senseSummary?.topSignal?.message) {
      warn.push(`  top signal: ${digest.senseSummary.topSignal.message}`);
    }
    if (digest?.channelPerformance?.primaryWatchHint) {
      warn.push(`  channel watch: ${digest.channelPerformance.primaryWatchHint}`);
    }
    if (Number(digest?.snapshotTrend?.watchCount || 0) > 0) {
      warn.push(`  snapshot watch: 최근 7일 ${Number(digest.snapshotTrend.watchCount || 0)}건`);
    }
    if (digest?.snapshotTrend?.latestWeakness) {
      warn.push(`  snapshot weakness: ${digest.snapshotTrend.latestWeakness}`);
    }
    if (digest?.diagnosis?.primaryWeakness?.message && digest.diagnosis.primaryWeakness.code !== 'stable') {
      warn.push(`  weakness: ${digest.diagnosis.primaryWeakness.message}`);
    }
    for (const item of (digest?.recommendations || []).slice(0, 2)) {
      warn.push(`  reco: ${item}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: digest?.health?.status || 'unknown',
      signalCount: Number(digest?.senseSummary?.signalCount || 0),
      revenueImpactPct: Number(digest?.revenueCorrelation?.revenueImpactPct || 0),
      snapshotCount: Number(digest?.snapshotTrend?.totalCount || 0),
      snapshotWatchCount: Number(digest?.snapshotTrend?.watchCount || 0),
      snapshotAvgRevenueImpactPct: Number(digest?.snapshotTrend?.avgRevenueImpactPct || 0),
      channelWatchCount: Number(digest?.channelPerformance?.watchChannels || 0),
      primaryChannelWatchHint: digest?.channelPerformance?.primaryWatchHint || null,
      autonomyDecisionCount: Number(digest?.autonomySummary?.totalCount || 0),
      preferredCategory: strategy?.preferredCategory || null,
      preferredCategoryWeightBoost: Number(strategy?.preferredCategoryWeightBoost || 0),
      preferredTitlePattern: strategy?.preferredTitlePattern || null,
      suppressedTitlePattern: strategy?.suppressedTitlePattern || null,
      categoryPatternHotspot: strategy?.categoryPatternHotspot || null,
      hotspotTrend: strategy?.hotspotTrend || null,
      strategyAdoption: digest?.strategyAdoption || null,
      nextGeneralPreview: digest?.nextGeneralPreview || null,
      latestDigestRun,
      latestDigestAge: describeMarketingDigestAge(latestDigestRun),
      recommendations: Array.isArray(digest?.recommendations) ? digest.recommendations.slice(0, 2) : [],
    };
  } catch (error) {
    const latestDigestRun = readMarketingDigestTelemetry();
    const reason = String(error?.message || error).slice(0, 160);
    const fallbackStatus = String(latestDigestRun?.status || 'error');
    const fallbackReason = String(latestDigestRun?.reason || '');
    const fallbackTopSignal = String(latestDigestRun?.topSignal || '');
    const fallbackRecommendation = String(latestDigestRun?.recommendation || '');
    const fallbackNextPreviewTitle = String(latestDigestRun?.nextPreviewTitle || '');
    const warn = [`  marketing digest: 확인 실패 (${reason})`];
    if (latestDigestRun?.checkedAt) {
      const latestDigestAge = describeMarketingDigestAge(latestDigestRun);
      warn.push(`  latest digest run: ${String(latestDigestRun.checkedAt).slice(0, 19)} / ${String(latestDigestRun.status || 'unknown')}${latestDigestAge.text ? ` / ${latestDigestAge.text}` : ''}`);
    }
    if (fallbackTopSignal) {
      warn.push(`  top signal (cached): ${fallbackTopSignal}`);
    }
    if (fallbackRecommendation) {
      warn.push(`  reco (cached): ${fallbackRecommendation}`);
    }
    return {
      okCount: 0,
      warnCount: warn.length,
      ok: [],
      warn,
      status: fallbackStatus || 'error',
      signalCount: 0,
      revenueImpactPct: 0,
      snapshotCount: 0,
      snapshotWatchCount: 0,
      snapshotAvgRevenueImpactPct: 0,
      channelWatchCount: 0,
      primaryChannelWatchHint: null,
      autonomyDecisionCount: 0,
      preferredCategory: null,
      preferredCategoryWeightBoost: 0,
      preferredTitlePattern: null,
      suppressedTitlePattern: null,
      categoryPatternHotspot: null,
      hotspotTrend: null,
      strategyAdoption: null,
      nextGeneralPreview: fallbackNextPreviewTitle ? { title: fallbackNextPreviewTitle } : null,
      latestDigestRun,
      latestDigestAge: describeMarketingDigestAge(latestDigestRun),
      recommendations: [],
      cachedReason: fallbackReason,
    };
  }
}

function buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth, instagramHealth, socialAutomationHealth, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth, marketingExpansionHealth, engagementHealth, socialDoctorPriority = null, engagementDoctorPriority = null, opsDoctorPriority = null) {
  const previewBundleHint = [
    socialAutomationHealth.latestReelUrl ? `reel=${socialAutomationHealth.latestReelUrl}` : '',
    socialAutomationHealth.latestCoverUrl ? `cover=${socialAutomationHealth.latestCoverUrl}` : '',
    socialAutomationHealth.latestQaUrl ? `qa=${socialAutomationHealth.latestQaUrl}` : '',
  ].filter(Boolean).join(' / ');
  const instagramDiagnoseHint = `diagnose=${INSTAGRAM_READINESS_COMMAND} / doctor=${INSTAGRAM_DOCTOR_COMMAND} / social=${SOCIAL_DOCTOR_COMMAND}`;
  const opsDoctorHint = `ops=${BLOG_OPS_DOCTOR_COMMAND}`;
  const marketingDoctorHint = `marketing=${MARKETING_DOCTOR_COMMAND}`;
  const socialActionHints = Array.isArray(socialDoctorPriority?.actions)
    ? socialDoctorPriority.actions
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 2)
        .map((item) => `social action: ${item}`)
    : [];
  const opsActionHints = Array.isArray(opsDoctorPriority?.actions)
    ? opsDoctorPriority.actions
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 2)
        .map((item) => `ops action: ${item}`)
    : [];
  const opsPrimaryArea = String(opsDoctorPriority?.primaryArea || '');
  const socialPrimaryActive = opsPrimaryArea.startsWith('social');
  const opsSocialActionHints = opsPrimaryArea.startsWith('social') ? opsActionHints : [];
  const opsEngagementActionHints = opsPrimaryArea.startsWith('engagement') ? opsActionHints : [];
  const engagementFailureHint = engagementHealth?.failureSamples?.[0]
    ? `${engagementHealth.failureSamples[0].kind}/${engagementHealth.failureSamples[0].actionType} ${engagementHealth.failureSamples[0].sample}`
    : '';
  const neighborReplayHint = engagementHealth?.neighborUiReplay?.ok
    ? engagementHealth.neighborUiReplay?.result?.ok
      ? `최근 neighbor replay 성공: comment ${Number(engagementHealth?.neighborUiReplay?.candidate?.id || 0)} / ${String(engagementHealth?.neighborUiReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`
      : engagementHealth.neighborUiReplay?.result?.skipped
        ? `최근 neighbor replay는 UI 재현 후 skip: ${String(engagementHealth?.neighborUiReplay?.result?.reason || 'unknown')}`
        : engagementHealth.neighborUiReplay?.reason
          ? `최근 neighbor replay 실패: ${String(engagementHealth.neighborUiReplay.reason)}`
          : ''
    : '';
  const neighborSympathyReplayHint = engagementHealth?.neighborSympathyReplay?.ok
    ? engagementHealth.neighborSympathyReplay?.result?.ok
      ? `최근 neighbor sympathy replay 성공: comment ${Number(engagementHealth?.neighborSympathyReplay?.candidate?.id || 0)} / ${String(engagementHealth?.neighborSympathyReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`
      : engagementHealth.neighborSympathyReplay?.result?.skipped
        ? `최근 neighbor sympathy replay는 UI 재현 후 skip: ${String(engagementHealth?.neighborSympathyReplay?.result?.reason || 'unknown')}`
        : engagementHealth.neighborSympathyReplay?.result?.error || engagementHealth.neighborSympathyReplay?.error
          ? `최근 neighbor sympathy replay 실패: ${String(engagementHealth?.neighborSympathyReplay?.result?.error || engagementHealth?.neighborSympathyReplay?.error)}`
          : ''
    : '';
  const engagementReplayHint = engagementHealth?.latestReplyReplayCandidate?.id
    ? `npm run replay:reply-ui -- --comment-id ${engagementHealth.latestReplyReplayCandidate.id} --json`
    : '';
  const engagementGapEntries = [
    engagementHealth?.replies?.expectedNow > Number(engagementHealth?.replies?.success || 0)
      ? {
          label: 'replies',
          success: Number(engagementHealth?.replies?.success || 0),
          expectedNow: Number(engagementHealth?.replies?.expectedNow || 0),
          deficit: Number(engagementHealth?.replies?.expectedNow || 0) - Number(engagementHealth?.replies?.success || 0),
        }
      : null,
    engagementHealth?.neighborComments?.expectedNow > Number(engagementHealth?.neighborComments?.success || 0)
      ? {
          label: 'neighbor',
          success: Number(engagementHealth?.neighborComments?.success || 0),
          expectedNow: Number(engagementHealth?.neighborComments?.expectedNow || 0),
          deficit: Number(engagementHealth?.neighborComments?.expectedNow || 0) - Number(engagementHealth?.neighborComments?.success || 0),
        }
      : null,
    engagementHealth?.sympathies?.expectedNow > Number(engagementHealth?.sympathies?.success || 0)
      ? {
          label: 'sympathy',
          success: Number(engagementHealth?.sympathies?.success || 0),
          expectedNow: Number(engagementHealth?.sympathies?.expectedNow || 0),
          deficit: Number(engagementHealth?.sympathies?.expectedNow || 0) - Number(engagementHealth?.sympathies?.success || 0),
        }
      : null,
  ].filter(Boolean).sort((a, b) => b.deficit - a.deficit);
  const doctorGapLabel = String(engagementDoctorPriority?.primaryArea || '')
    .match(/engagement\.target_gap\.([a-z_]+)/i)?.[1] || '';
  const normalizedDoctorGapLabel = doctorGapLabel === 'neighbor' ? 'neighbor' : doctorGapLabel === 'sympathy' ? 'sympathy' : doctorGapLabel === 'replies' ? 'replies' : '';
  const engagementPrimaryGap = engagementGapEntries.find((item) => item.label === normalizedDoctorGapLabel)
    || engagementGapEntries[0]
    || null;
  const engagementGapHint = [
    engagementHealth?.replies?.expectedNow > 0
      ? `replies ${Number(engagementHealth?.replies?.success || 0)}/${Number(engagementHealth?.replies?.expectedNow || 0)}`
      : '',
    engagementHealth?.neighborComments?.expectedNow > 0
      ? `neighbor ${Number(engagementHealth?.neighborComments?.success || 0)}/${Number(engagementHealth?.neighborComments?.expectedNow || 0)}`
      : '',
    engagementHealth?.sympathies?.expectedNow > 0
      ? `sympathy ${Number(engagementHealth?.sympathies?.success || 0)}/${Number(engagementHealth?.sympathies?.expectedNow || 0)}`
      : '',
  ].filter(Boolean).join(' / ');
  const engagementDoctorHint = `doctor=${ENGAGEMENT_DOCTOR_COMMAND}`;
  const engagementImmediateAction = String(engagementDoctorPriority?.nextCommand || '').trim();
  const adaptiveCadenceHint = engagementHealth?.adaptiveNeighborCadence?.enabled
    ? engagementHealth.adaptiveNeighborCadence.shouldBoost
      ? `외부 댓글 cadence boost: reply+neighbor ${Number(engagementHealth.adaptiveNeighborCadence.combinedCommentSuccess || 0)}/${Number(engagementHealth.adaptiveNeighborCadence.combinedCommentExpectedNow || 0)} / process ${Number(engagementHealth.adaptiveNeighborCadence.effectiveProcessLimit || 0)} / collect ${Number(engagementHealth.adaptiveNeighborCadence.effectiveCollectLimit || 0)}`
      : '외부 댓글 cadence: baseline'
    : '';
  const orderedEngagementSteps = (() => {
    const doctorPrimaryLabel = normalizedDoctorGapLabel;
    const entries = [...engagementGapEntries];
    if (!entries.length) return [];
    const shouldPrioritizeNeighborQueue =
      String(engagementDoctorPriority?.nextCommand || '').includes('run-neighbor-commenter.ts')
      && Number(engagementHealth?.neighborQueue?.pending || 0) > 0;
    if (shouldPrioritizeNeighborQueue) {
      const neighborExisting = entries.find((item) => item.label === 'neighbor');
      const neighborEntry = neighborExisting || {
        label: 'neighbor',
        success: Number(engagementHealth?.neighborComments?.success || 0),
        expectedNow: Number(engagementHealth?.neighborComments?.expectedNow || 0),
        deficit: Math.max(0, Number(engagementHealth?.neighborComments?.expectedNow || 0) - Number(engagementHealth?.neighborComments?.success || 0)),
        summary: `neighbor ${Number(engagementHealth?.neighborComments?.success || 0)}/${Number(engagementHealth?.neighborComments?.expectedNow || 0)}`,
      };
      const rest = entries.filter((item) => item.label !== 'neighbor');
      return [neighborEntry, ...rest];
    }
    if (
      engagementDoctorPriority?.primaryArea === 'engagement.ui'
      && (
        String(engagementDoctorPriority?.nextCommand || '').includes('run-neighbor-commenter.ts')
        || String(engagementDoctorPriority?.nextCommand || '').includes('replay:neighbor-ui')
      )
    ) {
      const neighborFirst = entries.find((item) => item.label === 'neighbor');
      const rest = entries.filter((item) => item.label !== 'neighbor');
      return neighborFirst ? [neighborFirst, ...rest] : entries;
    }
    if (engagementDoctorPriority?.primaryArea === 'engagement.target_gap.replies.no_workload') {
      const neighborFirst = entries.find((item) => item.label === 'neighbor');
      const rest = entries.filter((item) => item.label !== 'neighbor');
      return neighborFirst ? [neighborFirst, ...rest] : entries;
    }
    if (!doctorPrimaryLabel) return entries;
    const primaryEntry = entries.find((item) => item.label === doctorPrimaryLabel);
    const rest = entries.filter((item) => item.label !== doctorPrimaryLabel);
    return primaryEntry ? [primaryEntry, ...rest] : entries;
  })();
  const engagementRunPlanHint = orderedEngagementSteps
    .map((item, index) => `${index + 1}.${item.label}`)
    .join(' -> ');
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 블로팀 서비스 점검이 필요합니다.`,
      },
      {
        active: nodeHealth.warn.length > 0,
        level: 'medium',
        reason: `node-server/n8n 경고 ${nodeHealth.warn.length}건이 있어 실행 백엔드 상태 확인이 필요합니다.`,
      },
      {
        active: IMAGE_PROVIDER === 'drawthings' && nodeHealth.drawthingsOk === false,
        level: 'medium',
        reason: 'drawthings 이미지 API 응답이 없어 블로그 이미지 생성 경로를 사용할 수 없습니다.',
      },
      {
        active: dailyRunHealth.warn.length > 0,
        level: 'medium',
        reason: 'daily run 로그 활동성이 오래돼 최근 자동 실행 상태 확인이 필요합니다.',
      },
      {
        active: !n8nPipelineHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 블로 pipeline 워크플로우 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nPipelineHealth.n8nHealthy && !n8nPipelineHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 blog pipeline webhook이 미등록 상태입니다 (${n8nPipelineHealth.webhookReason}).`,
      },
      {
        active: instagramHealth.critical,
        level: 'high',
        reason: '인스타 토큰 만료가 임박해 릴스 업로드가 중단될 수 있습니다.',
      },
      {
        active: !instagramHealth.hostReady,
        level: 'medium',
        reason: '인스타 공개 미디어 호스팅이 준비되지 않아 릴스 업로드를 진행할 수 없습니다.',
      },
      {
        active: socialAutomationHealth.socialAssetDue
          && (socialAutomationHealth.reelCountToday <= 0 || socialAutomationHealth.instaCardCountToday <= 0),
        level: 'medium',
        reason: '오늘 shortform 릴스나 인스타 카드 산출물이 없어 소셜 자동등록 흐름이 비어 있을 수 있습니다.',
      },
      {
        active: socialAutomationHealth.instagramNeedsAttention,
        level: 'medium',
        reason: previewBundleHint
          ? `최근 인스타 자동등록 실패 이력이 있어 릴스/공개 URL/게시 경로 점검이 필요합니다. ${instagramDiagnoseHint}${socialActionHints.length ? ` / ${socialActionHints.join(' / ')}` : ''} / ${opsDoctorHint}${opsSocialActionHints.length ? ` / ${opsSocialActionHints.join(' / ')}` : ''} 최신 preview: ${previewBundleHint}`
          : `최근 인스타 자동등록 실패 이력이 있어 릴스/공개 URL/게시 경로 점검이 필요합니다. ${instagramDiagnoseHint}${socialActionHints.length ? ` / ${socialActionHints.join(' / ')}` : ''} / ${opsDoctorHint}${opsSocialActionHints.length ? ` / ${opsSocialActionHints.join(' / ')}` : ''}`,
      },
      {
        active: socialAutomationHealth.facebookNeedsAttention,
        level: 'medium',
        reason: previewBundleHint
          ? `${socialAutomationHealth.facebookReadiness?.error ? 'Facebook readiness 토큰/세션 이슈가 있어 다음 게시 전에 재발급 또는 재연결 확인이 필요합니다.' : '최근 페이스북 자동등록 실패 이력이 있어 권한/게시 경로 점검이 필요합니다.'} ${socialAutomationHealth.latestFacebookErrorSummary || ''}${socialAutomationHealth.facebookPageId ? ` page=${socialAutomationHealth.facebookPageId}` : ''}${Array.isArray(socialAutomationHealth.facebookPermissionScopes) && socialAutomationHealth.facebookPermissionScopes.length > 0 ? ` scopes=${socialAutomationHealth.facebookPermissionScopes.join(',')}` : ''} diagnose=${FACEBOOK_READINESS_COMMAND} / doctor=${FACEBOOK_DOCTOR_COMMAND} / social=${SOCIAL_DOCTOR_COMMAND}${socialActionHints.length ? ` / ${socialActionHints.join(' / ')}` : ''} / ${opsDoctorHint}${opsSocialActionHints.length ? ` / ${opsSocialActionHints.join(' / ')}` : ''} 최신 preview: ${previewBundleHint}`.trim()
          : `${socialAutomationHealth.facebookReadiness?.error ? 'Facebook readiness 토큰/세션 이슈가 있어 다음 게시 전에 재발급 또는 재연결 확인이 필요합니다.' : '최근 페이스북 자동등록 실패 이력이 있어 권한/게시 경로 점검이 필요합니다.'} ${socialAutomationHealth.latestFacebookErrorSummary || ''}${socialAutomationHealth.facebookPageId ? ` page=${socialAutomationHealth.facebookPageId}` : ''}${Array.isArray(socialAutomationHealth.facebookPermissionScopes) && socialAutomationHealth.facebookPermissionScopes.length > 0 ? ` scopes=${socialAutomationHealth.facebookPermissionScopes.join(',')}` : ''} diagnose=${FACEBOOK_READINESS_COMMAND} / doctor=${FACEBOOK_DOCTOR_COMMAND} / social=${SOCIAL_DOCTOR_COMMAND}${socialActionHints.length ? ` / ${socialActionHints.join(' / ')}` : ''} / ${opsDoctorHint}${opsSocialActionHints.length ? ` / ${opsSocialActionHints.join(' / ')}` : ''}`.trim(),
      },
      {
        active: socialAutomationHealth.publishLogExists === false,
        level: 'low',
        reason: '소셜 게시 telemetry 테이블이 없어 페이스북/외부 채널 자동등록 실적 추적이 충분하지 않습니다.',
      },
      {
        active: !phase2BriefingHealth.briefingPassed,
        level: 'medium',
        reason: '최신 포스팅의 AI Briefing 구조가 부족해 Phase 2 SEO 규칙 보강이 필요합니다.',
      },
      {
        active: phase3FeedbackHealth.status === 'warn' || phase3FeedbackHealth.status === 'error',
        level: 'medium',
        reason: 'Phase 3 피드백 신호에 실패나 경고가 있어 회고/재학습 입력을 확인할 필요가 있습니다.',
      },
      {
        active:
          phase4CompetitionHealth.status === 'warn' ||
          phase4CompetitionHealth.runningCount > 0 ||
          phase4CompetitionHealth.pendingCount > 0,
        level: 'medium',
        reason: 'Phase 4 경쟁 실험에 timeout 또는 경고가 있어 competition collector 흐름을 점검할 필요가 있습니다.',
      },
      {
        active: phase4CompetitionHealth.status === 'error',
        level: 'medium',
        reason: 'Phase 4 경쟁 실험 요약을 읽지 못해 competition 상태 확인이 필요합니다.',
      },
      {
        active: autonomyHealth.totalCount === 0,
        level: 'low',
        reason: '자율 판단 로그가 아직 쌓이지 않아 autonomy 루프는 warming-up 상태입니다.',
      },
      {
        active: marketingExpansionHealth.status === 'watch' || marketingExpansionHealth.status === 'error',
        level: 'low',
        reason: [
          '마케팅 확장 신호에 변동이 있어 sense/correlation/diagnosis 흐름을 한 번 더 보는 편이 좋습니다.',
          marketingExpansionHealth?.latestDigestRun?.checkedAt
            ? `최근 digest run: ${String(marketingExpansionHealth.latestDigestRun.checkedAt).slice(0, 19)} / ${String(marketingExpansionHealth.latestDigestRun.status || 'unknown')}`
            : '',
          marketingExpansionHealth?.nextGeneralPreview?.title
            ? `next preview: ${String(marketingExpansionHealth.nextGeneralPreview.title)}`
            : '',
          marketingDoctorHint,
          opsDoctorHint,
          String(opsDoctorPriority?.primaryArea || '').startsWith('marketing') && String(opsDoctorPriority?.nextCommand || '').trim()
            ? `즉시 실행: ${String(opsDoctorPriority.nextCommand).trim()}`
            : '',
        ].filter(Boolean).join(' '),
      },
      {
        active: engagementHealth.warnCount > 0 && !socialPrimaryActive,
        level: 'low',
        reason: [
          '댓글/답글/공감 실적이 시간대 기대치보다 낮거나 실패 이력이 있어 engagement 루프 점검이 필요합니다.',
          engagementPrimaryGap ? `최우선 gap: ${engagementPrimaryGap.label} ${engagementPrimaryGap.success}/${engagementPrimaryGap.expectedNow}` : '',
          engagementGapHint ? `현재 gap: ${engagementGapHint}` : '',
          engagementDoctorPriority?.primaryArea === 'engagement.target_gap.replies.no_workload'
            ? '현재 inbound는 reply 후보가 없어 gap이 유지되고 있습니다.'
            : '',
          engagementHealth?.lastGapRun?.allIdle
            ? `최근 fallback run도 idle: ${Array.isArray(engagementHealth.lastGapRun.attempted) ? engagementHealth.lastGapRun.attempted.map((item) => String(item?.label || '')).filter(Boolean).join(' -> ') : ''} / ${String(engagementHealth.lastGapRun.idleReason || '즉시 처리할 workload 없음')}`
            : '',
          engagementDoctorPriority?.primaryArea === 'engagement.target_gap.neighbor.no_workload'
            ? '현재 바로 처리할 neighbor comment queue가 없어 gap이 유지되고 있습니다.'
            : '',
          engagementDoctorPriority?.primaryArea === 'engagement.target_gap.neighbor.no_workload' && engagementHealth?.neighborCollectDiagnostics
            ? `최근 neighbor 수집 진단: buddy ${Number(engagementHealth.neighborCollectDiagnostics.buddyFeedSourceCount || 0)} / network ${Number(engagementHealth.neighborCollectDiagnostics.commenterNetworkSourceCount || 0)} / resolved ${Number(engagementHealth.neighborCollectDiagnostics.commenterNetworkResolvedCount || 0)} / collected ${Number(engagementHealth.neighborCollectDiagnostics.rawCollectedCount || 0)} / inserted ${Number(engagementHealth.neighborCollectDiagnostics.insertedCount || 0)} / resolve_fail ${Number(engagementHealth.neighborCollectDiagnostics.commenterNetworkResolveFailedCount || 0)}`
            : '',
          adaptiveCadenceHint,
          Number(engagementHealth?.courtesyReflectionRecheck?.reevaluableCount || 0) > 0
            ? `현재 inbound reply 정책으로 재평가 가능한 generic greeting 댓글: ${engagementHealth.courtesyReflectionRecheck.reevaluableCount}/${engagementHealth.courtesyReflectionRecheck.reviewedCount}`
            : '',
          engagementImmediateAction ? `즉시 실행: ${engagementImmediateAction}` : '',
          engagementRunPlanHint ? `실행 순서: ${engagementRunPlanHint}` : '',
          engagementFailureHint ? `최근 실패: ${engagementFailureHint}` : '',
          neighborReplayHint ? neighborReplayHint : '',
          neighborSympathyReplayHint ? neighborSympathyReplayHint : '',
          engagementReplayHint ? `재현: ${engagementReplayHint}` : '',
          engagementDoctorHint,
          opsDoctorHint,
          ...opsEngagementActionHints,
        ].filter(Boolean).join(' '),
      },
    ],
    okReason: '블로팀 실행기와 daily run 상태가 현재는 안정 구간입니다.',
  });
}

function buildRemodelProgress(instagramHealth, phase1Health, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth) {
  const phase0Status =
    instagramHealth.hostReady && !instagramHealth.critical ? 'completed' : 'in_progress';

  const phase1Status = phase1Health.summary ? 'completed' : 'in_progress';
  const phase2Status = phase2BriefingHealth.briefingPassed ? 'completed' : 'in_progress';
  const phase3Status = phase3FeedbackHealth.feedbackCount > 0 ? 'completed' : 'in_progress';
  const phase4Status = phase4CompetitionHealth.timeoutCount === 0 && phase4CompetitionHealth.status === 'ok'
    ? 'completed'
    : 'in_progress';
  const autonomyStatus = autonomyHealth.totalCount > 0 ? 'completed' : 'in_progress';

  const ok = [
    `  phase0 instagram: ${phase0Status === 'completed' ? '운영 준비 완료' : '운영 검증 진행중'}`,
    `  phase1 pipeline: ${phase1Status === 'completed' ? '완료' : '진행중'}`,
    `  phase2 briefing: ${phase2Status === 'completed' ? '완료' : '진행중'}`,
    `  phase3 feedback: ${phase3Status === 'completed' ? '실데이터 축적 시작' : 'warming_up'}`,
    `  phase4 competition: ${phase4Status === 'completed' ? '정상화 완료' : '정리중'}`,
    `  autonomy: ${autonomyStatus === 'completed' ? '실데이터 축적 중' : 'warming_up'}`,
  ];

  const warn = [];
  if (phase3Status !== 'completed') {
    warn.push('  phase3 feedback: published 이후 후속 피드백 수집이 더 쌓여야 합니다');
  }
  if (phase0Status !== 'completed') {
    warn.push('  phase0 instagram: 실업로드 운영 검증이 아직 남아 있습니다');
  }

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    phase0: phase0Status,
    phase1: phase1Status,
    phase2: phase2Status,
    phase3: phase3Status,
    phase4: phase4Status,
    autonomy: autonomyStatus,
  };
}

function buildOpsPriority(socialAutomationHealth, engagementHealth, marketingExpansionHealth, socialDoctorPriority = null, engagementDoctorPriority = null, marketingDoctorPriority = null, opsDoctorPriority = null) {
  const ok = [`  ops doctor command: ${BLOG_OPS_DOCTOR_COMMAND}`];
  const warn = [];

  let primaryArea = 'clear';
  let primaryReason = '지금은 즉시 막히는 운영 병목보다 다음 운영 사이클 관찰이 우선입니다.';
  let nextCommand = '';
  let actionFocus = '';

  if (socialDoctorPriority?.primaryArea && socialDoctorPriority.primaryArea !== 'clear' && socialDoctorPriority.primaryArea !== 'unknown') {
    primaryArea = socialDoctorPriority.primaryArea;
    primaryReason = socialDoctorPriority.primaryReason || primaryReason;
    nextCommand = socialDoctorPriority.nextCommand || SOCIAL_DOCTOR_COMMAND;
    actionFocus = socialDoctorPriority.actionFocus || 'social';
  } else if (engagementDoctorPriority?.primaryArea && engagementDoctorPriority.primaryArea !== 'clear' && engagementDoctorPriority.primaryArea !== 'unknown') {
    primaryArea = engagementDoctorPriority.primaryArea;
    primaryReason = engagementDoctorPriority.primaryReason || primaryReason;
    nextCommand = engagementDoctorPriority.nextCommand || ENGAGEMENT_DOCTOR_COMMAND;
    actionFocus = engagementDoctorPriority.actionFocus || 'engagement';
  } else if (marketingDoctorPriority?.primaryArea && marketingDoctorPriority.primaryArea !== 'clear' && marketingDoctorPriority.primaryArea !== 'unknown') {
    primaryArea = marketingDoctorPriority.primaryArea;
    primaryReason = marketingDoctorPriority.primaryReason || primaryReason;
    nextCommand = marketingDoctorPriority.nextCommand || MARKETING_DOCTOR_COMMAND;
    actionFocus = marketingDoctorPriority.actionFocus || 'marketing';
  } else if (socialAutomationHealth.facebookNeedsAttention) {
    primaryArea = 'social.facebook';
    primaryReason = 'Facebook publish 권한 이슈가 현재 최우선 병목입니다.';
    nextCommand = SOCIAL_DOCTOR_COMMAND;
    actionFocus = 'social.facebook';
  } else if (socialAutomationHealth.instagramNeedsAttention) {
    primaryArea = 'social.instagram';
    primaryReason = 'Instagram publish/readiness 이슈가 현재 최우선 병목입니다.';
    nextCommand = SOCIAL_DOCTOR_COMMAND;
    actionFocus = 'social.instagram';
  } else if ((engagementHealth?.warnCount || 0) > 0) {
    primaryArea = 'engagement';
    primaryReason = '답글/댓글/공감 자동화 이슈가 현재 최우선 병목입니다.';
    nextCommand = ENGAGEMENT_DOCTOR_COMMAND;
    actionFocus = 'engagement';
  } else if (String(marketingExpansionHealth?.status || '') === 'watch' || String(marketingExpansionHealth?.status || '') === 'error') {
    primaryArea = 'marketing.watch';
    primaryReason = '마케팅 확장 신호 watch 상태가 현재 최우선 병목입니다.';
    nextCommand = MARKETING_DOCTOR_COMMAND;
    actionFocus = 'marketing';
  }

  ok.push(`  primary blocker: ${primaryArea} / ${primaryReason}`);
  if (nextCommand) {
    ok.push(`  next command: ${nextCommand}`);
  }
  if (actionFocus) {
    ok.push(`  next action focus: ${actionFocus}`);
  }
  if (primaryArea !== 'clear' && primaryArea !== 'unknown') {
    for (const action of Array.isArray(opsDoctorPriority?.actions) ? opsDoctorPriority.actions.slice(0, 2) : []) {
      ok.push(`  ops action: ${action}`);
    }
  }
  if (primaryArea.startsWith('marketing') && marketingExpansionHealth?.latestDigestRun?.checkedAt) {
    const latestDigestAge = describeMarketingDigestAge(marketingExpansionHealth.latestDigestRun);
    ok.push(`  latest digest run: ${String(marketingExpansionHealth.latestDigestRun.checkedAt).slice(0, 19)} / ${String(marketingExpansionHealth.latestDigestRun.status || 'unknown')}${latestDigestAge.text ? ` / ${latestDigestAge.text}` : ''}`);
  }
  if (primaryArea.startsWith('marketing') && marketingExpansionHealth?.nextGeneralPreview?.title) {
    ok.push(`  next preview: ${String(marketingExpansionHealth.nextGeneralPreview.title)}`);
  }
  if (primaryArea.startsWith('marketing') && Array.isArray(marketingExpansionHealth?.recommendations) && marketingExpansionHealth.recommendations[0]) {
    ok.push(`  top recommendation: ${String(marketingExpansionHealth.recommendations[0])}`);
  }
  if (primaryArea !== 'clear') {
    warn.push(`  next action focus: ${actionFocus || primaryArea}`);
  }

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    primaryArea,
    primaryReason,
    nextCommand,
    actionFocus,
  };
}

function formatText(report) {
  return buildHealthReport({
    title: '📰 블로 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ 리모델링 진행 요약', report.remodelProgress, { okLimit: 6, warnLimit: 3 }),
      buildHealthCountSection('■ 실행 백엔드 상태', report.nodeHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n pipeline 경로', report.n8nPipelineHealth, { okLimit: 2 }),
      buildHealthCountSection('■ 인스타 업로드 상태', report.instagramHealth, { okLimit: 3 }),
      buildHealthCountSection('■ 소셜 자동등록 상태', report.socialAutomationHealth, { okLimit: 6, warnLimit: 5 }),
      buildHealthCountSection('■ 댓글·공감 운영 상태', report.engagementHealth, { okLimit: 5, warnLimit: 5 }),
      buildHealthCountSection('■ Elixir Phase 1 상태', report.phase1Health, { okLimit: 1, warnLimit: 2 }),
      buildHealthCountSection('■ Phase 2 Briefing 상태', report.phase2BriefingHealth, { okLimit: 3, warnLimit: 4 }),
      buildHealthCountSection('■ Phase 3 Feedback 상태', report.phase3FeedbackHealth, { okLimit: 4, warnLimit: 3 }),
      buildHealthCountSection('■ Phase 4 Competition 상태', report.phase4CompetitionHealth, { okLimit: 5, warnLimit: 3 }),
      buildHealthCountSection('■ Autonomy 상태', report.autonomyHealth, { okLimit: 5, warnLimit: 2 }),
      buildHealthCountSection('■ Marketing 확장 상태', report.marketingExpansionHealth, { okLimit: 5, warnLimit: 4 }),
      buildHealthCountSection('■ 도서 카탈로그 상태', report.bookCatalogHealth, { okLimit: 4 }),
      buildHealthCountSection('■ 도서리뷰 큐 상태', report.bookReviewQueueHealth, { okLimit: 3 }),
      buildHealthCountSection('■ Doctor 우선순위', report.doctorPriority, { okLimit: 6, warnLimit: 2 }),
      buildHealthCountSection('■ Ops 우선순위', report.opsPriority, { okLimit: 4, warnLimit: 2 }),
      buildHealthCountSection('■ daily run 상태', report.dailyRunHealth, { warnLimit: 4, okLimit: 2 }),
      {
        title: null,
        lines: buildHealthDecisionSection({
          title: '■ 운영 판단',
          recommended: report.decision.recommended,
          level: report.decision.level,
          reasons: report.decision.reasons,
          okText: '현재는 추가 조치보다 관찰 유지',
        }),
      },
    ].filter(Boolean),
    footer: ['실행: node bots/blog/scripts/health-report.ts --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus(ALL_SERVICES);
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.blog.', ''),
  });
  const nodeHealth = await buildNodeHealth();
  const dailyRunHealth = buildDailyRunHealth(status['ai.blog.daily']);
  const n8nPipelineHealth = await buildN8nPipelineHealth();
  const instagramHealth = await buildInstagramHealth();
  const socialAutomationHealth = await buildSocialAutomationHealth();
  const engagementHealth = await buildEngagementHealth();
  const phase1Health = await buildPhase1Health();
  const phase2BriefingHealth = await buildPhase2BriefingHealth();
  const phase3FeedbackHealth = await buildPhase3FeedbackHealth();
  const phase4CompetitionHealth = await buildPhase4CompetitionHealth();
  const autonomyHealth = await buildAutonomyHealth();
  const marketingExpansionHealth = await buildMarketingExpansionHealth();
  const bookCatalogHealth = await buildBookCatalogHealth();
  const bookReviewQueueHealth = await buildBookReviewQueueHealth();
  const socialDoctorPriority = buildDoctorPriority(SOCIAL_DOCTOR_COMMAND, 'social doctor');
  const engagementDoctorPriority = buildDoctorPriority(ENGAGEMENT_DOCTOR_COMMAND, 'engagement doctor');
  const marketingDoctorPriority = buildDoctorPriority(MARKETING_DOCTOR_COMMAND, 'marketing doctor');
  const opsDoctorPriority = buildDoctorPriority(BLOG_OPS_DOCTOR_COMMAND, 'ops doctor');
  const decision = buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth, instagramHealth, socialAutomationHealth, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth, marketingExpansionHealth, engagementHealth, socialDoctorPriority, engagementDoctorPriority, opsDoctorPriority);
  const remodelProgress = buildRemodelProgress(instagramHealth, phase1Health, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth);
  const doctorPriority = {
    okCount: socialDoctorPriority.okCount + engagementDoctorPriority.okCount + marketingDoctorPriority.okCount,
    warnCount: socialDoctorPriority.warnCount + engagementDoctorPriority.warnCount + marketingDoctorPriority.warnCount,
    ok: [
      ...socialDoctorPriority.ok,
      ...engagementDoctorPriority.ok,
      ...marketingDoctorPriority.ok,
    ],
    warn: [
      ...socialDoctorPriority.warn,
      ...engagementDoctorPriority.warn,
      ...marketingDoctorPriority.warn,
    ],
    social: socialDoctorPriority,
    engagement: engagementDoctorPriority,
    marketing: marketingDoctorPriority,
  };
  const opsPriority = buildOpsPriority(socialAutomationHealth, engagementHealth, marketingExpansionHealth, socialDoctorPriority, engagementDoctorPriority, marketingDoctorPriority, opsDoctorPriority);

  return {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    nodeHealth: {
      okCount: nodeHealth.ok.length,
      warnCount: nodeHealth.warn.length,
      ok: nodeHealth.ok,
      warn: nodeHealth.warn,
    },
    dailyRunHealth: {
      okCount: dailyRunHealth.ok.length,
      warnCount: dailyRunHealth.warn.length,
      ok: dailyRunHealth.ok,
      warn: dailyRunHealth.warn,
      minutesAgo: dailyRunHealth.minutesAgo,
    },
    n8nPipelineHealth: {
      okCount: n8nPipelineHealth.ok.length,
      warnCount: n8nPipelineHealth.warn.length,
      ok: n8nPipelineHealth.ok,
      warn: n8nPipelineHealth.warn,
      webhookRegistered: n8nPipelineHealth.webhookRegistered,
      webhookReason: n8nPipelineHealth.webhookReason,
      webhookStatus: n8nPipelineHealth.webhookStatus,
      webhookUrl: n8nPipelineHealth.webhookUrl,
      resolvedWebhookUrl: n8nPipelineHealth.resolvedWebhookUrl,
    },
    instagramHealth,
    socialAutomationHealth,
    engagementHealth,
    phase1Health,
    phase2BriefingHealth,
    phase3FeedbackHealth,
    phase4CompetitionHealth,
    autonomyHealth,
    marketingExpansionHealth,
    remodelProgress,
    bookCatalogHealth,
    bookReviewQueueHealth,
    doctorPriority,
    opsPriority,
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[블로 운영 헬스 리포트]',
});

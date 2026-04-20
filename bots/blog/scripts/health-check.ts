#!/usr/bin/env node
'use strict';

/**
 * scripts/health-check.ts — 블로그팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 스케줄: daily (06:00 KST 자동 실행)
 *
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.ts
 * 자동: launchd ai.blog.health-check (10분마다)
 */

const http = require('http');
const hsm = require('../../../packages/core/lib/health-state-manager');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');
const {
  getLaunchctlStatus,
  DEFAULT_NORMAL_EXIT_CODES,
} = require('../../../packages/core/lib/health-provider');
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { createHealthMemoryHelper } = require('../lib/health-memory-bridge.js');
const {
  canonicalizeBlogCriticalAlert,
  appendIncidentLine,
} = require('../lib/critical-alerts.js');
const { resolveInstagramHostedMediaUrl } = require('../../../packages/core/lib/instagram-image-host.ts');

const runtimeConfig = getBlogHealthRuntimeConfig();
const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'blog.health',
  team: 'blog',
  domain: 'blog health',
});
const NODE_SERVER_HEALTH_URL = new URL(runtimeConfig.nodeServerHealthUrl || 'http://127.0.0.1:3100/health');
const N8N_HEALTH_URL = new URL(runtimeConfig.n8nHealthUrl || 'http://127.0.0.1:5678/healthz');
const IMAGE_PROVIDER = String(process.env.BLOG_IMAGE_PROVIDER || 'drawthings').toLowerCase();
const IMAGE_BASE_URL = String(process.env.BLOG_IMAGE_BASE_URL || 'http://127.0.0.1:7860');
const DRAWTHINGS_HEALTH_URL = new URL('/sdapi/v1/options', IMAGE_BASE_URL.endsWith('/') ? IMAGE_BASE_URL : `${IMAGE_BASE_URL}/`);
const NODE_SERVER_TIMEOUT_MS = Number(runtimeConfig.nodeServerTimeoutMs || 3000);
const N8N_HEALTH_TIMEOUT_MS = Number(runtimeConfig.n8nHealthTimeoutMs || 2500);
const IMAGE_HEALTH_TIMEOUT_MS = 2500;
const COMMENTER_CONFIG = runtimeConfig.commenter || {};
const COMMENTER_ACTIVE_START_HOUR = Number(COMMENTER_CONFIG.activeStartHour || 9);
const COMMENTER_ACTIVE_END_HOUR = Number(COMMENTER_CONFIG.activeEndHour || 21);

function buildPreviewBundleForTitle(title = '') {
  try {
    const {
      findReelPathForTitle,
      findReelCoverPathForTitle,
      findReelQaSheetPathForTitle,
    } = require('../lib/shortform-files.ts');
    const reelPath = findReelPathForTitle(title) || '';
    const coverPath = findReelCoverPathForTitle(title) || '';
    const qaSheetPath = findReelQaSheetPathForTitle(title) || '';
    const parts = [
      reelPath ? `reel=${resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' }).publicUrl || reelPath}` : '',
      coverPath ? `cover=${resolveInstagramHostedMediaUrl(coverPath, { kind: 'thumbs' }).publicUrl || coverPath}` : '',
      qaSheetPath ? `qa=${resolveInstagramHostedMediaUrl(qaSheetPath, { kind: 'thumbs' }).publicUrl || qaSheetPath}` : '',
    ].filter(Boolean);
    return parts.join(' / ');
  } catch {
    return '';
  }
}

function getHostedReelStatusForTitle(title = '') {
  try {
    const {
      findReelPathForTitle,
    } = require('../lib/shortform-files.ts');
    const reelPath = findReelPathForTitle(title) || '';
    if (!reelPath) return { reelPath: '', hostedReady: false, hostedUrl: '' };
    const hosted = resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' });
    return {
      reelPath,
      hostedReady: hosted?.ready === true,
      hostedUrl: hosted?.publicUrl || '',
    };
  } catch {
    return { reelPath: '', hostedReady: false, hostedUrl: '' };
  }
}

async function notify(msg, level = 3) {
  try {
    const incidentState = canonicalizeBlogCriticalAlert({
      event_type: 'blog_health_check',
      alert_level: level,
      message: msg,
    });
    if (incidentState.suppress) return;
    await publishToWebhook({
      event: {
        from_bot: 'blog-health',
        team: 'blog',
        event_type: 'blog_health_check',
        alert_level: level,
        message: appendIncidentLine(msg, incidentState.signature, incidentState.incident),
      },
    });
  } catch {
    // ignore
  }
}

const CONTINUOUS = [];

const ALL_SERVICES = [
  'ai.blog.daily',
  'ai.blog.node-server',
];

const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;

function checkNodeServerHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: NODE_SERVER_HEALTH_URL.hostname,
        port: Number(NODE_SERVER_HEALTH_URL.port || 80),
        path: `${NODE_SERVER_HEALTH_URL.pathname}${NODE_SERVER_HEALTH_URL.search}`,
        method: 'GET',
        timeout: NODE_SERVER_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok === true) {
              resolve({ ok: true, detail: `포트 ${json.port || 3100} 응답 정상` });
            } else {
              resolve({ ok: false, detail: `비정상 응답: ${body.slice(0, 80)}` });
            }
          } catch {
            resolve({ ok: false, detail: `JSON 파싱 실패 (HTTP ${res.statusCode})` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: `응답 없음 (${NODE_SERVER_TIMEOUT_MS}ms 타임아웃)` });
    });
    req.on('error', (e) => {
      resolve({ ok: false, detail: e.code === 'ECONNREFUSED' ? `포트 ${NODE_SERVER_HEALTH_URL.port || 80} 연결 거부` : e.message.slice(0, 80) });
    });
    req.end();
  });
}

function checkN8nHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: N8N_HEALTH_URL.hostname,
        port: Number(N8N_HEALTH_URL.port || 80),
        path: `${N8N_HEALTH_URL.pathname}${N8N_HEALTH_URL.search}`,
        method: 'GET',
        timeout: N8N_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.status === 'ok') {
              resolve({ ok: true, detail: 'n8n healthz 정상' });
            } else {
              resolve({ ok: false, detail: `비정상 응답: ${body.slice(0, 80)}` });
            }
          } catch {
            resolve({ ok: false, detail: `JSON 파싱 실패 (HTTP ${res.statusCode})` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: `응답 없음 (${N8N_HEALTH_TIMEOUT_MS}ms 타임아웃)` });
    });
    req.on('error', (e) => {
      resolve({ ok: false, detail: e.code === 'ECONNREFUSED' ? `포트 ${N8N_HEALTH_URL.port || 80} 연결 거부` : e.message.slice(0, 80) });
    });
    req.end();
  });
}

function checkDrawThingsHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: DRAWTHINGS_HEALTH_URL.hostname,
        port: Number(DRAWTHINGS_HEALTH_URL.port || 80),
        path: `${DRAWTHINGS_HEALTH_URL.pathname}${DRAWTHINGS_HEALTH_URL.search}`,
        method: 'GET',
        timeout: IMAGE_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, detail: `drawthings API 응답 정상 (${DRAWTHINGS_HEALTH_URL.host})` });
            return;
          }
          resolve({ ok: false, detail: `drawthings API 응답 비정상 (HTTP ${res.statusCode || 'unknown'})` });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: `drawthings API 응답 없음 (${IMAGE_HEALTH_TIMEOUT_MS}ms 타임아웃)` });
    });
    req.on('error', (e) => {
      resolve({
        ok: false,
        detail: e.code === 'ECONNREFUSED'
          ? `drawthings API 연결 거부 (${DRAWTHINGS_HEALTH_URL.host})`
          : `drawthings API 오류: ${e.message.slice(0, 80)}`,
      });
    });
    req.end();
  });
}

async function checkBookCatalogHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE source = 'canonical'), 0)::int AS canonical_count,
        COALESCE(count(*) FILTER (WHERE source = 'data4library'), 0)::int AS popular_count
      FROM blog.book_catalog
    `);
    const row = rows?.[0];
    if (!row) {
      return { ok: false, detail: 'book_catalog 조회 결과 없음' };
    }
    return {
      ok: true,
      detail: `book_catalog ${row.total_count}권 (canonical ${row.canonical_count}, popular ${row.popular_count})`,
    };
  } catch (e) {
    return { ok: false, detail: `book_catalog 확인 실패: ${e.message.slice(0, 120)}` };
  } finally {
    await pgPool.closeAll().catch(() => {});
  }
}

async function checkFacebookPublishHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, title, error, created_at
      FROM blog.publish_log
      WHERE platform = 'facebook'
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const list = Array.isArray(rows) ? rows : [];
    const row = list[0];
    if (!row) {
      return { ok: true, detail: 'facebook publish history 없음', latest: null };
    }

    const createdAt = new Date(row.created_at);
    const ageMs = Date.now() - createdAt.getTime();
    const recentEnough = Number.isFinite(ageMs) && ageMs <= (72 * 60 * 60 * 1000);
    const isTodayKst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(createdAt) === new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const errorText = String(row.error || '');
    const permissionIssue =
      errorText.includes('pages_manage_posts')
      || errorText.includes('pages_read_engagement')
      || errorText.includes('Facebook 페이지 게시 권한 부족');

    const hasRecentSuccess = list.some((item) => String(item.status || '') === 'success');

    if (String(row.status || '') === 'failed' && permissionIssue && (isTodayKst || (recentEnough && !hasRecentSuccess))) {
      const previewBundle = buildPreviewBundleForTitle(String(row.title || ''));
      return {
        ok: false,
        detail: `Facebook 페이지 게시 권한 부족 — ${String(row.title || '').slice(0, 60)}${previewBundle ? `\npreview: ${previewBundle}` : ''}`,
        latest: row,
      };
    }

    return {
      ok: true,
      detail: `facebook latest ${String(row.status || 'unknown')}`,
      latest: row,
    };
  } catch (e) {
    return { ok: false, detail: `facebook publish 확인 실패: ${e.message.slice(0, 120)}`, latest: null };
  }
}

async function checkInstagramPublishHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, dry_run, error_msg, post_title, created_at
      FROM blog.instagram_crosspost
      ORDER BY created_at DESC
      LIMIT 8
    `);
    const list = Array.isArray(rows) ? rows : [];
    const row = list[0];
    if (!row) {
      return { ok: true, detail: 'instagram crosspost history 없음', latest: null };
    }

    const latestReal = list.find((item) => !item.dry_run) || null;
    if (!latestReal) {
      return { ok: true, detail: 'instagram real publish history 없음', latest: row };
    }

    const createdAt = new Date(latestReal.created_at);
    const ageMs = Date.now() - createdAt.getTime();
    const recentEnough = Number.isFinite(ageMs) && ageMs <= (48 * 60 * 60 * 1000);
    const isTodayKst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(createdAt) === new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const hasRecentSuccess = list.some((item) => !item.dry_run && String(item.status || '') === 'success');
    const latestTitle = String(latestReal.post_title || '');
    const errorText = String(latestReal.error_msg || '');
    const hostedStatus = getHostedReelStatusForTitle(latestTitle);
    const hostedAssetRecovered =
      hostedStatus.hostedReady
      && errorText.includes('Instagram 공개 비디오 파일이 아직 준비되지 않았습니다');

    if (hostedAssetRecovered) {
      return {
        ok: true,
        detail: `instagram hosted media 회복 — ${latestTitle.slice(0, 60)}`,
        latest: latestReal,
      };
    }

    if (String(latestReal.status || '') === 'failed' && (isTodayKst || (recentEnough && !hasRecentSuccess))) {
      const previewBundle = buildPreviewBundleForTitle(latestTitle);
      return {
        ok: false,
        detail: `Instagram 자동등록 실패 — ${latestTitle.slice(0, 60)}\n${errorText.slice(0, 120)}${previewBundle ? `\npreview: ${previewBundle}` : ''}`,
        latest: latestReal,
      };
    }

    return {
      ok: true,
      detail: `instagram latest real ${String(latestReal.status || 'unknown')}`,
      latest: latestReal,
    };
  } catch (e) {
    return { ok: false, detail: `instagram publish 확인 실패: ${e.message.slice(0, 120)}`, latest: null };
  }
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
    || errorText.includes('comment_submit_not_confirmed')
    || errorText.includes('reply_ui_unavailable')
    || errorText.includes('reply_editor_not_found')
  ) {
    return 'ui';
  }

  if (
    errorText.includes('ECONNREFUSED')
    || errorText.includes('__name is not defined')
    || errorText.includes('browser')
    || errorText.includes('ws 연결 실패')
  ) {
    return 'browser';
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

  return 'unknown';
}

function isCommenterActiveWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hour = now.getHours() + (now.getMinutes() / 60);
  return hour >= COMMENTER_ACTIVE_START_HOUR && hour <= COMMENTER_ACTIVE_END_HOUR;
}

async function checkEngagementAutomationHealth() {
  try {
    const activeWindow = isCommenterActiveWindow();
    const rows = await pgPool.query('blog', `
      SELECT action_type, meta
      FROM blog.comment_actions
      WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
        AND success = false
      ORDER BY executed_at DESC
      LIMIT 50
    `);

    const failureByKind = { ui: 0, browser: 0, llm: 0, verification: 0, unknown: 0 };
    const failureByAction = { reply: 0, neighbor_comment: 0, sympathy: 0 };
    for (const row of rows || []) {
      const kind = classifyEngagementFailure(row.meta || {});
      failureByKind[kind] = Number(failureByKind[kind] || 0) + 1;
      const actionType = String(row.action_type || '');
      if (actionType === 'reply') failureByAction.reply += 1;
      else if (actionType === 'neighbor_comment') failureByAction.neighbor_comment += 1;
      else if (actionType.includes('sympathy')) failureByAction.sympathy += 1;
    }

    const totalFailures = (rows || []).length;
    if (!activeWindow || totalFailures <= 0) {
      return {
        ok: true,
        detail: activeWindow ? 'engagement failures 없음' : 'engagement 비활성 시간대',
        failureByKind,
        failureByAction,
      };
    }

    if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
      return {
        ok: false,
        detail: `engagement UI/browser failures — reply ${failureByAction.reply}, neighbor ${failureByAction.neighbor_comment}, sympathy ${failureByAction.sympathy}`,
        failureByKind,
        failureByAction,
      };
    }

    return {
      ok: true,
      detail: `engagement failures present but non-UI (${totalFailures}건)`,
      failureByKind,
      failureByAction,
    };
  } catch (e) {
    return { ok: false, detail: `engagement 확인 실패: ${e.message.slice(0, 120)}` };
  }
}

async function main() {
  console.log(`[블로그 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus(ALL_SERVICES);
  } catch (e) {
    console.error(`[블로그 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state = hsm.loadState();
  const issues = [];

  for (const label of ALL_SERVICES) {
    const svc = status[label];
    const shortName = hsm.shortLabel(label);

    if (!svc) {
      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [블로그 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
      }
      continue;
    }

    if (state[`unloaded:${label}`]) {
      const recoveryMsg = `✅ [블로그 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(`unloaded:${label}`, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `⚠️ [블로그 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    } else {
      const prevKeys = Object.keys(state).filter((k) => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        const recoveryMsg = `✅ [블로그 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`;
        await notify(recoveryMsg, 1);
        await rememberHealthEvent(`exitcode:${label}:0`, 'recovery', recoveryMsg, 1);
        prevKeys.forEach((k) => hsm.clearAlert(state, k));
      }
    }
  }

  if (status['ai.blog.node-server']?.running) {
    const nodeServer = /** @type {any} */ (await checkNodeServerHealth());
    const key = 'node-server:http';
    // @ts-ignore checkJs is too narrow for runtime health payloads
    if (!nodeServer.ok) {
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: 2,
          // @ts-ignore checkJs is too narrow for runtime health payloads
          msg: `⚠️ [블로그 헬스] node-server 비정상\n${nodeServer.detail}`,
        });
      }
    } else if (state[key]) {
      // @ts-ignore checkJs is too narrow for runtime health payloads
      const recoveryMsg = `✅ [블로그 헬스] node-server 회복\n${nodeServer.detail}`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(key, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, key);
    }
  }

  const n8nHealth = /** @type {any} */ (await checkN8nHealth());
  const n8nKey = 'n8n:http';
  // @ts-ignore checkJs is too narrow for runtime health payloads
  if (!n8nHealth.ok) {
    if (hsm.canAlert(state, n8nKey)) {
      issues.push({
        key: n8nKey,
        level: 1,
        // @ts-ignore checkJs is too narrow for runtime health payloads
        msg: `⚠️ [블로그 헬스] n8n 비정상\n${n8nHealth.detail}\n직접 실행 폴백은 가능하지만 웹훅 경로를 점검하세요.`,
      });
    }
  } else if (state[n8nKey]) {
      // @ts-ignore checkJs is too narrow for runtime health payloads
      const recoveryMsg = `✅ [블로그 헬스] n8n 회복\n${n8nHealth.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(n8nKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, n8nKey);
  }

  if (IMAGE_PROVIDER === 'drawthings' || IMAGE_PROVIDER === 'draw-things') {
    const imageHealth = /** @type {any} */ (await checkDrawThingsHealth());
    const imageKey = 'drawthings:http';
    // @ts-ignore checkJs is too narrow for runtime health payloads
    if (!imageHealth.ok) {
      if (hsm.canAlert(state, imageKey)) {
        issues.push({
          key: imageKey,
          level: 2,
          // @ts-ignore checkJs is too narrow for runtime health payloads
          msg: `⚠️ [블로그 헬스] drawthings 비정상\n${imageHealth.detail}`,
        });
      }
    } else if (state[imageKey]) {
      // @ts-ignore checkJs is too narrow for runtime health payloads
      const recoveryMsg = `✅ [블로그 헬스] drawthings 회복\n${imageHealth.detail}`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(imageKey, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, imageKey);
    }
  }

  const bookCatalog = await checkBookCatalogHealth();
  const bookCatalogKey = 'book-catalog:db';
  if (!bookCatalog.ok) {
    if (hsm.canAlert(state, bookCatalogKey)) {
      issues.push({
        key: bookCatalogKey,
        level: 2,
        msg: `⚠️ [블로그 헬스] book_catalog 비정상\n${bookCatalog.detail}`,
      });
    }
  } else if (state[bookCatalogKey]) {
    const recoveryMsg = `✅ [블로그 헬스] book_catalog 회복\n${bookCatalog.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(bookCatalogKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, bookCatalogKey);
  }

  const instagramPublish = await checkInstagramPublishHealth();
  const instagramPublishKey = 'instagram-publish:recent-failure';
  if (!instagramPublish.ok) {
    if (hsm.canAlert(state, instagramPublishKey)) {
      issues.push({
        key: instagramPublishKey,
        level: 2,
        msg: `⚠️ [블로그 헬스] Instagram 자동등록 이슈\n${instagramPublish.detail}`,
      });
    }
  } else if (state[instagramPublishKey]) {
    const recoveryMsg = `✅ [블로그 헬스] Instagram 자동등록 회복\n${instagramPublish.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(instagramPublishKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, instagramPublishKey);
  }

  const facebookPublish = await checkFacebookPublishHealth();
  const facebookPublishKey = 'facebook-publish:permission';
  if (!facebookPublish.ok) {
    if (hsm.canAlert(state, facebookPublishKey)) {
      issues.push({
        key: facebookPublishKey,
        level: 3,
        msg: `⚠️ [블로그 헬스] Facebook 자동등록 권한 이슈\n${facebookPublish.detail}`,
      });
    }
  } else if (state[facebookPublishKey]) {
    const recoveryMsg = `✅ [블로그 헬스] Facebook 자동등록 회복\n${facebookPublish.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(facebookPublishKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, facebookPublishKey);
  }

  const engagementAutomation = await checkEngagementAutomationHealth();
  const engagementAutomationKey = 'engagement:ui';
  if (!engagementAutomation.ok) {
    if (hsm.canAlert(state, engagementAutomationKey)) {
      issues.push({
        key: engagementAutomationKey,
        level: 2,
        msg: `⚠️ [블로그 헬스] engagement 자동화 이슈\n${engagementAutomation.detail}`,
      });
    }
  } else if (state[engagementAutomationKey]) {
    const recoveryMsg = `✅ [블로그 헬스] engagement 자동화 회복\n${engagementAutomation.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(engagementAutomationKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, engagementAutomationKey);
  }

  for (const { key, level, msg } of issues) {
    console.warn(`[블로그 헬스체크] 이슈: ${msg}`);
    const memoryHints = await buildIssueHints(key, msg);
    await notify(`${msg}${memoryHints}`, level);
    await rememberHealthEvent(key, 'issue', msg, level);
    hsm.recordAlert(state, key);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[블로그 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch((e) => {
  console.error(`[블로그 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});

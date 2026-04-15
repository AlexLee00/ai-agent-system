#!/usr/bin/env node
// @ts-nocheck
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
const { createHealthMemoryHelper } = require('../../../packages/core/lib/health-memory');

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

async function notify(msg, level = 3) {
  try {
    await publishToWebhook({
      event: {
        from_bot: 'blog-health',
        team: 'blog',
        event_type: 'blog_health_check',
        alert_level: level,
        message: msg,
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
    const nodeServer = await checkNodeServerHealth();
    const key = 'node-server:http';
    if (!nodeServer.ok) {
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [블로그 헬스] node-server 비정상\n${nodeServer.detail}`,
        });
      }
    } else if (state[key]) {
      const recoveryMsg = `✅ [블로그 헬스] node-server 회복\n${nodeServer.detail}`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(key, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, key);
    }
  }

  const n8nHealth = await checkN8nHealth();
  const n8nKey = 'n8n:http';
  if (!n8nHealth.ok) {
    if (hsm.canAlert(state, n8nKey)) {
      issues.push({
        key: n8nKey,
        level: 1,
        msg: `⚠️ [블로그 헬스] n8n 비정상\n${n8nHealth.detail}\n직접 실행 폴백은 가능하지만 웹훅 경로를 점검하세요.`,
      });
    }
  } else if (state[n8nKey]) {
    const recoveryMsg = `✅ [블로그 헬스] n8n 회복\n${n8nHealth.detail}`;
    await notify(recoveryMsg, 1);
    await rememberHealthEvent(n8nKey, 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, n8nKey);
  }

  if (IMAGE_PROVIDER === 'drawthings' || IMAGE_PROVIDER === 'draw-things') {
    const imageHealth = await checkDrawThingsHealth();
    const imageKey = 'drawthings:http';
    if (!imageHealth.ok) {
      if (hsm.canAlert(state, imageKey)) {
        issues.push({
          key: imageKey,
          level: 2,
          msg: `⚠️ [블로그 헬스] drawthings 비정상\n${imageHealth.detail}`,
        });
      }
    } else if (state[imageKey]) {
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

// @ts-nocheck
'use strict';

/**
 * bots/worker/lib/logger.js — OWASP 기반 접근/에러/인증 로그
 *
 * accessLogger(req, res, next)       — 모든 요청 자동 기록 (미들웨어)
 * errorLogger(err, req, res, next)   — 500 에러 자동 기록 (미들웨어)
 * logAuth(action, username, ip, ua, detail) — 로그인/로그아웃 특별 기록
 * logSecurity(req, action, detail)   — 권한 오류 등 보안 이벤트 기록
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

// 민감 정보 필드 — 절대 기록 금지 (OWASP)
const BLOCKED_FIELDS = new Set(['password', 'password_hash', 'new_password', 'current_password', 'token']);

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {};
  const safe = {};
  for (const [k, v] of Object.entries(body)) {
    safe[k] = BLOCKED_FIELDS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return safe;
}

// ── 접근 로그 미들웨어 ─────────────────────────────────────────────

function accessLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    // 헬스체크, 정적 파일은 제외
    if (req.path === '/api/health' || !req.path.startsWith('/api/')) return;

    pgPool.run(SCHEMA, `
      INSERT INTO worker.access_log
        (company_id, user_id, username, action, method, url, status_code,
         ip_address, user_agent, response_time_ms)
      VALUES ($1,$2,$3,'api_call',$4,$5,$6,$7,$8,$9)
    `, [
      req.user?.company_id || req.companyId || null,
      req.user?.id   || null,
      req.user?.username || null,
      req.method,
      req.originalUrl?.substring(0, 500),
      res.statusCode,
      (req.ip || req.headers['x-forwarded-for'] || '').substring(0, 100),
      (req.headers['user-agent'] || '').substring(0, 200),
      Date.now() - start,
    ]).catch(e => console.error('[logger] access_log 실패:', e.message));
  });

  next();
}

// ── 에러 로그 미들웨어 ────────────────────────────────────────────

function errorLogger(err, req, res, next) {
  pgPool.run(SCHEMA, `
    INSERT INTO worker.error_log
      (company_id, user_id, level, message, stack_trace, url, method)
    VALUES ($1,$2,'error',$3,$4,$5,$6)
  `, [
    req.user?.company_id || null,
    req.user?.id   || null,
    err.message?.substring(0, 1000),
    err.stack?.substring(0, 2000),
    req.originalUrl?.substring(0, 500),
    req.method,
  ]).catch(e => console.error('[logger] error_log 실패:', e.message));

  next(err);
}

// ── 인증 로그 (로그인/로그아웃 특별 기록) ────────────────────────

async function logAuth(action, username, ip, userAgent, detail = {}) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO worker.access_log
        (username, action, ip_address, user_agent, detail)
      VALUES ($1,$2,$3,$4,$5)
    `, [
      username,
      action,
      (ip || '').substring(0, 100),
      (userAgent || '').substring(0, 200),
      JSON.stringify(detail),
    ]);
  } catch (e) {
    console.error('[logger] logAuth 실패:', e.message);
  }
}

// ── 보안 이벤트 (403/권한 오류) ──────────────────────────────────

async function logSecurity(req, action, detail = {}) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO worker.access_log
        (company_id, user_id, username, action, ip_address, url, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      req.user?.company_id || null,
      req.user?.id   || null,
      req.user?.username || null,
      action,
      (req.ip || '').substring(0, 100),
      req.originalUrl?.substring(0, 500),
      JSON.stringify(detail),
    ]);
  } catch (e) {
    console.error('[logger] logSecurity 실패:', e.message);
  }
}

module.exports = { accessLogger, errorLogger, logAuth, logSecurity };

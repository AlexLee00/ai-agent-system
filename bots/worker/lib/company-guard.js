'use strict';

/**
 * bots/worker/lib/company-guard.js — 업체 데이터 격리 미들웨어
 *
 * requireAuth(req, res, next)         — JWT 검증, req.user 세팅
 * requireRole(...roles)               — 역할 확인 미들웨어 팩토리
 * companyFilter(req, res, next)       — master: 전체, 나머지: 자기 업체만
 * auditLog(action, target)(req, res, next) — audit_log 자동 기록
 */

const { verifyToken } = require('./auth');
const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

// ── 인증 ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '인증이 필요합니다.', code: 'UNAUTHORIZED' });

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: '유효하지 않거나 만료된 토큰입니다.', code: 'TOKEN_INVALID' });
  }
}

// ── 역할 ─────────────────────────────────────────────────────────────

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '인증이 필요합니다.', code: 'UNAUTHORIZED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '권한이 없습니다.', code: 'FORBIDDEN' });
    }
    next();
  };
}

// ── 업체 필터 ────────────────────────────────────────────────────────

function companyFilter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '인증이 필요합니다.', code: 'UNAUTHORIZED' });
  if (req.user.role !== 'master') {
    // 쿼리/바디의 company_id를 강제 주입 (다른 업체 접근 차단)
    req.companyId = req.user.company_id;
  } else {
    // master: 쿼리 파라미터 company_id로 필터링 허용, 없으면 전체
    req.companyId = req.query.company_id || null;
  }
  next();
}

// ── audit_log 미들웨어 팩토리 ────────────────────────────────────────

function auditLog(action, target) {
  return async (req, res, next) => {
    // 원래 json()을 wrapping하여 응답 후 자동 기록
    const origJson = res.json.bind(res);
    res.json = async (body) => {
      origJson(body);
      if (res.statusCode < 400) {
        try {
          await pgPool.run(SCHEMA, `
            INSERT INTO worker.audit_log (company_id, user_id, action, target, target_id, detail, ip_address)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            req.user?.company_id || 'unknown',
            req.user?.id         || null,
            action,
            target,
            body?.id ?? req.params?.id ?? null,
            JSON.stringify({ body: req.body, params: req.params }),
            req.ip,
          ]);
        } catch { /* audit 실패는 무시 */ }
      }
    };
    next();
  };
}

// ── 파라미터 대상 업체 접근 권한 확인 ────────────────────────────────

async function assertCompanyAccess(req, res, targetCompanyId) {
  if (req.user.role === 'master') return true;
  if (req.user.company_id !== targetCompanyId) {
    res.status(403).json({ error: '다른 업체 데이터에 접근할 수 없습니다.', code: 'FORBIDDEN' });
    return false;
  }
  return true;
}

module.exports = { requireAuth, requireRole, companyFilter, auditLog, assertCompanyAccess };

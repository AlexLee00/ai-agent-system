'use strict';

/**
 * bots/worker/web/server.js — 워커팀 REST API 서버 (포트 4000)
 *
 * POST /api/auth/login          — 로그인
 * POST /api/auth/register       — 사용자 등록 (master만)
 * GET  /api/auth/me             — 내 정보
 * POST /api/auth/change-password
 *
 * GET/POST/PUT/DELETE /api/companies
 * GET/POST/PUT/DELETE /api/users
 * GET/POST/PUT/PUT    /api/approvals
 * GET                 /api/audit
 */

const path        = require('path');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');

const pgPool  = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { hashPassword, verifyPassword, generateToken, validatePasswordPolicy } = require('../lib/auth');
const { requireAuth, requireRole, companyFilter, auditLog, assertCompanyAccess } = require('../lib/company-guard');

const SCHEMA = 'worker';
const PORT   = parseInt(process.env.WORKER_PORT || '4000', 10);

const app = express();

// ── 보안 미들웨어 ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000', 'http://localhost:4000'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// 로그인 엔드포인트는 더 엄격한 Rate Limit
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/auth/login', loginLimiter);

// ── 정적 파일 ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'pages')));

// ── 유틸 ─────────────────────────────────────────────────────────────
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: '입력값이 올바르지 않습니다.', code: 'INVALID_INPUT', details: errors.array().map(e => e.msg) });
    return false;
  }
  return true;
}

function pagination(req) {
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
  const sort  = /^\w+$/.test(req.query.sort || 'created_at') ? (req.query.sort || 'created_at') : 'created_at';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  return { page, limit, offset: (page - 1) * limit, sort, order };
}

// ── 인증 API ──────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login',
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password } = req.body;
    try {
      const user = await pgPool.get(SCHEMA,
        `SELECT * FROM worker.users WHERE username = $1 AND deleted_at IS NULL`, [username]);
      if (!user) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });

      const token = generateToken(user);
      const { password_hash: _, ...safeUser } = user;
      res.json({ token, user: safeUser });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// POST /api/auth/register (master만)
app.post('/api/auth/register',
  requireAuth, requireRole('master'),
  body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').notEmpty(),
  body('name').trim().notEmpty(),
  body('role').isIn(['master','admin','member']),
  body('company_id').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password, name, role, company_id, email, telegram_id } = req.body;

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const exists = await pgPool.get(SCHEMA, `SELECT id FROM worker.users WHERE username = $1`, [username]);
      if (exists) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.', code: 'DUPLICATE_USERNAME' });

      const hash = await hashPassword(password);
      const user = await pgPool.get(SCHEMA,
        `INSERT INTO worker.users (company_id, username, password_hash, role, name, email, telegram_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, company_id, username, role, name, email, telegram_id, created_at`,
        [company_id, username, hash, role, name, email || null, telegram_id || null]);
      res.status(201).json({ user });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await pgPool.get(SCHEMA,
      `SELECT id, company_id, username, role, name, email, telegram_id, created_at FROM worker.users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ user });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password',
  requireAuth,
  body('current_password').notEmpty(),
  body('new_password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { current_password, new_password } = req.body;

    const policy = validatePasswordPolicy(new_password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const user = await pgPool.get(SCHEMA, `SELECT * FROM worker.users WHERE id = $1`, [req.user.id]);
      if (!await verifyPassword(current_password, user.password_hash)) {
        return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }
      const hash = await hashPassword(new_password);
      await pgPool.run(SCHEMA, `UPDATE worker.users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [hash, req.user.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 업체 API (master 전용) ────────────────────────────────────────────

app.get('/api/companies', requireAuth, requireRole('master'), async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.companies WHERE deleted_at IS NULL ORDER BY ${sort} ${order} LIMIT $1 OFFSET $2`,
      [limit, offset]);
    res.json({ companies: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/companies',
  requireAuth, requireRole('master'), auditLog('CREATE', 'companies'),
  body('id').trim().matches(/^[a-z0-9_]+$/),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { id, name } = req.body;
    try {
      const company = await pgPool.get(SCHEMA,
        `INSERT INTO worker.companies (id, name) VALUES ($1, $2) RETURNING *`, [id, name]);
      res.status(201).json({ company });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '이미 존재하는 업체 ID입니다.', code: 'DUPLICATE' });
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.put('/api/companies/:id',
  requireAuth, requireRole('master'), auditLog('UPDATE', 'companies'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const company = await pgPool.get(SCHEMA,
        `UPDATE worker.companies SET name=$1, updated_at=NOW() WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
        [req.body.name, req.params.id]);
      if (!company) return res.status(404).json({ error: '업체를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ company });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/companies/:id', requireAuth, requireRole('master'), auditLog('DELETE', 'companies'), async (req, res) => {
  try {
    await pgPool.run(SCHEMA,
      `UPDATE worker.companies SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 사용자 API ────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  const params = req.companyId ? [req.companyId, limit, offset] : [limit, offset];
  const where  = req.companyId ? 'WHERE company_id=$1 AND deleted_at IS NULL' : 'WHERE deleted_at IS NULL';
  const lp     = req.companyId ? `$2,$3` : `$1,$2`;
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,company_id,username,role,name,email,telegram_id,created_at FROM worker.users ${where} ORDER BY ${sort} ${order} LIMIT ${req.companyId?'$2':'$1'} OFFSET ${req.companyId?'$3':'$2'}`,
      params);
    res.json({ users: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/users',
  requireAuth, requireRole('master','admin'), auditLog('CREATE', 'users'),
  body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').notEmpty(),
  body('name').trim().notEmpty(),
  body('role').isIn(['admin','member']),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password, name, role, email, telegram_id } = req.body;
    const company_id = req.user.role === 'master' ? (req.body.company_id || req.user.company_id) : req.user.company_id;

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const hash = await hashPassword(password);
      const user = await pgPool.get(SCHEMA,
        `INSERT INTO worker.users (company_id,username,password_hash,role,name,email,telegram_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,company_id,username,role,name,email,telegram_id,created_at`,
        [company_id, username, hash, role, name, email || null, telegram_id || null]);
      res.status(201).json({ user });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '이미 사용 중인 아이디입니다.', code: 'DUPLICATE' });
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.put('/api/users/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'users'),
  body('name').optional().trim().notEmpty(),
  body('email').optional().isEmail(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.users WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;

      const { name, email, telegram_id } = req.body;
      const user = await pgPool.get(SCHEMA,
        `UPDATE worker.users SET name=COALESCE($1,name), email=COALESCE($2,email), telegram_id=COALESCE($3,telegram_id), updated_at=NOW()
         WHERE id=$4 RETURNING id,company_id,username,role,name,email,telegram_id`,
        [name || null, email || null, telegram_id ?? null, req.params.id]);
      res.json({ user });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/users/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'users'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.users WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.users SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 승인 API ──────────────────────────────────────────────────────────

app.get('/api/approvals', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const cid = req.companyId;
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.approval_requests
       WHERE (company_id=$1 OR $1 IS NULL) AND deleted_at IS NULL AND status='pending'
       ORDER BY priority DESC, created_at ASC LIMIT $2 OFFSET $3`,
      [cid, limit, offset]);
    res.json({ approvals: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/approvals',
  requireAuth,
  body('category').trim().notEmpty(),
  body('action').trim().notEmpty(),
  body('target_table').trim().notEmpty(),
  body('payload').isObject(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { category, action, target_table, target_id, payload, priority } = req.body;
    try {
      const approval = await pgPool.get(SCHEMA,
        `INSERT INTO worker.approval_requests (company_id,requester_id,category,action,target_table,target_id,payload,priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.company_id, req.user.id, category, action, target_table, target_id || null,
         JSON.stringify(payload), priority || 'normal']);
      res.status(201).json({ approval });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/approvals/:id/approve', requireAuth, requireRole('master','admin'), auditLog('APPROVE', 'approval_requests'), async (req, res) => {
  try {
    const approval = await pgPool.get(SCHEMA,
      `UPDATE worker.approval_requests SET status='approved', approver_id=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status='pending' RETURNING *`,
      [req.user.id, req.params.id]);
    if (!approval) return res.status(404).json({ error: '승인 요청을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ approval });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.put('/api/approvals/:id/reject',
  requireAuth, requireRole('master','admin'), auditLog('REJECT', 'approval_requests'),
  body('reason').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const approval = await pgPool.get(SCHEMA,
        `UPDATE worker.approval_requests SET status='rejected', approver_id=$1, reject_reason=$2, rejected_at=NOW(), updated_at=NOW()
         WHERE id=$3 AND status='pending' RETURNING *`,
        [req.user.id, req.body.reason, req.params.id]);
      if (!approval) return res.status(404).json({ error: '승인 요청을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ approval });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 감사 로그 API ────────────────────────────────────────────────────

app.get('/api/audit', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.audit_log
       WHERE (company_id=$1 OR $1 IS NULL)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.companyId, limit, offset]);
    res.json({ logs: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 헬스체크 ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', port: PORT, ts: new Date().toISOString() }));

// ── 에러 핸들러 ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[worker/server] 오류:', err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
});

// ── 서버 기동 ────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[worker/server] API 서버 기동 — http://localhost:${PORT}`);
  });
}

module.exports = app;

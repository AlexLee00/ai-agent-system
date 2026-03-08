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
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000', 'http://localhost:4000', 'http://localhost:4001'] }));
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

// ══════════════════════════════════════════════════════════════════════
// Phase 2 API — 직원(노아) / 근태(노아) / 매출(올리버) / 문서(에밀리)
// ══════════════════════════════════════════════════════════════════════

// ── 직원 API (노아) ────────────────────────────────────────────────────

app.get('/api/employees', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  const validSort = ['name','position','department','hire_date','created_at'].includes(sort) ? sort : 'name';
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,company_id,user_id,name,phone,position,department,hire_date,status,created_at
       FROM worker.employees
       WHERE company_id=$1 AND deleted_at IS NULL
       ORDER BY ${validSort} ${order} LIMIT $2 OFFSET $3`,
      [req.companyId, limit, offset]);
    res.json({ employees: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/employees',
  requireAuth, requireRole('master','admin'), auditLog('CREATE', 'employees'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, phone, position, department, hire_date, user_id } = req.body;
    const companyId = req.user.role === 'master' ? (req.body.company_id || req.user.company_id) : req.user.company_id;
    try {
      const emp = await pgPool.get(SCHEMA,
        `INSERT INTO worker.employees (company_id,user_id,name,phone,position,department,hire_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,company_id,name,position,department,hire_date,status`,
        [companyId, user_id||null, name, phone||null, position||null, department||null, hire_date||null]);
      res.status(201).json({ employee: emp });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/employees/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'employees'),
  body('name').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.employees WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '직원을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;

      const { name, phone, position, department, hire_date, status, user_id } = req.body;
      const emp = await pgPool.get(SCHEMA,
        `UPDATE worker.employees
         SET name=COALESCE($1,name), phone=COALESCE($2,phone), position=COALESCE($3,position),
             department=COALESCE($4,department), hire_date=COALESCE($5,hire_date),
             status=COALESCE($6,status), user_id=COALESCE($7,user_id)
         WHERE id=$8 RETURNING id,company_id,name,phone,position,department,hire_date,status`,
        [name||null, phone||null, position||null, department||null, hire_date||null,
         status||null, user_id||null, req.params.id]);
      res.json({ employee: emp });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/employees/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'employees'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.employees WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.employees SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 근태 API (노아) ────────────────────────────────────────────────────

app.get('/api/attendance', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT a.*, e.name AS employee_name
       FROM worker.attendance a
       JOIN worker.employees e ON e.id=a.employee_id
       WHERE a.company_id=$1 AND a.date=$2
       ORDER BY e.name LIMIT $3 OFFSET $4`,
      [req.companyId, date, limit, offset]);
    res.json({ attendance: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/attendance/checkin', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toISOString();
  try {
    // user_id로 employee 조회
    const emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.user.company_id, req.user.id]);
    if (!emp) {
      // employee_id 직접 지정도 허용 (admin)
      const empId = req.body.employee_id;
      if (!empId) return res.status(404).json({ error: '연결된 직원 정보 없음', code: 'NOT_FOUND' });
      await pgPool.run(SCHEMA,
        `INSERT INTO worker.attendance (company_id,employee_id,date,check_in,status)
         VALUES ($1,$2,$3,$4,'present') ON CONFLICT (employee_id,date) DO UPDATE SET check_in=$4`,
        [req.user.company_id, empId, today, now]);
      return res.json({ ok: true, check_in: now });
    }
    const existing = await pgPool.get(SCHEMA,
      `SELECT check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`, [emp.id, today]);
    if (existing?.check_in) return res.status(409).json({ error: '이미 출근 체크됨', code: 'DUPLICATE' });
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.attendance (company_id,employee_id,date,check_in,status)
       VALUES ($1,$2,$3,$4,'present') ON CONFLICT (employee_id,date) DO UPDATE SET check_in=$4`,
      [req.user.company_id, emp.id, today, now]);
    res.json({ ok: true, check_in: now });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/attendance/checkout', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toISOString();
  try {
    const emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.user.company_id, req.user.id]);
    const empId = emp?.id || req.body.employee_id;
    if (!empId) return res.status(404).json({ error: '연결된 직원 정보 없음', code: 'NOT_FOUND' });

    const existing = await pgPool.get(SCHEMA,
      `SELECT check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`, [empId, today]);
    if (!existing?.check_in) return res.status(400).json({ error: '출근 기록이 없습니다', code: 'NOT_CHECKED_IN' });

    await pgPool.run(SCHEMA,
      `UPDATE worker.attendance SET check_out=$1 WHERE employee_id=$2 AND date=$3`,
      [now, empId, today]);
    res.json({ ok: true, check_out: now });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 매출 API (올리버) ──────────────────────────────────────────────────

app.get('/api/sales', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const from = req.query.from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10);
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,date,amount,category,description,registered_by,created_at
       FROM worker.sales
       WHERE company_id=$1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC LIMIT $4 OFFSET $5`,
      [req.companyId, from, to, limit, offset]);
    res.json({ sales: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/sales/summary', requireAuth, companyFilter, async (req, res) => {
  try {
    const [daily, weekly, monthly] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date=CURRENT_DATE AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT date, SUM(amount) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date>=CURRENT_DATE-6 AND deleted_at IS NULL
         GROUP BY date ORDER BY date`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date>=CURRENT_DATE-364 AND deleted_at IS NULL
         GROUP BY 1 ORDER BY 1`,
        [req.companyId]),
    ]);
    res.json({
      today:   { total: Number(daily?.total ?? 0), count: Number(daily?.cnt ?? 0) },
      weekly,
      monthly,
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/sales',
  requireAuth, auditLog('CREATE', 'sales'),
  body('amount').isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { amount, category, description, date } = req.body;
    const saleDate = date || new Date().toISOString().slice(0, 10);
    try {
      const sale = await pgPool.get(SCHEMA,
        `INSERT INTO worker.sales (company_id,date,amount,category,description,registered_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,date,amount,category`,
        [req.user.company_id, saleDate, amount, category||'기타', description||null, req.user.id]);
      res.status(201).json({ sale });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/sales/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'sales'),
  body('amount').optional().isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.sales WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '매출 항목을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;
      const { amount, category, description, date } = req.body;
      const sale = await pgPool.get(SCHEMA,
        `UPDATE worker.sales
         SET amount=COALESCE($1,amount), category=COALESCE($2,category),
             description=COALESCE($3,description), date=COALESCE($4,date)
         WHERE id=$5 RETURNING id,date,amount,category`,
        [amount||null, category||null, description||null, date||null, req.params.id]);
      res.json({ sale });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/sales/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'sales'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.sales WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.sales SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 문서 API (에밀리) ──────────────────────────────────────────────────

app.get('/api/documents', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const keyword  = req.query.keyword  || '';
  const category = req.query.category || '';
  const params   = [req.companyId];
  let where = `company_id=$1 AND deleted_at IS NULL`;
  if (keyword)  { params.push(`%${keyword}%`);  where += ` AND (filename ILIKE $${params.length} OR ai_summary ILIKE $${params.length})`; }
  if (category) { params.push(category); where += ` AND category=$${params.length}`; }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,category,filename,ai_summary,uploaded_by,created_at FROM worker.documents
       WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ documents: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/documents/upload',
  requireAuth, auditLog('UPLOAD', 'documents'),
  body('filename').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { filename, file_path, category } = req.body;

    // 규칙 기반 분류 (Gemini 없이)
    const CATEGORY_KW = {
      '계약서':   ['계약','협약','약정'],
      '견적서':   ['견적','estimate','quote'],
      '세금계산서': ['세금계산서','invoice','tax'],
    };
    let detectedCategory = category || '기타';
    if (!category) {
      const lower = filename.toLowerCase();
      for (const [cat, kws] of Object.entries(CATEGORY_KW)) {
        if (kws.some(k => lower.includes(k))) { detectedCategory = cat; break; }
      }
    }

    try {
      const doc = await pgPool.get(SCHEMA,
        `INSERT INTO worker.documents (company_id,category,filename,file_path,uploaded_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id,category,filename,created_at`,
        [req.user.company_id, detectedCategory, filename, file_path||null, req.user.id]);
      res.status(201).json({ document: doc });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 업무일지 API (에밀리 확장) ───────────────────────────────────────

app.get('/api/journals', requireAuth, companyFilter, async (req, res) => {
  const { page, limit, offset } = pagination(req);
  const { date, employee_id, category, keyword } = req.query;
  const params = [req.companyId];
  let where = 'j.company_id=$1 AND j.deleted_at IS NULL';
  if (date)        { params.push(date);           where += ` AND j.date=$${params.length}`; }
  if (employee_id) { params.push(employee_id);    where += ` AND j.employee_id=$${params.length}`; }
  if (category)    { params.push(category);       where += ` AND j.category=$${params.length}`; }
  if (keyword)     { params.push(`%${keyword}%`); where += ` AND j.content ILIKE $${params.length}`; }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT j.*, e.name AS employee_name
       FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE ${where}
       ORDER BY j.date DESC, j.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ journals: rows, page, limit });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/journals/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT j.*, e.name AS employee_name
       FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ journal: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/journals',
  requireAuth, companyFilter, auditLog('CREATE', 'work_journals'),
  body('content').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { content, category, date } = req.body;
    try {
      // 사용자와 연결된 직원 조회
      let emp = await pgPool.get(SCHEMA,
        `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [req.companyId, req.user.id]);
      // 직원 미연결 시 body.employee_id (admin/master 전용)
      const empId = emp?.id ||
        (req.body.employee_id && ['admin','master'].includes(req.user.role) ? Number(req.body.employee_id) : null);
      if (!empId) return res.status(404).json({ error: '연결된 직원 정보가 없습니다. 관리자에게 문의하세요.', code: 'NOT_FOUND' });
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.work_journals (company_id, employee_id, date, content, category)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.companyId, empId, date || new Date().toISOString().slice(0,10), content, category || 'general']);
      res.status(201).json({ journal: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/journals/:id',
  requireAuth, companyFilter,
  body('content').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const existing = await pgPool.get(SCHEMA,
        `SELECT j.*, e.user_id FROM worker.work_journals j
         JOIN worker.employees e ON e.id=j.employee_id
         WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
        [req.params.id, req.companyId]);
      if (!existing) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (existing.user_id !== req.user.id && !['admin','master'].includes(req.user.role)) {
        return res.status(403).json({ error: '본인 작성만 수정할 수 있습니다.', code: 'FORBIDDEN' });
      }
      const { content, category } = req.body;
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.work_journals
         SET content=COALESCE($1,content), category=COALESCE($2,category), updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [content || null, category || null, req.params.id]);
      await pgPool.run(SCHEMA,
        `INSERT INTO worker.audit_log (company_id,user_id,action,target_type,target_id)
         VALUES ($1,$2,'update','work_journal',$3)`,
        [req.companyId, req.user.id, req.params.id]);
      res.json({ journal: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/journals/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const existing = await pgPool.get(SCHEMA,
      `SELECT j.*, e.user_id FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!existing) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    if (existing.user_id !== req.user.id && !['admin','master'].includes(req.user.role)) {
      return res.status(403).json({ error: '본인 작성만 삭제할 수 있습니다.', code: 'FORBIDDEN' });
    }
    await pgPool.run(SCHEMA, `UPDATE worker.work_journals SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.audit_log (company_id,user_id,action,target_type,target_id)
       VALUES ($1,$2,'delete','work_journal',$3)`,
      [req.companyId, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 대시보드 요약 API ─────────────────────────────────────────────────

app.get('/api/dashboard/summary', requireAuth, companyFilter, async (req, res) => {
  try {
    const [salesRow, attendRow, docsRow, approvalsRow] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total FROM worker.sales
         WHERE company_id=$1 AND date=CURRENT_DATE AND deleted_at IS NULL`, [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.attendance a
         JOIN worker.employees e ON e.id=a.employee_id
         WHERE a.company_id=$1 AND a.date=CURRENT_DATE AND a.check_in IS NOT NULL AND e.deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.documents
         WHERE company_id=$1 AND ai_summary IS NULL AND deleted_at IS NULL`, [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.approval_requests
         WHERE company_id=$1 AND status='pending' AND deleted_at IS NULL`, [req.companyId]),
    ]);
    res.json({
      today_sales:      Number(salesRow?.total    ?? 0),
      checked_in:       Number(attendRow?.cnt     ?? 0),
      pending_docs:     Number(docsRow?.cnt       ?? 0),
      pending_approvals: Number(approvalsRow?.cnt ?? 0),
    });
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

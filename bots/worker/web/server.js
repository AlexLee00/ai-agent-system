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
const { accessLogger, errorLogger, logAuth } = require('../lib/logger');
const { recalcProgress } = require('../src/ryan');

// ── 파일 업로드 (multer) ──────────────────────────────────────────────
const multer = require('multer');
const UPLOAD_DIR = path.join(__dirname, '../uploads');
require('fs').mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

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

// ── 접근 로그 (OWASP) — 모든 라우트 앞에 배치 ─────────────────────
app.use(accessLogger);

// 로그인 엔드포인트는 더 엄격한 Rate Limit
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/auth/login', loginLimiter);

// ── 정적 파일 / 루트 리다이렉트 ──────────────────────────────────────
app.get('/', (req, res) => res.redirect('http://localhost:4001'));
app.use(express.static(path.join(__dirname, 'pages')));
app.use('/uploads', express.static(UPLOAD_DIR));

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
      // 연속 5회 실패 → 30분 잠금 (OWASP 계정 잠금)
      const failRow = await pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.access_log
         WHERE username=$1 AND action='login_fail' AND created_at > NOW() - interval '30 minutes'`,
        [username]);
      if (Number(failRow?.cnt ?? 0) >= 5) {
        await logAuth('login_locked', username, req.ip, req.headers['user-agent']);
        return res.status(423).json({ error: '로그인 시도 초과. 30분 후 재시도해주세요.', code: 'ACCOUNT_LOCKED' });
      }

      const user = await pgPool.get(SCHEMA,
        `SELECT * FROM worker.users WHERE username = $1 AND deleted_at IS NULL`, [username]);
      if (!user) {
        await logAuth('login_fail', username, req.ip, req.headers['user-agent'], { reason: '존재하지 않는 아이디' });
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        await logAuth('login_fail', username, req.ip, req.headers['user-agent'], { reason: '비밀번호 불일치' });
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }

      // 마지막 로그인 시각 갱신
      await pgPool.run(SCHEMA, `UPDATE worker.users SET last_login_at=NOW() WHERE id=$1`, [user.id]);
      await logAuth('login', username, req.ip, req.headers['user-agent']);

      // employees 자동 등록 (기존 사용자 호환: 로그인 시마다 없으면 생성)
      try {
        const emp = await pgPool.get(SCHEMA,
          `SELECT id FROM worker.employees WHERE user_id=$1 AND deleted_at IS NULL`, [user.id]);
        if (!emp) {
          await pgPool.run(SCHEMA,
            `INSERT INTO worker.employees (company_id, user_id, name) VALUES ($1, $2, $3)`,
            [user.company_id, user.id, user.name]);
        }
      } catch (_) { /* 무시 */ }

      const token = generateToken(user);
      const { password_hash: _, ...safeUser } = user;
      res.json({ token, user: safeUser, must_change_pw: !!user.must_change_pw });
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
      `SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at FROM worker.users WHERE id = $1 AND deleted_at IS NULL`,
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
      await pgPool.run(SCHEMA,
        `UPDATE worker.users SET password_hash=$1, must_change_pw=FALSE, updated_at=NOW() WHERE id=$2`,
        [hash, req.user.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 업체 API (master 전용) ────────────────────────────────────────────

app.get('/api/companies', requireAuth, requireRole('master'), async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  const search = req.query.q ? `%${req.query.q}%` : null;
  try {
    const params = search ? [search, limit, offset] : [limit, offset];
    const where  = search ? `WHERE deleted_at IS NULL AND (c.name ILIKE $1 OR c.owner ILIKE $1)` : `WHERE deleted_at IS NULL`;
    const pLimit = search ? '$2' : '$1';
    const pOff   = search ? '$3' : '$2';
    const rows = await pgPool.query(SCHEMA,
      `SELECT c.*,
        (SELECT COUNT(*) FROM worker.users    u WHERE u.company_id=c.id AND u.deleted_at IS NULL) AS user_count,
        (SELECT COUNT(*) FROM worker.employees e WHERE e.company_id=c.id AND e.deleted_at IS NULL) AS employee_count
       FROM worker.companies c ${where}
       ORDER BY c.${sort} ${order} LIMIT ${pLimit} OFFSET ${pOff}`,
      params);
    res.json({ companies: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/companies',
  requireAuth, requireRole('master'), auditLog('CREATE', 'companies'),
  body('id').trim().matches(/^[a-z0-9_]+$/),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { id, name, owner, phone, biz_number, memo } = req.body;
    try {
      const company = await pgPool.get(SCHEMA,
        `INSERT INTO worker.companies (id, name, owner, phone, biz_number, memo)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, name, owner || null, phone || null, biz_number || null, memo || null]);
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
    const { name, owner, phone, biz_number, memo } = req.body;
    try {
      const company = await pgPool.get(SCHEMA,
        `UPDATE worker.companies
         SET name=$1, owner=$2, phone=$3, biz_number=$4, memo=$5, updated_at=NOW()
         WHERE id=$6 AND deleted_at IS NULL RETURNING *`,
        [name, owner || null, phone || null, biz_number || null, memo || null, req.params.id]);
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
  // 필터: company_id (master가 선택), role
  const cid  = req.companyId || req.query.company_id || null;
  const role = req.query.role || null;
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (cid)  { params.push(cid);  conds.push(`company_id=$${params.length}`); }
  if (role) { params.push(role); conds.push(`role=$${params.length}`); }
  params.push(limit, offset);
  const where = `WHERE ${conds.join(' AND ')}`;
  const pLimit = `$${params.length - 1}`;
  const pOff   = `$${params.length}`;
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,company_id,username,role,name,email,telegram_id,
              channel,must_change_pw,last_login_at,created_at
       FROM worker.users ${where}
       ORDER BY ${sort} ${order} LIMIT ${pLimit} OFFSET ${pOff}`,
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
        `INSERT INTO worker.users (company_id,username,password_hash,role,name,email,telegram_id,must_change_pw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         RETURNING id,company_id,username,role,name,email,telegram_id,must_change_pw,created_at`,
        [company_id, username, hash, role, name, email || null, telegram_id || null]);
      // Bug 1 수정: employees 테이블에 자동 등록 (업무일지·근태 등 직원 연동용)
      try {
        await pgPool.run(SCHEMA,
          `INSERT INTO worker.employees (company_id, user_id, name) VALUES ($1, $2, $3)`,
          [company_id, user.id, name]);
      } catch (_) { /* 중복 등록 방지 — 무시 */ }
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

// POST /api/users/:id/reset-pw (master만 — 임시 비밀번호 설정 + must_change_pw=true)
app.post('/api/users/:id/reset-pw',
  requireAuth, requireRole('master'), auditLog('RESET_PW', 'users'),
  body('new_password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { new_password } = req.body;
    const policy = validatePasswordPolicy(new_password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });
    try {
      const hash = await hashPassword(new_password);
      const user = await pgPool.get(SCHEMA,
        `UPDATE worker.users SET password_hash=$1, must_change_pw=TRUE, updated_at=NOW()
         WHERE id=$2 AND deleted_at IS NULL RETURNING id,username,name`,
        [hash, req.params.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

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
      `SELECT id,company_id,user_id,name,phone,position,department,hire_date,status,base_salary,created_at
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

      const { name, phone, position, department, hire_date, status, user_id, base_salary } = req.body;
      const emp = await pgPool.get(SCHEMA,
        `UPDATE worker.employees
         SET name=COALESCE($1,name), phone=COALESCE($2,phone), position=COALESCE($3,position),
             department=COALESCE($4,department), hire_date=COALESCE($5,hire_date),
             status=COALESCE($6,status), user_id=COALESCE($7,user_id),
             base_salary=COALESCE($8,base_salary)
         WHERE id=$9 RETURNING id,company_id,name,phone,position,department,hire_date,status,base_salary`,
        [name||null, phone||null, position||null, department||null, hire_date||null,
         status||null, user_id||null, base_salary ?? null, req.params.id]);
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
  requireAuth, upload.single('file'), auditLog('UPLOAD', 'documents'),
  async (req, res) => {
    const filename  = req.file?.originalname || req.body?.filename;
    if (!filename?.trim()) return res.status(400).json({ error: '파일이 없습니다.', code: 'NO_FILE' });
    const file_path = req.file ? `/uploads/${req.file.filename}` : req.body?.file_path || null;
    const category  = req.body?.category || '';

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
    const [salesRow, attendRow, docsRow, approvalsRow, projectsRow, schedulesRow] = await Promise.all([
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
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.projects
         WHERE company_id=$1 AND status IN ('planning','in_progress','review') AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.schedules
         WHERE company_id=$1 AND deleted_at IS NULL AND start_time::date=CURRENT_DATE`,
        [req.companyId]),
    ]);
    res.json({
      today_sales:       Number(salesRow?.total     ?? 0),
      checked_in:        Number(attendRow?.cnt      ?? 0),
      pending_docs:      Number(docsRow?.cnt        ?? 0),
      pending_approvals: Number(approvalsRow?.cnt   ?? 0),
      active_projects:   Number(projectsRow?.cnt    ?? 0),
      today_schedules:   Number(schedulesRow?.cnt   ?? 0),
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 최근 활동 피드 ────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, companyFilter, async (req, res) => {
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT type, created_at, actor, detail FROM (
        SELECT 'journal' AS type, j.created_at, e.name AS actor,
               CONCAT(COALESCE(e.name,'직원'), '이(가) 업무일지를 작성했습니다') AS detail
        FROM worker.work_journals j
        LEFT JOIN worker.employees e ON e.id = j.employee_id
        WHERE j.company_id = $1 AND j.deleted_at IS NULL
        UNION ALL
        SELECT 'attendance' AS type,
               COALESCE(a.check_out, a.created_at) AS created_at,
               e.name AS actor,
               CONCAT(COALESCE(e.name,'직원'), '이(가) ',
                 CASE WHEN a.check_out IS NOT NULL THEN '퇴근' ELSE '출근' END,
               ' 체크했습니다') AS detail
        FROM worker.attendance a
        LEFT JOIN worker.employees e ON e.id = a.employee_id
        WHERE a.company_id = $1
        UNION ALL
        SELECT 'sales' AS type, s.created_at, NULL AS actor,
               CONCAT('₩', TO_CHAR(s.amount, 'FM999,999,999'), ' 매출이 등록되었습니다') AS detail
        FROM worker.sales s
        WHERE s.company_id = $1 AND s.deleted_at IS NULL
        UNION ALL
        SELECT 'approval' AS type, ar.updated_at AS created_at, u.name AS actor,
               CONCAT(ar.action, ' ',
                 CASE WHEN ar.status = 'approved' THEN '승인됨' ELSE '반려됨' END) AS detail
        FROM worker.approval_requests ar
        LEFT JOIN worker.users u ON u.id = ar.approver_id
        WHERE ar.company_id = $1 AND ar.status != 'pending' AND ar.deleted_at IS NULL
      ) t ORDER BY created_at DESC LIMIT 10
    `, [req.companyId]);
    res.json({ activities: rows });
  } catch (e) {
    console.error('[activity]', e.message);
    res.status(500).json({ error: '활동 조회 실패' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Phase 3 API — 급여(소피) / 프로젝트(라이언) / 일정(클로이)
// ══════════════════════════════════════════════════════════════════════

// ── 급여 API (소피) ────────────────────────────────────────────────────

app.get('/api/payroll', requireAuth, companyFilter, async (req, res) => {
  const yearMonth = req.query.year_month || new Date().toISOString().slice(0, 7);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT p.*, e.name AS employee_name
       FROM worker.payroll p JOIN worker.employees e ON e.id=p.employee_id
       WHERE p.company_id=$1 AND p.year_month=$2
       ORDER BY e.name`,
      [req.companyId, yearMonth]);
    res.json({ payroll: rows, year_month: yearMonth });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/payroll/summary', requireAuth, companyFilter, async (req, res) => {
  const yearMonth = req.query.year_month || new Date().toISOString().slice(0, 7);
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(net_salary),0) AS total_net,
              COALESCE(SUM(deduction),0) AS total_deduction,
              COALESCE(SUM(base_salary),0) AS total_base
       FROM worker.payroll WHERE company_id=$1 AND year_month=$2`,
      [req.companyId, yearMonth]);
    res.json({ summary: row, year_month: yearMonth });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/payroll/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT p.*, e.name AS employee_name
       FROM worker.payroll p JOIN worker.employees e ON e.id=p.employee_id
       WHERE p.id=$1 AND p.company_id=$2`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '급여 정보 없음', code: 'NOT_FOUND' });
    res.json({ payroll: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/payroll/calculate', requireAuth, requireRole('master','admin'), auditLog('CALCULATE', 'payroll'), async (req, res) => {
  const yearMonth = req.body.year_month || new Date().toISOString().slice(0, 7);
  try {
    const { calculatePayroll } = require('../src/sophie');
    const results = await calculatePayroll(req.companyId, yearMonth);
    res.json({ ok: true, count: results.length, year_month: yearMonth });
  } catch (e) { res.status(500).json({ error: e.message, code: 'SERVER_ERROR' }); }
});

app.put('/api/payroll/:id', requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'payroll'), async (req, res) => {
  const { net_salary, status, incentive, base_salary } = req.body;
  try {
    const row = await pgPool.get(SCHEMA,
      `UPDATE worker.payroll
       SET net_salary=COALESCE($1,net_salary), status=COALESCE($2,status),
           incentive=COALESCE($3,incentive), base_salary=COALESCE($4,base_salary),
           confirmed_by=$5, updated_at=NOW()
       WHERE id=$6 AND company_id=$7 RETURNING *`,
      [net_salary??null, status||null, incentive??null, base_salary??null,
       req.user.id, req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '급여 정보 없음', code: 'NOT_FOUND' });
    res.json({ payroll: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 프로젝트 API (라이언) ──────────────────────────────────────────────

app.get('/api/projects', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const status = req.query.status || '';
  const params = [req.companyId];
  let where = 'p.company_id=$1 AND p.deleted_at IS NULL';
  if (status) { params.push(status); where += ` AND p.status=$${params.length}`; }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT p.*, e.name AS owner_name
       FROM worker.projects p LEFT JOIN worker.employees e ON e.id=p.owner_id
       WHERE ${where}
       ORDER BY p.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ projects: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/projects',
  requireAuth, companyFilter, auditLog('CREATE', 'projects'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, description, owner_id, start_date, end_date } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.projects (company_id, name, description, owner_id, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.companyId, name, description||null, owner_id||null, start_date||null, end_date||null]);
      res.status(201).json({ project: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/projects/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'projects'),
  body('name').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, description, status, owner_id, start_date, end_date, progress } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.projects
         SET name=COALESCE($1,name), description=COALESCE($2,description),
             status=COALESCE($3,status), owner_id=COALESCE($4,owner_id),
             start_date=COALESCE($5,start_date), end_date=COALESCE($6,end_date),
             progress=COALESCE($7,progress), updated_at=NOW()
         WHERE id=$8 AND company_id=$9 AND deleted_at IS NULL RETURNING *`,
        [name||null, description||null, status||null, owner_id||null,
         start_date||null, end_date||null, progress??null,
         req.params.id, req.companyId]);
      if (!row) return res.status(404).json({ error: '프로젝트 없음', code: 'NOT_FOUND' });
      res.json({ project: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/projects/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'projects'), async (req, res) => {
  try {
    await pgPool.run(SCHEMA,
      `UPDATE worker.projects SET deleted_at=NOW() WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 마일스톤 API (라이언) ──────────────────────────────────────────────

app.get('/api/projects/:id/milestones', requireAuth, companyFilter, async (req, res) => {
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT m.*, e.name AS assignee_name
       FROM worker.milestones m LEFT JOIN worker.employees e ON e.id=m.assigned_to
       WHERE m.project_id=$1 AND m.company_id=$2 AND m.deleted_at IS NULL
       ORDER BY m.due_date ASC NULLS LAST, m.created_at ASC`,
      [req.params.id, req.companyId]);
    res.json({ milestones: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/projects/:id/milestones',
  requireAuth, requireRole('master','admin'), auditLog('CREATE', 'milestones'),
  body('title').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, due_date, assigned_to } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.milestones (project_id, company_id, title, description, due_date, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, req.companyId, title, description||null, due_date||null, assigned_to||null]);
      await recalcProgress(req.params.id);
      res.status(201).json({ milestone: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/milestones/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'milestones'),
  async (req, res) => {
    const { title, description, status, due_date, assigned_to } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.milestones
         SET title=COALESCE($1,title), description=COALESCE($2,description),
             status=COALESCE($3,status), due_date=COALESCE($4,due_date),
             assigned_to=COALESCE($5,assigned_to),
             completed_at=CASE WHEN $3='completed' THEN NOW() ELSE completed_at END
         WHERE id=$6 AND deleted_at IS NULL RETURNING *`,
        [title||null, description||null, status||null, due_date||null,
         assigned_to||null, req.params.id]);
      if (!row) return res.status(404).json({ error: '마일스톤 없음', code: 'NOT_FOUND' });
      await recalcProgress(row.project_id);
      res.json({ milestone: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 일정 API (클로이) ──────────────────────────────────────────────────

app.get('/api/schedules', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  let from, to;
  if (req.query.year_month) {
    const [y, m] = req.query.year_month.split('-').map(Number);
    from = `${req.query.year_month}-01`;
    to   = new Date(y, m, 0).toISOString().slice(0, 10); // 해당 월 마지막 날
  } else {
    from = req.query.from || new Date().toISOString().slice(0,10);
    to   = req.query.to   || new Date(Date.now() + 30*24*3600*1000).toISOString().slice(0,10);
  }
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.schedules
       WHERE company_id=$1 AND deleted_at IS NULL
         AND start_time::date BETWEEN $2 AND $3
       ORDER BY start_time LIMIT $4 OFFSET $5`,
      [req.companyId, from, to, limit, offset]);
    res.json({ schedules: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/schedules/today', requireAuth, companyFilter, async (req, res) => {
  try {
    const { getTodaySchedules } = require('../src/chloe');
    const rows = await getTodaySchedules(req.companyId);
    res.json({ schedules: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/schedules',
  requireAuth, auditLog('CREATE', 'schedules'),
  body('title').trim().notEmpty(),
  body('start_time').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, type, start_time, end_time, all_day, location, attendees, recurrence, reminder } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.schedules
           (company_id, title, description, type, start_time, end_time, all_day,
            location, attendees, recurrence, reminder, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.companyId, title, description||null, type||'task',
         start_time, end_time||null, all_day||false,
         location||null, JSON.stringify(attendees||[]),
         recurrence||null, reminder??30, req.user.id]);
      res.status(201).json({ schedule: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/schedules/:id',
  requireAuth, auditLog('UPDATE', 'schedules'),
  body('title').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, type, start_time, end_time, all_day, location, attendees, recurrence } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.schedules
         SET title=COALESCE($1,title), description=COALESCE($2,description),
             type=COALESCE($3,type), start_time=COALESCE($4,start_time),
             end_time=COALESCE($5,end_time), all_day=COALESCE($6,all_day),
             location=COALESCE($7,location),
             attendees=COALESCE($8,attendees), recurrence=COALESCE($9,recurrence),
             updated_at=NOW()
         WHERE id=$10 AND company_id=$11 AND deleted_at IS NULL RETURNING *`,
        [title||null, description||null, type||null, start_time||null,
         end_time||null, all_day??null, location||null,
         attendees?JSON.stringify(attendees):null,
         recurrence||null, req.params.id, req.companyId]);
      if (!row) return res.status(404).json({ error: '일정 없음', code: 'NOT_FOUND' });
      res.json({ schedule: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/schedules/:id', requireAuth, auditLog('DELETE', 'schedules'), async (req, res) => {
  try {
    await pgPool.run(SCHEMA,
      `UPDATE worker.schedules SET deleted_at=NOW() WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 헬스체크 ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', port: PORT, ts: new Date().toISOString() }));

// ── 에러 로그 미들웨어 (에러 핸들러 앞) ──────────────────────────────
app.use(errorLogger);

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

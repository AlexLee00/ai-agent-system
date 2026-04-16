// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');
/**
 * bots/worker/src/noah.js — 노아 (인사 봇)
 *
 * 기능:
 *   - 직원 CRUD (REST API 경유)
 *   - 근태 체크인/아웃
 *   - 휴가 신청 (관리자 승인)
 * 명령어: /checkin /checkout /attendance /employee_list /leave_request
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

// ── 직원 조회 ─────────────────────────────────────────────────────────

async function listEmployees({ companyId }) {
  return pgPool.query(SCHEMA,
    `SELECT id, name, position, department, status, hire_date, user_id
     FROM worker.employees
     WHERE company_id=$1 AND deleted_at IS NULL
     ORDER BY name`,
    [companyId]);
}

async function getEmployeeByUserId({ companyId, userId }) {
  return pgPool.get(SCHEMA,
    `SELECT id, name FROM worker.employees
     WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [companyId, userId]);
}

// ── 근태 ─────────────────────────────────────────────────────────────

async function getTodayAttendance({ companyId }) {
  const today = kst.today();
  return pgPool.query(SCHEMA,
    `SELECT e.name, a.check_in, a.check_out, a.status
     FROM worker.employees e
     LEFT JOIN worker.attendance a
       ON a.employee_id=e.id AND a.date=$2
     WHERE e.company_id=$1 AND e.deleted_at IS NULL AND e.status='active'
     ORDER BY e.name`,
    [companyId, today]);
}

async function checkIn({ companyId, employeeId }) {
  const today = kst.today();
  const now   = new Date().toISOString();

  const existing = await pgPool.get(SCHEMA,
    `SELECT id, check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`,
    [employeeId, today]);

  if (existing?.check_in) return { ok: false, msg: '이미 출근 체크됨' };

  await pgPool.run(SCHEMA,
    `INSERT INTO worker.attendance (company_id, employee_id, date, check_in, status)
     VALUES ($1,$2,$3,$4,'present')
     ON CONFLICT (employee_id, date) DO UPDATE SET check_in=$4, status='present'`,
    [companyId, employeeId, today, now]);

  const time = new Date(now).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return { ok: true, msg: `출근 완료: ${time}` };
}

async function checkOut({ companyId, employeeId }) {
  const today = kst.today();
  const now   = new Date().toISOString();

  const existing = await pgPool.get(SCHEMA,
    `SELECT id, check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`,
    [employeeId, today]);

  if (!existing?.check_in) return { ok: false, msg: '출근 기록이 없습니다' };
  if (existing.check_out)  return { ok: false, msg: '이미 퇴근 체크됨' };

  await pgPool.run(SCHEMA,
    `UPDATE worker.attendance SET check_out=$1 WHERE employee_id=$2 AND date=$3`,
    [now, employeeId, today]);

  const time = new Date(now).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return { ok: true, msg: `퇴근 완료: ${time}` };
}

// ── 텔레그램 명령어 핸들러 ────────────────────────────────────────────

async function handleCommand(cmd, args, ctx) {
  const companyId = ctx.user.company_id;
  const userId    = ctx.user.id;

  if (cmd === '/attendance') {
    const rows  = await getTodayAttendance({ companyId });
    const today = new Date().toLocaleDateString('ko-KR');
    const lines = [`👥 <b>오늘 근태 현황</b> (${today})`, '───────────────'];

    for (const r of rows) {
      const inT  = r.check_in  ? new Date(r.check_in).toLocaleTimeString('ko-KR',  { hour: '2-digit', minute: '2-digit' }) : '-';
      const outT = r.check_out ? new Date(r.check_out).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-';
      const icon = r.check_in ? '✅' : '⬜';
      lines.push(`${icon} ${r.name}  출근: ${inT} / 퇴근: ${outT}`);
    }
    if (!rows.length) lines.push('등록된 직원 없음');
    return lines.join('\n');
  }

  if (cmd === '/employee_list') {
    const rows = await listEmployees({ companyId });
    if (!rows.length) return '👥 등록된 직원 없음';
    const lines = ['👥 <b>직원 목록</b>', '───────────────'];
    for (const r of rows) {
      const pos = [r.position, r.department].filter(Boolean).join(' / ') || '미설정';
      lines.push(`• ${r.name} (${pos})`);
    }
    return lines.join('\n');
  }

  if (cmd === '/checkin') {
    const emp = await getEmployeeByUserId({ companyId, userId });
    if (!emp) return '⚠️ 연결된 직원 정보가 없습니다. 관리자에게 문의하세요.';
    const result = await checkIn({ companyId, employeeId: emp.id });
    return result.ok ? `✅ ${result.msg}` : `⚠️ ${result.msg}`;
  }

  if (cmd === '/checkout') {
    const emp = await getEmployeeByUserId({ companyId, userId });
    if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.';
    const result = await checkOut({ companyId, employeeId: emp.id });
    return result.ok ? `✅ ${result.msg}` : `⚠️ ${result.msg}`;
  }

  if (cmd === '/leave_request') {
    if (!args) return '사용법: /leave_request {날짜} {사유}\n예: /leave_request 2026-03-15 개인사유';
    const [date, ...parts] = args.split(' ');
    const reason = parts.join(' ') || '사유 없음';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '⚠️ 날짜 형식: YYYY-MM-DD';

    const emp = await getEmployeeByUserId({ companyId, userId });
    if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.';

    await pgPool.run(SCHEMA,
      `INSERT INTO worker.approval_requests
         (company_id, requester_id, category, action, target_table, payload, status, priority)
       VALUES ($1,$2,'leave','leave_request','attendance',$3,'pending','normal')`,
      [companyId, userId, JSON.stringify({ employee_id: emp.id, name: emp.name, date, reason })]);

    return `✅ 휴가 신청 접수\n날짜: ${date}\n사유: ${reason}\n관리자 승인 대기 중`;
  }

  return null;
}

module.exports = {
  handleCommand,
  listEmployees, getEmployeeByUserId,
  getTodayAttendance, checkIn, checkOut,
};

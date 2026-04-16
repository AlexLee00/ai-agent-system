// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * bots/worker/src/sophie.js — 소피(Sophie) 급여봇
 *
 * 역할: 급여 계산 + 성과 연동 (노아 근태 + 올리버 매출)
 *
 * 주요 기능:
 *   - 기본급 + 근태 반영 (지각/결근 차감)
 *   - 야근/주말/공휴일 수당 자동 계산
 *   - 4대보험 + 소득세 자동 공제 (간이세액표 근사치)
 *   - 월별 급여 명세서 생성
 *   - 올리버 매출 기반 인센티브 / 성과 등급 S/A/B/C/D
 *
 * 텔레그램: /payroll /payroll_calculate /payroll_summary
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

// ── 4대보험 공제율 (2024년 기준 근사치) ─────────────────────────
const DEDUCTION_RATES = {
  국민연금:    0.045,   // 4.5%
  건강보험:    0.03545, // 3.545%
  장기요양:    0.00455, // 건강보험의 12.81% ≈ 0.455%
  고용보험:    0.009,   // 0.9%
};

/**
 * 간이세액표 근사치 — 소득세 계산
 * @param {number} taxable 과세 소득 (원)
 * @returns {number} 소득세 (원)
 */
function calcIncomeTax(taxable) {
  if (taxable <= 1_060_000) return 0;
  if (taxable <= 1_500_000) return Math.round(taxable * 0.06);
  if (taxable <= 4_600_000) return Math.round(taxable * 0.15 - 108_000);
  if (taxable <= 8_800_000) return Math.round(taxable * 0.24 - 522_000);
  return Math.round(taxable * 0.35 - 1_490_000);
}

/**
 * 성과 등급 산정 (S/A/B/C/D)
 * @param {number} workDays 실근무일
 * @param {number} lateCount 지각
 * @param {number} absentCount 결근
 * @param {number} salesRatio 매출 기여율 (0~1)
 * @returns {string}
 */
function calcPerformance(workDays, lateCount, absentCount, salesRatio = 0) {
  let score = 100;
  score -= absentCount * 10;
  score -= lateCount  * 3;
  score += Math.min(20, Math.round(salesRatio * 20));
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

/**
 * 급여 계산 실행
 * @param {string} companyId
 * @param {string} yearMonth   예: '2026-03'
 * @param {number} [employeeId] 특정 직원 (생략 시 전체)
 * @returns {Promise<Array>} 계산된 급여 목록
 */
async function calculatePayroll(companyId, yearMonth, employeeId = null) {
  const [year, month] = yearMonth.split('-').map(Number);
  const startDate = `${yearMonth}-01`;
  const endDate   = new Date(year, month, 0).toISOString().slice(0, 10); // 월 마지막일

  // 해당 월 근무일 수 (주말 제외)
  const workingDays = (() => {
    let cnt = 0;
    const cur = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    while (cur <= end) {
      const d = cur.getDay();
      if (d !== 0 && d !== 6) cnt++;
      cur.setDate(cur.getDate() + 1);
    }
    return cnt;
  })();

  // 전체 매출 (인센티브 계산용)
  const salesRow = await pgPool.get(SCHEMA,
    `SELECT COALESCE(SUM(amount),0) AS total
     FROM worker.sales
     WHERE company_id=$1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL`,
    [companyId, startDate, endDate]);
  const totalSales = Number(salesRow?.total ?? 0);

  // 직원 목록 + 기본급 (employees 테이블에 base_salary 없으면 기본 3,000,000원)
  const empFilter = employeeId ? `AND id=$2` : '';
  const empParams = employeeId ? [companyId, employeeId] : [companyId];
  const employees = await pgPool.query(SCHEMA,
    `SELECT id, name, base_salary FROM worker.employees
     WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ${empFilter}`,
    empParams);

  const results = [];

  for (const emp of employees) {
    // 근태 조회
    const attRows = await pgPool.query(SCHEMA,
      `SELECT check_in, check_out, status FROM worker.attendance
       WHERE company_id=$1 AND employee_id=$2 AND date BETWEEN $3 AND $4`,
      [companyId, emp.id, startDate, endDate]);

    const workDays   = attRows.filter(r => r.check_in).length;
    const absentDays = workingDays - workDays;
    const absentCount = Math.max(0, absentDays);

    // 지각: 09:30 이후 출근
    const lateCount = attRows.filter(r => {
      if (!r.check_in) return false;
      const h = new Date(r.check_in);
      return h.getHours() > 9 || (h.getHours() === 9 && h.getMinutes() > 30);
    }).length;

    // 야근: 18:00 이후 퇴근 (초과 시간 × 시급 × 1.5)
    const BASE_SALARY  = emp.base_salary > 0 ? emp.base_salary : 3_000_000;
    const hourlyRate   = Math.round(BASE_SALARY / 209);       // 월 209시간 기준
    let overtimePay    = 0;
    for (const r of attRows) {
      if (!r.check_out) continue;
      const out = new Date(r.check_out);
      if (out.getHours() >= 18) {
        const extraMin = (out.getHours() - 18) * 60 + out.getMinutes();
        overtimePay += Math.round((extraMin / 60) * hourlyRate * 1.5);
      }
    }

    // 결근 차감
    const dailyRate  = Math.round(BASE_SALARY / workingDays);
    const deductBase = absentCount * dailyRate + lateCount * Math.round(dailyRate * 0.1);

    // 인센티브 (전체 매출의 0.5% 균등 분배)
    const incentive = totalSales > 0 && employees.length > 0
      ? Math.round((totalSales * 0.005) / employees.length)
      : 0;

    // 매출 기여 성과 등급
    const salesRatio  = totalSales > 0 ? (incentive / (totalSales * 0.005)) : 0;
    const performance = calcPerformance(workDays, lateCount, absentCount, salesRatio);

    // 과세 소득
    const grossSalary = BASE_SALARY + overtimePay + incentive - deductBase;
    const taxable     = Math.max(0, grossSalary);

    // 4대보험 공제
    const deductionDetail = {};
    let deduction = 0;
    for (const [name, rate] of Object.entries(DEDUCTION_RATES)) {
      const amt = Math.round(taxable * rate);
      deductionDetail[name] = amt;
      deduction += amt;
    }
    // 소득세
    const incomeTax = calcIncomeTax(taxable);
    deductionDetail['소득세'] = incomeTax;
    deduction += incomeTax;

    const netSalary = Math.max(0, taxable - deduction);

    // upsert 급여 레코드
    const row = await pgPool.get(SCHEMA, `
      INSERT INTO worker.payroll
        (company_id, employee_id, year_month, base_salary, overtime_pay,
         incentive, deduction, deduction_detail, net_salary,
         work_days, late_count, absent_count, performance)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (company_id, employee_id, year_month) DO UPDATE SET
        base_salary=EXCLUDED.base_salary, overtime_pay=EXCLUDED.overtime_pay,
        incentive=EXCLUDED.incentive, deduction=EXCLUDED.deduction,
        deduction_detail=EXCLUDED.deduction_detail, net_salary=EXCLUDED.net_salary,
        work_days=EXCLUDED.work_days, late_count=EXCLUDED.late_count,
        absent_count=EXCLUDED.absent_count, performance=EXCLUDED.performance,
        status='draft', updated_at=NOW()
      RETURNING *`,
      [companyId, emp.id, yearMonth, BASE_SALARY, overtimePay,
       incentive, deduction, JSON.stringify(deductionDetail), netSalary,
       workDays, lateCount, absentCount, performance]);

    results.push({ employee: emp.name, ...row });
  }

  return results;
}

// ── 텔레그램 명령어 처리 ──────────────────────────────────────────

const CMD_HANDLERS = {
  '/payroll': async (companyId, args) => {
    const yearMonth = args[0] || new Date().toISOString().slice(0, 7);
    const rows = await pgPool.query(SCHEMA,
      `SELECT p.year_month, e.name, p.net_salary, p.performance, p.status
       FROM worker.payroll p JOIN worker.employees e ON e.id=p.employee_id
       WHERE p.company_id=$1 AND p.year_month=$2
       ORDER BY e.name`,
      [companyId, yearMonth]);
    if (!rows.length) return `📊 ${yearMonth} 급여 데이터 없음\n/payroll_calculate 로 계산 후 조회하세요.`;
    const lines = rows.map(r =>
      `• ${r.name}: ₩${Number(r.net_salary).toLocaleString()} [${r.performance ?? '-'}] ${r.status}`
    );
    return `💰 ${yearMonth} 급여 현황\n${lines.join('\n')}`;
  },

  '/payroll_calculate': async (companyId, args) => {
    const yearMonth = args[0] || new Date().toISOString().slice(0, 7);
    const results = await calculatePayroll(companyId, yearMonth);
    return `✅ ${yearMonth} 급여 계산 완료 (${results.length}명)\n총 실수령: ₩${results.reduce((s,r)=>s+r.net_salary,0).toLocaleString()}`;
  },

  '/payroll_summary': async (companyId) => {
    const yearMonth = new Date().toISOString().slice(0, 7);
    const row = await pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS cnt, SUM(net_salary) AS total, SUM(deduction) AS deduct
       FROM worker.payroll WHERE company_id=$1 AND year_month=$2`,
      [companyId, yearMonth]);
    if (!row?.cnt) return `📊 ${yearMonth} 급여 데이터 없음`;
    return `📊 ${yearMonth} 급여 요약\n직원 수: ${row.cnt}명\n총 지급액: ₩${Number(row.total).toLocaleString()}\n총 공제액: ₩${Number(row.deduct).toLocaleString()}`;
  },
};

async function handleCommand(companyId, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const handler = CMD_HANDLERS[cmd];
  if (!handler) return null;
  return await handler(companyId, args);
}

module.exports = { calculatePayroll, handleCommand };

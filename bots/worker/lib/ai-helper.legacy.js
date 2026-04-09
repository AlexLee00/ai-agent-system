'use strict';

/**
 * bots/worker/lib/ai-helper.js — AI 질문/예측 헬퍼
 */

// ── SQL 생성 프롬프트 ─────────────────────────────────────────────────

function buildSQLPrompt(question, companyId) {
  return `당신은 PostgreSQL 전문가입니다. 아래 질문에 맞는 SELECT 쿼리를 생성하세요.

## 규칙
- SELECT 문만 생성 (INSERT/UPDATE/DELETE 절대 금지)
- 반드시 WHERE 절에 company_id = '${companyId}' 조건 포함
- worker 스키마 사용 (예: worker.employees)
- SQL만 반환 — 설명·마크다운 코드블록 없이 순수 SQL
- 마지막에 LIMIT 100 추가

## 사용 가능한 테이블
- worker.employees (id, company_id, name, position, department, phone, email, hire_date, status, base_salary)
- worker.attendance (id, company_id, employee_id, date, check_in, check_out, status)
- worker.sales (id, company_id, date, amount, category, description, registered_by)
- worker.expenses (id, company_id, date, category, item_name, amount, quantity, unit_price, note, expense_type, source_type)
- worker.payroll (id, company_id, employee_id, year_month, base_salary, overtime_pay, incentive, deduction, net_salary, performance, status)
- worker.projects (id, company_id, name, description, status, start_date, end_date, progress, owner_id)
- worker.milestones (id, project_id, company_id, title, due_date, status, completed_at)
- worker.schedules (id, company_id, title, type, start_time, end_time, all_day, location)
- worker.documents (id, company_id, category, filename, file_path, uploaded_by, created_at)
- worker.work_journals (id, company_id, employee_id, date, content, category)

## 질문
${question}`;
}

// ── 결과 요약 프롬프트 ────────────────────────────────────────────────

function buildSummaryPrompt(question, rows, ragContext) {
  const dataStr = JSON.stringify(rows.slice(0, 20), null, 2);
  return `아래 데이터를 분석하여 질문에 한국어로 간결하게 답변하세요. 수치가 있으면 반드시 포함하세요.

질문: ${question}

데이터 (총 ${rows.length}건):
${dataStr}${ragContext ? `\n\n관련 업무 문서:\n${ragContext}` : ''}

답변:`;
}

// ── SQL 추출 ──────────────────────────────────────────────────────────

function extractSQL(response) {
  let sql = typeof response === 'string' ? response : '';
  sql = sql.replace(/```sql?\n?/gi, '').replace(/```/g, '').trim();
  const match = sql.match(/SELECT[\s\S]+/i);
  return match ? match[0].trim() : sql;
}

// ── SELECT 전용 검증 ──────────────────────────────────────────────────

function isSelectOnly(sql) {
  if (!sql || !sql.toUpperCase().trim().startsWith('SELECT')) return false;
  const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC', 'CALL'];
  return !FORBIDDEN.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(sql));
}

// ── 질문 입력 안전성 검증 ─────────────────────────────────────────────
// SQL 조작 의도가 있는 질문 입력을 사전 차단

function isSafeQuestion(question) {
  const DANGEROUS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC', 'CALL'];
  return !DANGEROUS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(question));
}

// ── 허용 테이블 화이트리스트 ──────────────────────────────────────────

const ALLOWED_TABLES = [
  'worker.employees', 'worker.attendance', 'worker.revenue', 'worker.sales', 'worker.expenses',
  'worker.payroll', 'worker.projects', 'worker.project_members',
  'worker.milestones', 'worker.schedules', 'worker.documents',
  'worker.work_journals', 'worker.companies', 'worker.users',
  'worker.approval_requests',
];

function hasOnlyAllowedTables(sql) {
  const tablePattern = /(?:FROM|JOIN)\s+([\w]+\.[\w]+)/gi;
  let match;
  while ((match = tablePattern.exec(sql)) !== null) {
    if (!ALLOWED_TABLES.includes(match[1].toLowerCase())) return false;
  }
  return true;
}

function hasCompanyFilter(sql, companyId) {
  if (!sql || !companyId) return false;
  const escaped = String(companyId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyFilterPattern = new RegExp(`\\bcompany_id\\b\\s*=\\s*['"]${escaped}['"]`, 'i');
  return companyFilterPattern.test(sql);
}

module.exports = {
  buildSQLPrompt,
  buildSummaryPrompt,
  extractSQL,
  isSelectOnly,
  isSafeQuestion,
  hasOnlyAllowedTables,
  hasCompanyFilter,
};

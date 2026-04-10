'use strict';
const kst = require('../../../packages/core/lib/kst');
/**
 * bots/worker/src/emily.js — 에밀리 (문서총괄 봇)
 *
 * 기능:
 *   - 문서 업로드 + Gemini Flash 자동 분류
 *   - 업무 현황 리포트
 * 명령어: /doc_upload /doc_list /doc_search /emily_report
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

const CATEGORIES = ['계약서', '견적서', '세금계산서', '기타'];

const CATEGORY_KEYWORDS = {
  '계약서':   ['계약', '협약', '약정', '서약', 'contract'],
  '견적서':   ['견적', '가격', 'estimate', 'quote'],
  '세금계산서': ['세금계산서', '부가세', 'invoice', 'tax'],
};

// ── 내부 유틸 ─────────────────────────────────────────────────────────

function _ruleClassify(filename) {
  const lower = (filename || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => lower.includes(k))) return cat;
  }
  return '기타';
}

// ── 핵심 기능 ─────────────────────────────────────────────────────────

/**
 * 문서 업로드 + AI 분류
 * @param {object} opts
 * @param {string}  opts.companyId
 * @param {string}  opts.filename
 * @param {string}  [opts.filePath]
 * @param {number}  [opts.uploadedBy]     - user.id
 * @param {object}  [opts.geminiClient]   - @google/generative-ai GenerativeModel 인스턴스
 * @returns {{ id, category, aiSummary }}
 */
async function uploadDocument({ companyId, filename, filePath, uploadedBy, geminiClient }) {
  let category  = _ruleClassify(filename);
  let aiSummary = null;

  if (geminiClient) {
    try {
      const prompt =
        `다음 파일명을 보고 문서 종류를 판단하세요: "${filename}"\n` +
        `가능한 카테고리: 계약서, 견적서, 세금계산서, 기타\n` +
        `JSON만 응답: {"category":"...","summary":"한줄 요약"}`;
      const result = await geminiClient.generateContent(prompt);
      const text   = result.response.text();
      const match  = text.match(/\{[\s\S]*?\}/);
      if (match) {
        const json  = JSON.parse(match[0]);
        category    = CATEGORIES.includes(json.category) ? json.category : '기타';
        aiSummary   = json.summary || null;
      }
    } catch { /* Gemini 실패 시 규칙 분류 유지 */ }
  }

  const row = await pgPool.get(SCHEMA,
    `INSERT INTO worker.documents (company_id, category, filename, file_path, ai_summary, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [companyId, category, filename, filePath || null, aiSummary, uploadedBy || null]);

  return { id: row.id, category, aiSummary };
}

/**
 * 문서 목록 조회
 */
async function listDocuments({ companyId, limit = 10, offset = 0, keyword, category }) {
  const params = [companyId];
  let where = `company_id = $1 AND deleted_at IS NULL`;

  if (keyword) {
    params.push(`%${keyword}%`);
    where += ` AND (filename ILIKE $${params.length} OR ai_summary ILIKE $${params.length})`;
  }
  if (category) {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }

  params.push(limit, offset);
  return pgPool.query(SCHEMA,
    `SELECT id, category, filename, ai_summary, created_at
     FROM worker.documents WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params);
}

/**
 * 주간 업무 리포트
 */
async function getWeeklyReport({ companyId }) {
  const [categories, summary] = await Promise.all([
    pgPool.query(SCHEMA,
      `SELECT category, COUNT(*) AS cnt FROM worker.documents
       WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '7 days' AND deleted_at IS NULL
       GROUP BY category ORDER BY cnt DESC`, [companyId]),
    pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ai_summary IS NULL) AS unprocessed
       FROM worker.documents WHERE company_id=$1 AND deleted_at IS NULL`, [companyId]),
  ]);

  return {
    categories,
    total:       Number(summary?.total       ?? 0),
    unprocessed: Number(summary?.unprocessed ?? 0),
  };
}

// ── 업무일지 기능 ─────────────────────────────────────────────────────

const WEEKDAY = ['일','월','화','수','목','금','토'];

async function createJournal({ companyId, employeeId, content, category, date }) {
  return pgPool.get(SCHEMA,
    `INSERT INTO worker.work_journals (company_id, employee_id, date, content, category)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, date, content, category`,
    [companyId, employeeId, date || new Date().toISOString().slice(0,10), content, category || 'general']);
}

async function listJournals({ companyId, employeeId, limit = 10 }) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return pgPool.query(SCHEMA,
    `SELECT id, date, content, category FROM worker.work_journals
     WHERE company_id=$1 AND employee_id=$2 AND date >= $3 AND deleted_at IS NULL
     ORDER BY date DESC, created_at DESC LIMIT $4`,
    [companyId, employeeId, since, limit]);
}

async function updateJournal({ companyId, journalId, employeeId, content, category }) {
  return pgPool.get(SCHEMA,
    `UPDATE worker.work_journals
     SET content=$1, category=COALESCE($2,category), updated_at=NOW()
     WHERE id=$3 AND company_id=$4 AND employee_id=$5 AND deleted_at IS NULL RETURNING id, date`,
    [content, category || null, journalId, companyId, employeeId]);
}

async function deleteJournal({ companyId, journalId, employeeId }) {
  return pgPool.get(SCHEMA,
    `UPDATE worker.work_journals SET deleted_at=NOW()
     WHERE id=$1 AND company_id=$2 AND employee_id=$3 AND deleted_at IS NULL RETURNING id`,
    [journalId, companyId, employeeId]);
}

// ── 텔레그램 명령어 핸들러 ────────────────────────────────────────────

/**
 * 텔레그램 명령어 처리
 * @param {string} cmd   - '/doc_list' 등
 * @param {string} args  - 명령어 이후 텍스트
 * @param {object} ctx   - { user: { id, company_id, ... } }
 * @returns {string|null} HTML 응답 텍스트 (null = 미처리)
 */
async function handleCommand(cmd, args, ctx) {
  const companyId = ctx.user.company_id;

  if (cmd === '/doc_upload') {
    return '📎 <b>문서 업로드</b>\n' +
           '───────────────\n' +
           '이 채팅에 파일을 전송하면 자동 분류됩니다.\n' +
           '지원: 계약서 / 견적서 / 세금계산서 / 기타';
  }

  if (cmd === '/doc_list') {
    const docs = await listDocuments({ companyId, limit: 10 });
    if (!docs.length) return '📋 문서 없음';
    const lines = ['📋 <b>최근 문서 (10건)</b>', '───────────────'];
    for (const d of docs) {
      const date = new Date(d.created_at).toLocaleDateString('ko-KR');
      lines.push(`• [${d.category}] ${d.filename} (${date})`);
    }
    return lines.join('\n');
  }

  if (cmd === '/doc_search') {
    if (!args) return '사용법: /doc_search {키워드}';
    const docs = await listDocuments({ companyId, keyword: args });
    if (!docs.length) return `"${args}" 검색 결과 없음`;
    const lines = [`🔍 <b>"${args}" 검색 결과</b>`, '───────────────'];
    for (const d of docs) lines.push(`• [${d.category}] ${d.filename}`);
    return lines.join('\n');
  }

  if (cmd === '/emily_report') {
    const report = await getWeeklyReport({ companyId });
    const lines  = [
      '📊 <b>에밀리 주간 업무 리포트</b>',
      '───────────────',
      `총 문서: <b>${report.total}건</b> (미처리 ${report.unprocessed}건)`,
      '',
      '<b>카테고리별 (최근 7일):</b>',
    ];
    for (const r of report.categories) lines.push(`  ${r.category}: ${r.cnt}건`);
    if (!report.categories.length) lines.push('  데이터 없음');
    return lines.join('\n');
  }

  // ── 업무일지 명령어 ───────────────────────────────────────────────
  const JOURNAL_CMDS = ['/journal', '/journal_list', '/journal_edit', '/journal_delete'];
  if (JOURNAL_CMDS.includes(cmd)) {
    // 직원 조회 (공통)
    const getEmp = () => pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [companyId, ctx.user.id]);

    if (cmd === '/journal') {
      if (!args) return '사용법: /journal {업무 내용}\n예: /journal 오늘 미팅 3건 완료';
      const emp = await getEmp();
      if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.\n관리자에게 직원 등록을 요청하세요.';
      const row  = await createJournal({ companyId, employeeId: emp.id, content: args });
      const dt   = new Date(row.date);
      const wd   = WEEKDAY[dt.getDay()];
      const date = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      return `✅ 업무일지 등록 완료\n───────────────────\n📅 ${date} (${wd})\n📝 ${args}\n🏷️ 카테고리: 일반\n───────────────────\n수정: /journal_edit ${row.id} {새내용}\n삭제: /journal_delete ${row.id}`;
    }

    if (cmd === '/journal_list') {
      const emp = await getEmp();
      if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.';
      const rows = await listJournals({ companyId, employeeId: emp.id });
      if (!rows.length) return '📝 이번 주 업무일지 없음';
      const lines = ['📝 <b>이번 주 업무일지</b>', '───────────────────'];
      for (const r of rows) {
        const d  = new Date(r.date);
        const wd = WEEKDAY[d.getDay()];
        const ct = r.content.length > 40 ? r.content.slice(0, 40) + '…' : r.content;
        lines.push(`#${r.id} [${d.getMonth()+1}/${d.getDate()}(${wd})] ${ct}`);
      }
      return lines.join('\n');
    }

    if (cmd === '/journal_edit') {
      const parts   = (args || '').split(' ');
      const id      = parseInt(parts[0], 10);
      const content = parts.slice(1).join(' ');
      if (isNaN(id) || !content) return '사용법: /journal_edit {ID} {새 내용}';
      const emp = await getEmp();
      if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.';
      const row = await updateJournal({ companyId, journalId: id, employeeId: emp.id, content });
      if (!row) return `⚠️ 업무일지 #${id}를 찾을 수 없거나 본인 작성이 아닙니다.`;
      return `✅ 업무일지 #${id} 수정 완료`;
    }

    if (cmd === '/journal_delete') {
      const id = parseInt(args, 10);
      if (isNaN(id)) return '사용법: /journal_delete {ID}';
      const emp = await getEmp();
      if (!emp) return '⚠️ 연결된 직원 정보가 없습니다.';
      const row = await deleteJournal({ companyId, journalId: id, employeeId: emp.id });
      if (!row) return `⚠️ 업무일지 #${id}를 찾을 수 없거나 본인 작성이 아닙니다.`;
      return `🗑️ 업무일지 #${id} 삭제 완료`;
    }
  }

  return null;
}

module.exports = {
  handleCommand,
  uploadDocument, listDocuments, getWeeklyReport,
  createJournal, listJournals, updateJournal, deleteJournal,
};

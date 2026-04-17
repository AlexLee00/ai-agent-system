// @ts-nocheck
'use strict';

/**
 * bots/worker/src/ryan.js — 라이언(Ryan) 프로젝트봇
 *
 * 역할: 프로젝트 관리 + 마일스톤 추적
 *
 * 주요 기능:
 *   - 프로젝트 CRUD (planning → in_progress → review → completed)
 *   - 마일스톤 CRUD + 완료 시 진행률 자동 갱신
 *   - 지연 마일스톤 감지 (due_date 초과)
 *
 * 텔레그램: /projects /project_create /milestone_done
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

const STATUS_LABEL = {
  planning:    '🔵 기획',
  in_progress: '🟡 진행중',
  review:      '🟠 검토',
  completed:   '🟢 완료',
};

/**
 * 마일스톤 완료율 기반 프로젝트 진행률 갱신
 */
async function recalcProgress(projectId, companyId) {
  const [total, done] = await Promise.all([
    pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS cnt
       FROM worker.milestones m
       JOIN worker.projects p ON p.id = m.project_id
       WHERE m.project_id=$1 AND m.deleted_at IS NULL
         AND p.company_id=$2`,
      [projectId, companyId]),
    pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS cnt
       FROM worker.milestones m
       JOIN worker.projects p ON p.id = m.project_id
       WHERE m.project_id=$1 AND m.deleted_at IS NULL
         AND m.status='completed'
         AND p.company_id=$2`,
      [projectId, companyId]),
  ]);
  const totalCnt = Number(total?.cnt ?? 0);
  const doneCnt  = Number(done?.cnt  ?? 0);
  const progress = totalCnt > 0 ? Math.round((doneCnt / totalCnt) * 100) : 0;
  await pgPool.run(SCHEMA,
    `UPDATE worker.projects
     SET progress=$1, updated_at=NOW()
     WHERE id=$2 AND company_id=$3`,
    [progress, projectId, companyId]);
  return progress;
}

// ── 텔레그램 명령어 처리 ──────────────────────────────────────────

const CMD_HANDLERS = {
  '/projects': async (companyId) => {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id, name, status, progress, end_date
       FROM worker.projects
       WHERE company_id=$1 AND deleted_at IS NULL AND status != 'completed'
       ORDER BY created_at DESC LIMIT 10`,
      [companyId]);
    if (!rows.length) return '📋 진행 중 프로젝트 없음';
    const lines = rows.map(r =>
      `• [${r.id}] ${r.name}\n  ${STATUS_LABEL[r.status] ?? r.status} | ${r.progress}% | 마감: ${r.end_date?.slice(0,10) ?? '-'}`
    );
    return `📋 진행 중 프로젝트 (${rows.length}건)\n\n${lines.join('\n\n')}`;
  },

  '/project_create': async (companyId, args) => {
    const name = args.join(' ');
    if (!name) return '사용법: /project_create {프로젝트명}';
    const row = await pgPool.get(SCHEMA,
      `INSERT INTO worker.projects (company_id, name, status) VALUES ($1,$2,'planning') RETURNING id, name`,
      [companyId, name]);
    return `✅ 프로젝트 생성됨\n이름: ${row.name} (ID: ${row.id})`;
  },

  '/milestone_done': async (companyId, args) => {
    const id = parseInt(args[0]);
    if (!id) return '사용법: /milestone_done {마일스톤ID}';
    const ms = await pgPool.get(SCHEMA,
      `UPDATE worker.milestones AS m
       SET status='completed', completed_at=NOW()
       FROM worker.projects AS p
       WHERE m.id=$1
         AND m.deleted_at IS NULL
         AND m.project_id = p.id
         AND p.company_id = $2
       RETURNING m.project_id, m.title`,
      [id, companyId]);
    if (!ms) return `❌ 마일스톤 ID ${id} 없음 (또는 접근 권한 없음)`;
    const progress = await recalcProgress(ms.project_id, companyId);
    return `✅ 마일스톤 완료: ${ms.title}\n프로젝트 진행률: ${progress}%`;
  },
};

async function handleCommand(companyId, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const handler = CMD_HANDLERS[cmd];
  if (!handler) return null;
  return await handler(companyId, args);
}

module.exports = { recalcProgress, handleCommand };

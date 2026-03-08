'use strict';

/**
 * bots/worker/src/chloe.js — 클로이(Chloe) 일정봇
 *
 * 역할: 캘린더 + 알림
 *
 * 주요 기능:
 *   - 일정 CRUD (meeting/task/event/reminder)
 *   - 참석자 다중 선택 (직원 연동)
 *   - 반복 일정: daily/weekly/monthly
 *   - 일정 시작 30분 전 텔레그램 알림
 *   - 오늘 일정 요약 (08:00) / 내일 미리보기 (20:00)
 *
 * 텔레그램: /schedule /schedule_add /schedule_tomorrow
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA = 'worker';

const TYPE_LABEL = {
  meeting:  '📅 미팅',
  task:     '✅ 업무',
  event:    '🎉 이벤트',
  reminder: '🔔 리마인더',
};

function formatSchedule(r) {
  const start = r.start_time ? new Date(r.start_time).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '-';
  return `• ${TYPE_LABEL[r.type] ?? r.type} ${r.title}\n  ${start}${r.location ? ` @ ${r.location}` : ''}`;
}

/**
 * 오늘 일정 조회
 */
async function getTodaySchedules(companyId) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  return pgPool.query(SCHEMA,
    `SELECT * FROM worker.schedules
     WHERE company_id=$1 AND deleted_at IS NULL
       AND start_time >= $2 AND start_time < $3
     ORDER BY start_time`,
    [companyId, start, end]);
}

/**
 * 내일 일정 조회
 */
async function getTomorrowSchedules(companyId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).toISOString();
  const end   = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1).toISOString();
  return pgPool.query(SCHEMA,
    `SELECT * FROM worker.schedules
     WHERE company_id=$1 AND deleted_at IS NULL
       AND start_time >= $2 AND start_time < $3
     ORDER BY start_time`,
    [companyId, start, end]);
}

/**
 * 30분 이내 시작 일정 조회 (알림용)
 */
async function getUpcomingReminders(companyId) {
  const now  = new Date().toISOString();
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return pgPool.query(SCHEMA,
    `SELECT * FROM worker.schedules
     WHERE company_id=$1 AND deleted_at IS NULL
       AND start_time > $2 AND start_time <= $3`,
    [companyId, now, soon]);
}

// ── 텔레그램 명령어 처리 ──────────────────────────────────────────

const CMD_HANDLERS = {
  '/schedule': async (companyId) => {
    const rows = await getTodaySchedules(companyId);
    if (!rows.length) return '📅 오늘 일정 없음';
    return `📅 오늘 일정 (${rows.length}건)\n\n${rows.map(formatSchedule).join('\n\n')}`;
  },

  '/schedule_add': async (companyId, args) => {
    // 사용법: /schedule_add 제목 HH:MM
    if (args.length < 2) return '사용법: /schedule_add {제목} {시간 HH:MM}';
    const time  = args.pop();
    const title = args.join(' ');
    const [h, m] = time.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return '⚠️ 시간 형식 오류 (HH:MM)';
    const today = new Date();
    today.setHours(h, m, 0, 0);
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.schedules (company_id, title, start_time, type)
       VALUES ($1,$2,$3,'task')`,
      [companyId, title, today.toISOString()]);
    return `✅ 일정 등록: ${title} (${time})`;
  },

  '/schedule_tomorrow': async (companyId) => {
    const rows = await getTomorrowSchedules(companyId);
    if (!rows.length) return '📅 내일 일정 없음';
    return `📅 내일 일정 (${rows.length}건)\n\n${rows.map(formatSchedule).join('\n\n')}`;
  },
};

async function handleCommand(companyId, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const handler = CMD_HANDLERS[cmd];
  if (!handler) return null;
  return await handler(companyId, args);
}

module.exports = { getTodaySchedules, getTomorrowSchedules, getUpcomingReminders, handleCommand };

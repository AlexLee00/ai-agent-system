'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const emily = require('./emily');
const noah = require('./noah');
const oliver = require('./oliver');
const ryan = require('./ryan');
const sophie = require('./sophie');
const chloe = require('./chloe');

const SCHEMA = 'worker';
const POLL_MS = parseInt(process.env.WORKER_TASK_POLL_MS || '15000', 10);

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }
  return payload;
}

async function claimNextTask() {
  return pgPool.get(SCHEMA, `
    WITH next_task AS (
      SELECT id
      FROM worker.agent_tasks
      WHERE status='queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE worker.agent_tasks t
    SET status='processing', updated_at=NOW()
    FROM next_task
    WHERE t.id = next_task.id
    RETURNING t.*
  `);
}

async function finishTask(taskId, status, payload) {
  const done = status === 'completed' || status === 'failed' || status === 'rejected';
  return pgPool.run(SCHEMA, `
    UPDATE worker.agent_tasks
    SET status=$2,
        payload=$3::jsonb,
        updated_at=NOW(),
        completed_at=CASE WHEN $4 THEN NOW() ELSE completed_at END
    WHERE id=$1
  `, [taskId, status, JSON.stringify(payload || {}), done]);
}

function summarizeList(prefix, items) {
  if (!items?.length) return `${prefix} 없음`;
  return `${prefix} ${items.length}건`;
}

async function runEmily(companyId, task) {
  const payload = parsePayload(task.payload);
  const raw = String(payload.raw_text || task.description || '').trim();

  if (/목록|리스트/.test(raw)) {
    const rows = await emily.listDocuments({ companyId, limit: 5 });
    return {
      summary: rows.length ? `문서 ${rows.length}건을 확인했습니다.` : '등록된 문서가 없습니다.',
      details: rows.map(row => `[${row.category}] ${row.filename}`),
    };
  }

  if (/검색/.test(raw)) {
    const keyword = raw.replace(/.*검색\s*/i, '').trim();
    const rows = await emily.listDocuments({ companyId, limit: 5, keyword });
    return {
      summary: rows.length ? `"${keyword}" 검색 결과 ${rows.length}건입니다.` : `"${keyword}" 검색 결과가 없습니다.`,
      details: rows.map(row => `[${row.category}] ${row.filename}`),
    };
  }

  return {
    summary: '문서 관련 요청으로 접수했습니다. 파일 업로드 또는 검색어가 있으면 더 정확히 처리할 수 있습니다.',
    details: [],
  };
}

async function runNoah(companyId, task) {
  const payload = parsePayload(task.payload);
  const raw = String(payload.raw_text || task.description || '').trim();

  if (/직원|목록/.test(raw)) {
    const rows = await noah.listEmployees({ companyId });
    return {
      summary: summarizeList('직원', rows),
      details: rows.slice(0, 5).map(row => `${row.name} (${[row.position, row.department].filter(Boolean).join(' / ') || '미설정'})`),
    };
  }

  if (/근태|출근|퇴근/.test(raw)) {
    const rows = await noah.getTodayAttendance({ companyId });
    const checkedIn = rows.filter(row => row.check_in).length;
    return {
      summary: `오늘 근태 ${rows.length}명 중 ${checkedIn}명이 출근 처리되었습니다.`,
      details: rows.slice(0, 5).map(row => `${row.name}: ${row.check_in ? '출근' : '미출근'} / ${row.check_out ? '퇴근' : '근무중'}`),
    };
  }

  return {
    summary: '인사 요청으로 접수했습니다. 직원 목록, 근태, 휴가 같은 세부 요청을 주시면 바로 처리할 수 있습니다.',
    details: [],
  };
}

async function runSophie(companyId, task) {
  const payload = parsePayload(task.payload);
  const raw = String(payload.raw_text || task.description || '').trim();
  const yearMonth = new Date().toISOString().slice(0, 7);

  if (/계산|정산/.test(raw)) {
    const rows = await sophie.calculatePayroll(companyId, yearMonth);
    return {
      summary: `${yearMonth} 급여 계산을 실행했습니다. ${rows.length}명 처리 완료.`,
      details: rows.slice(0, 5).map(row => `${row.employee}: ₩${Number(row.net_salary || 0).toLocaleString()}`),
    };
  }

  const text = await sophie.handleCommand(companyId, '/payroll_summary');
  return {
    summary: text || `${yearMonth} 급여 요약을 불러오지 못했습니다.`,
    details: [],
  };
}

async function runOliver(companyId, task) {
  const payload = parsePayload(task.payload);
  const raw = String(payload.raw_text || task.description || '').trim();

  if (/분석/.test(raw)) {
    return {
      summary: await oliver.handleCommand('/sales_analysis', '', { user: { company_id: companyId } }),
      details: [],
    };
  }

  if (/주간|이번 주/.test(raw)) {
    return {
      summary: await oliver.handleCommand('/sales_week', '', { user: { company_id: companyId } }),
      details: [],
    };
  }

  return {
    summary: await oliver.handleCommand('/sales_today', '', { user: { company_id: companyId } }),
    details: [],
  };
}

async function runRyan(companyId) {
  const text = await ryan.handleCommand(companyId, '/projects');
  return { summary: text || '진행 중 프로젝트가 없습니다.', details: [] };
}

async function runChloe(companyId, task) {
  const payload = parsePayload(task.payload);
  const raw = String(payload.raw_text || task.description || '').trim();
  const text = /내일/.test(raw)
    ? await chloe.handleCommand(companyId, '/schedule_tomorrow')
    : await chloe.handleCommand(companyId, '/schedule');
  return { summary: text || '일정을 불러오지 못했습니다.', details: [] };
}

async function executeTask(task) {
  const target = String(task.target_bot || '').toLowerCase();
  switch (target) {
    case 'emily':
      return runEmily(task.company_id, task);
    case 'noah':
      return runNoah(task.company_id, task);
    case 'sophie':
      return runSophie(task.company_id, task);
    case 'oliver':
      return runOliver(task.company_id, task);
    case 'ryan':
      return runRyan(task.company_id, task);
    case 'chloe':
      return runChloe(task.company_id, task);
    default:
      return {
        summary: `${target || 'unknown'} 실행기는 아직 연결되지 않았습니다.`,
        details: [],
      };
  }
}

async function processOne() {
  const task = await claimNextTask();
  if (!task) return false;

  const payload = parsePayload(task.payload);
  try {
    const result = await executeTask(task);
    await finishTask(task.id, 'completed', {
      ...payload,
      handled_by: task.target_bot,
      result_summary: result.summary,
      result_details: result.details || [],
    });
    console.log(`[worker-task-runner] completed #${task.id} ${task.target_bot}`);
  } catch (error) {
    await finishTask(task.id, 'failed', {
      ...payload,
      handled_by: task.target_bot,
      error: error.message,
    });
    console.error(`[worker-task-runner] failed #${task.id} ${task.target_bot}: ${error.message}`);
  }

  return true;
}

async function main() {
  console.log('[worker-task-runner] 실행기 가동');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const processed = await processOne();
    await new Promise(resolve => setTimeout(resolve, processed ? 1000 : POLL_MS));
  }
}

module.exports = { processOne, executeTask };

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

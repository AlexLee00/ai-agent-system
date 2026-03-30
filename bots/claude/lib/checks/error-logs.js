'use strict';

const { fetchOpsErrors } = require('../../../../packages/core/lib/hub-client');

async function checkErrorLogs() {
  const items = [];

  try {
    const data = await fetchOpsErrors(60);
    if (!data || !data.ok) {
      items.push({ label: 'Hub 에러 조회', status: 'warn', detail: '응답 없음' });
      return {
        name: '에러 로그',
        status: 'warn',
        items,
      };
    }

    if (data.total_errors === 0) {
      items.push({ label: '에러 로그', status: 'ok', detail: '최근 1시간 에러 없음' });
    } else {
      for (const svc of data.services) {
        const status = svc.error_count >= 10 ? 'error' : svc.error_count >= 3 ? 'warn' : 'ok';
        const tail = svc.recent_errors[svc.recent_errors.length - 1] || '';
        items.push({
          label: svc.service,
          status,
          detail: `${svc.error_count}건 — ${tail.slice(0, 200)}`,
        });
      }
    }
  } catch (error) {
    items.push({ label: 'Hub 에러 조회', status: 'warn', detail: error.message });
  }

  const hasError = items.some((item) => item.status === 'error');
  const hasWarn = items.some((item) => item.status === 'warn');

  return {
    name: '에러 로그',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

async function run() {
  return checkErrorLogs();
}

module.exports = { run, checkErrorLogs };

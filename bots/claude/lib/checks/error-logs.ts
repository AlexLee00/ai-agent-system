// @ts-nocheck
'use strict';

const { fetchOpsErrors } = require('../../../../packages/core/lib/hub-client');
const { execSync } = require('child_process');
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');

const SERVICE_LABEL_MAP = {
  'investment-crypto': 'ai.investment.crypto',
  'investment-crypto-validation': 'ai.investment.crypto.validation',
  'investment-domestic': 'ai.investment.domestic',
  'investment-domestic-validation': 'ai.investment.domestic.validation',
  'investment-overseas': 'ai.investment.overseas',
  'investment-overseas-validation': 'ai.investment.overseas.validation',
  'investment-prescreen-domestic': 'ai.investment.prescreen-domestic',
  'investment-reporter': 'ai.investment.reporter',
  'investment-argos': 'ai.investment.argos',
  'investment-market-alert-overseas-open': 'ai.investment.market-alert-overseas-open',
  'investment-market-alert-overseas-close': 'ai.investment.market-alert-overseas-close',
  'investment-market-alert-domestic-open': 'ai.investment.market-alert-domestic-open',
  'investment-market-alert-crypto-daily': 'ai.investment.market-alert-crypto-daily',
  'unrealized-pnl': 'ai.investment.unrealized-pnl',
  'ai.luna.tradingview-ws': 'ai.luna.tradingview-ws',
  'mlx-server': 'ai.mlx.server',
};

function getLaunchdStatus(label) {
  if (!LAUNCHD_AVAILABLE || !label) return null;
  try {
    const out = execSync(`launchctl print gui/501/${label}`, { encoding: 'utf8', timeout: 5000 });
    const state = out.match(/state = ([^\n]+)/)?.[1]?.trim() || '';
    const pid = out.match(/\npid = ([^\n]+)/)?.[1]?.trim() || '';
    const lastExitCode = Number(out.match(/last exit code = ([^\n]+)/)?.[1]?.trim() || NaN);
    return { state, pid, lastExitCode };
  } catch {
    try {
      const out = execSync(`launchctl list ${label}`, { encoding: 'utf8', timeout: 5000 }).trim();
      const [pidRaw, lastExitRaw] = out.split(/\s+/);
      const pid = pidRaw === '-' ? '' : pidRaw;
      const lastExitCode = Number(lastExitRaw);
      return {
        state: pid ? 'running' : 'loaded',
        pid,
        lastExitCode,
      };
    } catch {
      return null;
    }
  }
}

function isCurrentlyHealthy(launchdStatus) {
  if (!launchdStatus) return false;
  if (launchdStatus.state === 'running' || launchdStatus.state === 'xpcproxy') return true;
  return Number.isFinite(launchdStatus.lastExitCode) && launchdStatus.lastExitCode === 0;
}

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
        const launchdLabel = SERVICE_LABEL_MAP[svc.service] || null;
        const launchdStatus = getLaunchdStatus(launchdLabel);
        const healthyNow = isCurrentlyHealthy(launchdStatus);
        let status = svc.error_count >= 10 ? 'error' : svc.error_count >= 3 ? 'warn' : 'ok';
        const tail = svc.recent_errors[svc.recent_errors.length - 1] || '';
        let detail = `${svc.error_count}건 — ${tail.slice(0, 200)}`;

        if (healthyNow) {
          status = 'ok';
          detail += ` | 현재 상태 정상 (${launchdStatus.state || `exit ${launchdStatus.lastExitCode}`})`;
        }

        items.push({
          label: svc.service,
          status,
          detail,
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

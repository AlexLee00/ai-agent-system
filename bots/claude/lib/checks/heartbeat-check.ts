// @ts-nocheck
'use strict';

const { listHeartbeats } = require('../../../../packages/core/lib/agent-heartbeats');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { execSync } = require('child_process');
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');
const { getServiceOwnership } = require('../../../../packages/core/lib/service-ownership.js');

const DEFAULT_WARN_MINUTES = 60;
const DEFAULT_ERROR_MINUTES = 180;

const AGENT_THRESHOLDS = {
  'luna-crypto': { label: '루나팀 crypto heartbeat', warnMinutes: 90, errorMinutes: 180 },
  'andy': { label: '스카팀 andy heartbeat', warnMinutes: 20, errorMinutes: 45 },
};

function resolveStatus(ageMinutes, warnMinutes, errorMinutes) {
  if (ageMinutes >= errorMinutes) return 'error';
  if (ageMinutes >= warnMinutes) return 'warn';
  return 'ok';
}

async function loadReservationAgentState(agentName) {
  try {
    return await pgPool.get(
      'reservation',
      'SELECT status, updated_at, last_success_at FROM agent_state WHERE agent = $1 LIMIT 1',
      [agentName],
    );
  } catch (_e) {
    return null;
  }
}

function formatMinutesAgo(ts, now) {
  const ms = ts ? new Date(ts).getTime() : 0;
  if (!ms) return null;
  return Math.floor((now - ms) / 60000);
}

function softenAndyHeartbeatIfActive(item, reservationState, now) {
  if (!reservationState) return item;

  const stateStatus = String(reservationState.status || '').toLowerCase();
  const updatedMinutes = formatMinutesAgo(reservationState.updated_at, now);
  const successMinutes = formatMinutesAgo(reservationState.last_success_at, now);
  const recentlyActive =
    Number.isFinite(updatedMinutes) &&
    updatedMinutes <= 15 &&
    (stateStatus === 'idle' || stateStatus === 'running' || stateStatus === 'ok');

  if (!recentlyActive) return item;

  const bits = [
    `reservation.agent_state=${stateStatus || 'unknown'}`,
    Number.isFinite(updatedMinutes) ? `${updatedMinutes}분 전 업데이트` : null,
    Number.isFinite(successMinutes) ? `${successMinutes}분 전 마지막 성공` : null,
  ].filter(Boolean);

  return {
    ...item,
    status: 'ok',
    detail: `${item.detail} | ${bits.join(', ')}`,
  };
}

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

function isHealthyLaunchdStatus(status) {
  if (!status) return false;
  if (status.state === 'running' || status.state === 'xpcproxy') return true;
  return Number.isFinite(status.lastExitCode) && status.lastExitCode === 0;
}

function softenRetiredLunaCryptoHeartbeatIfReplacementHealthy(item) {
  const retiredService = getServiceOwnership('ai.investment.crypto');
  const replacement = retiredService?.replacement || 'ai.luna.marketdata-mcp';
  const replacementStatus = getLaunchdStatus(replacement);

  if (!isHealthyLaunchdStatus(replacementStatus)) return item;

  const stateLabel = replacementStatus.state || (replacementStatus.lastExitCode === 0 ? 'loaded' : 'unknown');
  return {
    ...item,
    status: 'ok',
    detail: `${item.detail} | retired cycle replaced by ${replacement} (${stateLabel})`,
  };
}

async function run() {
  const items = [];
  let rows = [];

  try {
    rows = await listHeartbeats();
  } catch (e) {
    items.push({ label: 'agent heartbeat', status: 'warn', detail: `조회 실패: ${e.message}` });
    return { name: '에이전트 heartbeat', status: 'warn', items };
  }

  if (!rows || rows.length === 0) {
    items.push({ label: 'agent heartbeat', status: 'ok', detail: '기록 없음' });
    return { name: '에이전트 heartbeat', status: 'ok', items };
  }

  const now = Date.now();
  for (const row of rows) {
    const policy = AGENT_THRESHOLDS[row.agent_name] || {};
    const label = policy.label || `${row.agent_name} heartbeat`;
    const warnMinutes = policy.warnMinutes || DEFAULT_WARN_MINUTES;
    const errorMinutes = policy.errorMinutes || DEFAULT_ERROR_MINUTES;
    const lastMs = row.last_heartbeat ? new Date(row.last_heartbeat).getTime() : 0;
    const ageMinutes = lastMs > 0 ? Math.floor((now - lastMs) / 60000) : Number.POSITIVE_INFINITY;
    const status = resolveStatus(ageMinutes, warnMinutes, errorMinutes);
    const detail = Number.isFinite(ageMinutes)
      ? `${ageMinutes}분 전 heartbeat (상태: ${row.status})`
      : 'heartbeat 시각 없음';
    let item = { label, status, detail };

    if (row.agent_name === 'andy' && status !== 'ok') {
      const reservationState = await loadReservationAgentState('andy');
      item = softenAndyHeartbeatIfActive(item, reservationState, now);
    }

    if (row.agent_name === 'luna-crypto' && status !== 'ok') {
      item = softenRetiredLunaCryptoHeartbeatIfReplacementHealthy(item);
    }

    items.push(item);
  }

  const overall = items.some(item => item.status === 'error')
    ? 'error'
    : items.some(item => item.status === 'warn') ? 'warn' : 'ok';
  return { name: '에이전트 heartbeat', status: overall, items };
}

module.exports = { run };

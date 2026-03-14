'use strict';

const { execSync } = require('child_process');
const hsm = require('./health-state-manager');

const DEFAULT_NORMAL_EXIT_CODES = new Set([0, -9, -15]);

function getLaunchctlStatus() {
  const raw = execSync('launchctl list', { encoding: 'utf-8' });
  const services = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      running: pid !== '-',
      pid: pid !== '-' ? parseInt(pid, 10) : null,
      exitCode: Number.parseInt(exitCode, 10) || 0,
    };
  }
  return services;
}

function buildServiceRows(status, {
  labels = [],
  continuous = [],
  normalExitCodes = DEFAULT_NORMAL_EXIT_CODES,
  shortLabel = (label) => hsm.shortLabel(label),
  isExpectedExit = () => false,
} = {}) {
  const ok = [];
  const warn = [];

  for (const label of labels) {
    const svc = status[label];
    const name = shortLabel(label);
    if (!svc) {
      warn.push(`  ${name}: 미로드`);
      continue;
    }
    if (continuous.includes(label) && !svc.running) {
      warn.push(`  ${name}: 다운 (PID 없음)`);
      continue;
    }
    if (
      !normalExitCodes.has(svc.exitCode) &&
      !isExpectedExit(label, svc.exitCode, svc) &&
      !(continuous.includes(label) && svc.running)
    ) {
      warn.push(`  ${name}: exit ${svc.exitCode}`);
      continue;
    }
    if (svc.running && svc.pid) {
      ok.push(`  ${name}: 정상 (PID ${svc.pid})`);
    } else if (isExpectedExit(label, svc.exitCode, svc)) {
      ok.push(`  ${name}: 점검 완료 (exit ${svc.exitCode})`);
    } else {
      ok.push(`  ${name}: 정상`);
    }
  }

  return { ok, warn };
}

module.exports = {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
};

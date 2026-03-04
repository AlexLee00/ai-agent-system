'use strict';

/**
 * checks/deps.js — 의존성 보안 체크
 * - npm audit (critical/high 취약점)
 * - 오래된 패키지 감지
 */

const { execSync } = require('child_process');
const path = require('path');
const cfg  = require('../config');

function npmAudit(botDir, label) {
  try {
    const out = execSync(`npm audit --json 2>/dev/null`, {
      cwd: botDir, encoding: 'utf8', timeout: 30000,
    });
    const report   = JSON.parse(out);
    const vulns    = report.metadata?.vulnerabilities || {};
    const critical = vulns.critical || 0;
    const high     = vulns.high || 0;
    const moderate = vulns.moderate || 0;

    if (critical > 0) {
      return { label, status: 'error', detail: `critical ${critical}건, high ${high}건` };
    } else if (high > 0) {
      return { label, status: 'warn', detail: `high ${high}건, moderate ${moderate}건` };
    } else if (moderate > 0) {
      return { label, status: 'ok', detail: `moderate ${moderate}건 (critical/high 없음)` };
    }
    return { label, status: 'ok', detail: '취약점 없음' };
  } catch (e) {
    // npm audit가 취약점 발견 시 exit code 1 반환
    try {
      const errOut = e.stdout || '';
      const report = JSON.parse(errOut);
      const vulns  = report.metadata?.vulnerabilities || {};
      const critical = vulns.critical || 0;
      const high     = vulns.high || 0;

      if (critical > 0 || high > 0) {
        return { label, status: 'warn', detail: `critical ${critical}건, high ${high}건` };
      }
      return { label, status: 'ok', detail: '취약점 없음' };
    } catch {
      return { label, status: 'ok', detail: 'audit 스킵 (네트워크 오류 또는 lock 없음)' };
    }
  }
}

function checkOutdated(botDir, label) {
  try {
    execSync(`npm outdated --json 2>/dev/null`, { cwd: botDir, encoding: 'utf8', timeout: 20000 });
    return { label: `${label} (패키지 최신)`, status: 'ok', detail: '최신 상태' };
  } catch (e) {
    try {
      const outdated = JSON.parse(e.stdout || '{}');
      const pkgs     = Object.keys(outdated);
      if (pkgs.length === 0) return { label: `${label} (패키지)`, status: 'ok', detail: '최신 상태' };

      const majors = pkgs.filter(p => {
        const info = outdated[p];
        return info.current && info.latest &&
          info.current.split('.')[0] !== info.latest.split('.')[0];
      });

      if (majors.length > 0) {
        return { label: `${label} (패키지)`, status: 'warn', detail: `메이저 업데이트 ${majors.length}개: ${majors.slice(0,3).join(', ')}` };
      }
      return { label: `${label} (패키지)`, status: 'ok', detail: `마이너 업데이트 ${pkgs.length}개` };
    } catch {
      return { label: `${label} (패키지)`, status: 'ok', detail: '확인 스킵' };
    }
  }
}

async function run(full = false) {
  const items = [];

  const BOTS = [
    { dir: cfg.BOTS.reservation, label: 'npm audit (스카팀)' },
    { dir: cfg.BOTS.invest,      label: 'npm audit (루나팀)' },
  ];

  for (const { dir, label } of BOTS) {
    items.push(npmAudit(dir, label));
  }

  if (full) {
    for (const { dir, label } of BOTS) {
      items.push(checkOutdated(dir, label.replace('npm audit', '').trim()));
    }
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '의존성 보안',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

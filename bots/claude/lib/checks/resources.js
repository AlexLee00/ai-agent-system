'use strict';

/**
 * checks/resources.js — 리소스 모니터링
 * - 디스크 여유 공간 (봇 디렉토리, /tmp)
 * - 시스템 메모리
 * - 로그 파일 크기
 * - 봇 프로세스 메모리 사용량
 */

const os   = require('os');
const fs   = require('fs');
const { execSync } = require('child_process');
const cfg  = require('../config');

function diskFree(dirPath) {
  try {
    const out = execSync(`df -k "${dirPath}"`, { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n')[1];
    const kb   = parseInt(line.trim().split(/\s+/)[3], 10);
    return Math.floor(kb / 1024); // MB
  } catch { return null; }
}

function checkDisk(items) {
  const targets = [
    { path: cfg.ROOT,  label: '프로젝트 디렉토리' },
    { path: '/tmp',    label: '/tmp' },
  ];

  for (const { path: p, label } of targets) {
    const mb = diskFree(p);
    if (mb === null) {
      items.push({ label: `디스크 (${label})`, status: 'warn', detail: '확인 실패' });
    } else if (mb < cfg.THRESHOLDS.diskMinMB) {
      items.push({ label: `디스크 (${label})`, status: 'error', detail: `여유 ${mb}MB (최소 ${cfg.THRESHOLDS.diskMinMB}MB)` });
    } else if (mb < cfg.THRESHOLDS.diskMinMB * 2) {
      items.push({ label: `디스크 (${label})`, status: 'warn', detail: `여유 ${mb}MB (여유 부족 주의)` });
    } else {
      items.push({ label: `디스크 (${label})`, status: 'ok', detail: `여유 ${mb.toLocaleString()}MB` });
    }
  }
}

function checkMemory(items) {
  const totalGB = os.totalmem() / 1073741824;
  const freeGB  = os.freemem()  / 1073741824;
  const usedPct = ((totalGB - freeGB) / totalGB * 100).toFixed(1);

  if (freeGB < cfg.THRESHOLDS.memMinFreeGB) {
    items.push({ label: '시스템 메모리', status: 'warn', detail: `여유 ${freeGB.toFixed(1)}GB / ${totalGB.toFixed(0)}GB (사용 ${usedPct}%)` });
  } else {
    items.push({ label: '시스템 메모리', status: 'ok', detail: `여유 ${freeGB.toFixed(1)}GB / ${totalGB.toFixed(0)}GB (사용 ${usedPct}%)` });
  }
}

function checkLogSizes(items) {
  const logs = [
    { path: cfg.LOGS.naver,  label: '스카 로그' },
    { path: cfg.LOGS.invest, label: '루나 파이프라인 로그' },
    { path: cfg.LOGS.bridge, label: '루나 브릿지 로그' },
  ];

  for (const { path: p, label } of logs) {
    if (!fs.existsSync(p)) continue;
    const mb = fs.statSync(p).size / 1048576;
    if (mb > cfg.THRESHOLDS.logMaxMB) {
      items.push({ label, status: 'warn', detail: `${mb.toFixed(1)}MB — 로테이션 권장: truncate -s 0 ${p}` });
    } else {
      items.push({ label, status: 'ok', detail: `${mb.toFixed(2)}MB` });
    }
  }
}

function checkBotMemory(items) {
  try {
    // node 프로세스 메모리 (RSS MB)
    const out = execSync('ps aux | grep "node.*invest\\|node.*reservation" | grep -v grep | awk \'{print $4, $11}\'',
      { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) {
      items.push({ label: '봇 프로세스 메모리', status: 'ok', detail: '실행 중인 봇 없음' });
      return;
    }
    for (const line of out.split('\n').filter(Boolean)) {
      const [pct, cmd] = line.split(' ');
      const name = cmd.includes('invest') ? '루나팀' : '스카팀';
      items.push({ label: `${name} 프로세스`, status: parseFloat(pct) > 10 ? 'warn' : 'ok', detail: `메모리 ${pct}%` });
    }
  } catch {
    items.push({ label: '봇 프로세스 메모리', status: 'ok', detail: '확인 스킵' });
  }
}

async function run() {
  const items = [];

  checkDisk(items);
  checkMemory(items);
  checkLogSizes(items);
  checkBotMemory(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '리소스',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

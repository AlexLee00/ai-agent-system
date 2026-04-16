// @ts-nocheck
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

function pathExists(target) {
  return typeof target === 'string' && target.length > 0 && fs.existsSync(target);
}

function getAvailableMemoryGB() {
  try {
    const vmstat = execSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
    const page   = 16384;
    const get    = key => {
      const m = vmstat.match(new RegExp(key + ':\\s+(\\d+)'));
      return m ? parseInt(m[1], 10) * page / 1073741824 : 0;
    };
    return get('Pages free') + get('Pages inactive') + get('Pages speculative');
  } catch {
    return os.freemem() / 1073741824;
  }
}

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
  const freeGB = getAvailableMemoryGB();
  const usedPctNum = ((totalGB - freeGB) / totalGB * 100);
  const usedPct = usedPctNum.toFixed(1);

  if (freeGB < Math.max(2, cfg.THRESHOLDS.memMinFreeGB / 2) || (freeGB < cfg.THRESHOLDS.memMinFreeGB && usedPctNum >= 90)) {
    items.push({ label: '시스템 메모리', status: 'warn', detail: `여유 ${freeGB.toFixed(1)}GB / ${totalGB.toFixed(0)}GB (사용 ${usedPct}%)` });
  } else {
    items.push({ label: '시스템 메모리', status: 'ok', detail: `여유 ${freeGB.toFixed(1)}GB / ${totalGB.toFixed(0)}GB (사용 ${usedPct}%)` });
  }
}

function checkLogSizes(items) {
  const logs = [
    { path: cfg.LOGS.naver,    label: '스카 로그' },
    { path: cfg.LOGS.crypto,   label: '루나 크립토 로그' },
    { path: cfg.LOGS.domestic, label: '루나 국내주식 로그' },
    { path: cfg.LOGS.overseas, label: '루나 해외주식 로그' },
  ];

  for (const { path: p, label } of logs) {
    if (!pathExists(p)) continue;
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

// macOS swap 사용량 체크
function checkSwap(items) {
  try {
    const out = execSync('/usr/sbin/sysctl vm.swapusage', { encoding: 'utf8', timeout: 3000 });
    // 예: "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M"
    const usedM = out.match(/used\s*=\s*([\d.]+)M/);
    if (!usedM) {
      items.push({ label: 'Swap', status: 'ok', detail: 'Swap 없음 (정상)' });
      return;
    }
    const usedMB = parseFloat(usedM[1]);
    const freeGB = getAvailableMemoryGB();
    if (usedMB > 8192 || (usedMB > 2048 && freeGB < cfg.THRESHOLDS.memMinFreeGB)) {
      items.push({ label: 'Swap', status: 'warn', detail: `${(usedMB / 1024).toFixed(1)}GB 사용 중 — 메모리 여유와 함께 확인 필요` });
    } else if (usedMB > 0) {
      items.push({ label: 'Swap', status: 'ok', detail: `${usedMB.toFixed(0)}MB 사용 (여유 메모리 ${freeGB.toFixed(1)}GB)` });
    } else {
      items.push({ label: 'Swap', status: 'ok', detail: '미사용' });
    }
  } catch {
    items.push({ label: 'Swap', status: 'ok', detail: '확인 스킵' });
  }
}

// Ollama 프로세스 메모리 체크
function checkOllamaMemory(items) {
  try {
    const out = execSync('ps aux | grep -E "ollama" | grep -v grep | awk \'{print $4, $6}\'',
      { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) {
      items.push({ label: 'Ollama', status: 'ok', detail: '미실행' });
      return;
    }
    let totalRssMB = 0;
    let maxPct = 0;
    for (const line of out.split('\n').filter(Boolean)) {
      const [pct = '0', rsKB = '0'] = line.split(/\s+/);
      totalRssMB += parseInt(rsKB, 10) / 1024;
      maxPct = Math.max(maxPct, parseFloat(pct));
    }
    const rssMB = Math.round(totalRssMB);
    // Ollama 기본 모델(qwen2.5:7b) ~ 4GB 이하 정상, 10GB 초과 warn
    items.push({
      label:  'Ollama',
      status: rssMB > 10240 ? 'warn' : 'ok',
      detail: rssMB > 10240
        ? `${(rssMB / 1024).toFixed(1)}GB 점유 (10GB 초과 — 모델 확인)`
        : `${(rssMB / 1024).toFixed(1)}GB (메모리 ${maxPct.toFixed(1)}%)`,
    });
  } catch {
    items.push({ label: 'Ollama', status: 'ok', detail: '확인 스킵' });
  }
}

// 단일 로그 파일 1GB 초과 체크 (전체 /tmp + 로그 경로)
function checkHugeLogFiles(items) {
  const WATCH = [
    cfg.LOGS.naver,
    cfg.LOGS.crypto,
    cfg.LOGS.domestic,
    cfg.LOGS.overseas,
    cfg.LOGS.dexter,
    '/tmp/naver-ops-mode.log',
  ];

  let found = 0;
  for (const p of WATCH) {
    if (!pathExists(p)) continue;
    const mb = fs.statSync(p).size / 1048576;
    if (mb > 1024) {
      found++;
      items.push({ label: `거대 로그 파일`, status: 'error', detail: `${(mb / 1024).toFixed(1)}GB: ${p}` });
    }
  }
  if (found === 0) {
    items.push({ label: '로그 파일 크기 (1GB 초과)', status: 'ok', detail: '없음' });
  }
}

async function run() {
  const items = [];

  checkDisk(items);
  checkMemory(items);
  checkSwap(items);
  checkLogSizes(items);
  checkHugeLogFiles(items);
  checkBotMemory(items);
  checkOllamaMemory(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '리소스',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

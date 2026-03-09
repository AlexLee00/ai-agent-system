'use strict';

/**
 * checks/network.js — 네트워크 연결성 체크
 * - Binance, Upbit, Telegram, Naver, Anthropic API ping
 */

const https = require('https');
const http  = require('http');
const cfg   = require('../config');

function ping(endpoint, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const lib     = endpoint.https === false ? http : https;
    const req     = lib.request({
      hostname: endpoint.host,
      port:     endpoint.port,
      path:     endpoint.path,
      method:   'GET',
      timeout:  timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: true, ms: Date.now() - start, code: res.statusCode }));
    });
    req.on('error',   () => resolve({ ok: false, ms: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeoutMs, timeout: true }); });
    req.end();
  });
}

// OpenClaw 게이트웨이 포트 18789 바인딩 확인
async function checkOpenClawPort(items) {
  const ep = { host: '127.0.0.1', port: 18789, path: '/health', https: false };
  const r  = await ping(ep, 3000);
  if (!r.ok) {
    // 포트 바인딩 자체를 lsof로 확인
    const { execSync } = require('child_process');
    try {
      const lsofOut = execSync('lsof -i :18789 -sTCP:LISTEN 2>/dev/null | wc -l', { encoding: 'utf8', timeout: 3000 }).trim();
      const listening = parseInt(lsofOut, 10) > 1;
      items.push({
        label:  'OpenClaw 게이트웨이 (포트 18789)',
        status: listening ? 'ok' : 'warn',
        detail: listening ? '포트 바인딩 확인 (HTTP 응답 없음)' : '포트 미바인딩 — launchd 확인',
      });
    } catch {
      items.push({ label: 'OpenClaw 게이트웨이 (포트 18789)', status: 'warn', detail: '포트 확인 실패' });
    }
  } else {
    items.push({ label: 'OpenClaw 게이트웨이 (포트 18789)', status: 'ok', detail: `응답 ${r.ms}ms (HTTP ${r.code})` });
  }
}

// Tailscale 연결 상태 확인
function checkTailscale(items) {
  const { execSync } = require('child_process');
  try {
    const out = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const data = JSON.parse(out);
    const self = data.Self;
    if (!self || !self.Online) {
      items.push({ label: 'Tailscale', status: 'warn', detail: '오프라인 (VPN 끊김)' });
    } else {
      const ip = (self.TailscaleIPs || [])[0] || '';
      items.push({ label: 'Tailscale', status: 'ok', detail: `온라인 (${ip})` });
    }
  } catch {
    // tailscale 미설치 or 오류 — 정보 없음
    items.push({ label: 'Tailscale', status: 'ok', detail: '확인 스킵 (미설치)' });
  }
}

// SSH 실패 로그인 수 확인 (macOS: /var/log/auth.log 또는 log show)
function checkSshFailedLogins(items) {
  const { execSync } = require('child_process');
  try {
    // macOS 빅서 이상: log show로 최근 1시간 SSH 실패 확인
    const out = execSync(
      'log show --predicate \'process == "sshd" && eventMessage contains "Failed"\' --last 1h --style compact 2>/dev/null | wc -l',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
    const cnt = Math.max(0, parseInt(out, 10) - 1); // 헤더 1줄 제거
    if (cnt > 20) {
      items.push({ label: 'SSH 실패 로그인 (1시간)', status: 'warn', detail: `${cnt}건 — 브루트포스 의심` });
    } else {
      items.push({ label: 'SSH 실패 로그인 (1시간)', status: 'ok', detail: `${cnt}건` });
    }
  } catch {
    items.push({ label: 'SSH 실패 로그인', status: 'ok', detail: '확인 스킵' });
  }
}

async function run() {
  const items = [];

  const results = await Promise.all(
    Object.entries(cfg.ENDPOINTS).map(async ([, ep]) => {
      const r = await ping(ep);
      return { ep, r };
    })
  );

  for (const { ep, r } of results) {
    if (!r.ok) {
      items.push({
        label:  ep.label,
        status: 'error',
        detail: r.timeout ? `타임아웃 (${r.ms}ms)` : '연결 실패',
      });
    } else if (r.ms > 3000) {
      items.push({ label: ep.label, status: 'warn',  detail: `응답 느림 (${r.ms}ms)` });
    } else {
      items.push({ label: ep.label, status: 'ok',    detail: `${r.ms}ms (HTTP ${r.code})` });
    }
  }

  // OpenClaw 포트 + Tailscale + SSH — 순차 실행
  await checkOpenClawPort(items);
  checkTailscale(items);
  checkSshFailedLogins(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '네트워크 연결',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

'use strict';

/**
 * checks/network.js — 네트워크 연결성 체크
 * - Binance, Upbit, Telegram, Naver, Anthropic API ping
 */

const https = require('https');
const cfg   = require('../config');

function ping(endpoint, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req   = https.request({
      hostname: endpoint.host,
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

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '네트워크 연결',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

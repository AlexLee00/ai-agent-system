#!/usr/bin/env node
'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * scripts/dashboard-server.js — 스카팀 실시간 예약 현황 대시보드
 *
 * 오늘 예약 현황 / 매출 / 미해결 알람을 웹으로 확인
 *
 * 실행: node scripts/dashboard-server.js [--port=3031]
 * 브라우저: http://localhost:3031
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag = require('../../../packages/core/lib/rag-safe');
const { createSkaReadService } = require('../lib/ska-read-service');

const args    = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const PORT    = portArg ? parseInt(portArg.split('=')[1]) : 3031;

const HTML_FILE = path.join(__dirname, 'dashboard.html');
const readService = createSkaReadService({ pgPool, rag });
const WEBHOOK_SECRET = process.env.SKA_WEBHOOK_SECRET || '';

// ─── 데이터 조회 ─────────────────────────────────────────────────────

async function getTodayData() {
  const today = kst.today();

  const [reservations, summary, alerts] = await Promise.all([
    pgPool.query('reservation', `
      SELECT start_time, end_time, room, status
      FROM reservations
      WHERE date = $1 AND status != 'cancelled'
      ORDER BY start_time, room
    `, [today]),

    pgPool.get('reservation', `
      SELECT total_amount, entries_count
      FROM daily_summary
      WHERE date = $1
    `, [today]),

    pgPool.query('reservation', `
      SELECT type, title, message, timestamp
      FROM alerts
      WHERE resolved = 0
      ORDER BY timestamp DESC
      LIMIT 10
    `),
  ]);

  // 방별 예약 요약
  const roomMap = {};
  for (const r of reservations) {
    if (!roomMap[r.room]) roomMap[r.room] = 0;
    roomMap[r.room]++;
  }

  return {
    date:             today,
    reservations,
    summary:          summary || { total_amount: 0, entries_count: 0 },
    alerts,
    room_summary:     roomMap,
    total_reserved:   reservations.length,
    generated_at:     new Date().toISOString(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function isWebhookAuthorized(req) {
  if (!isLocalRequest(req)) return false;
  if (!WEBHOOK_SECRET) return true;
  return String(req.headers['x-ska-webhook-secret'] || '') === WEBHOOK_SECRET;
}

async function runWebhookCommand(payload = {}) {
  const command = String(payload.command || '');
  const args = payload.args || {};
  switch (command) {
    case 'query_reservations':
      return readService.queryReservations(args);
    case 'query_today_stats':
      return readService.queryTodayStats(args);
    case 'query_alerts':
      return readService.queryAlerts(args);
    default:
      return { ok: false, error: `지원하지 않는 명령: ${command}` };
  }
}

// ─── HTTP 서버 ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/api/today') {
    try {
      const data = await getTodayData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.method === 'POST' && req.url === '/api/webhooks/n8n/ska-command') {
    if (!isWebhookAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const result = await runWebhookCommand(payload);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...result, source: result.source || 'ska-webhook' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message, code: 'SKA_WEBHOOK_FAILED' }));
    }
  } else if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('dashboard.html 파일을 찾을 수 없습니다.');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[스카 대시보드] 서버 시작: http://localhost:${PORT}`);
  console.log(`  예약 현황 API: http://localhost:${PORT}/api/today`);
  console.log(`  n8n Webhook API: http://localhost:${PORT}/api/webhooks/n8n/ska-command`);
  console.log('  종료: Ctrl+C');
});

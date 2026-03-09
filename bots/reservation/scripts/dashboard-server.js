#!/usr/bin/env node
'use strict';

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

const args    = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const PORT    = portArg ? parseInt(portArg.split('=')[1]) : 3031;

const HTML_FILE = path.join(__dirname, 'dashboard.html');

// ─── 데이터 조회 ─────────────────────────────────────────────────────

async function getTodayData() {
  const today = new Date().toISOString().slice(0, 10);

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
  console.log('  종료: Ctrl+C');
});

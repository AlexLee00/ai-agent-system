'use strict';

/**
 * lib/daily-report.js — 덱스터 일일 보고
 *
 * 매일 1회 실행 (launchd: ai.claude.dexter.daily)
 * - 덱스터 당일 점검 이력 집계
 * - 루나팀 거래·포지션 현황 (PostgreSQL investment 스키마)
 * - 스카팀 예약 현황 (PostgreSQL reservation 스키마)
 * - 텔레그램 발송
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

// ── 팀 이름 (변경 시 이 상수만 수정)
const TEAM_SKA  = '스카팀';
const TEAM_LUNA = '루나팀';
const TEAM_CLAUDE = '클로드팀';

// ─── 날짜 유틸 ───────────────────────────────────────────────────────

function todayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

// ─── 덱스터 로그 집계 ────────────────────────────────────────────────

function parseDexterLog(today) {
  const result = { runs: 0, errors: 0, warns: 0, lastStatus: null };

  if (!fs.existsSync(cfg.LOGS.dexter)) return result;

  const lines = fs.readFileSync(cfg.LOGS.dexter, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    // [2026-03-01T...] WARN | ❌2 ⚠️3 | 2500ms
    if (!line.includes(today.slice(0, 10))) continue;

    result.runs++;
    const errMatch  = line.match(/❌(\d+)/);
    const warnMatch = line.match(/⚠️(\d+)/);
    if (errMatch)  result.errors  += Number(errMatch[1]);
    if (warnMatch) result.warns   += Number(warnMatch[1]);

    const statusMatch = line.match(/\] (OK|WARN|ERROR) \|/);
    if (statusMatch) result.lastStatus = statusMatch[1];
  }

  return result;
}

// ─── 자동 픽스 이력 ─────────────────────────────────────────────────

function getTodayFixes(today) {
  if (!fs.existsSync(cfg.LOGS.fixes)) return [];
  try {
    const history = JSON.parse(fs.readFileSync(cfg.LOGS.fixes, 'utf8'));
    return history.filter(e => e.ts && e.ts.startsWith(today));
  } catch {
    return [];
  }
}

// ─── 루나팀 PostgreSQL 현황 ─────────────────────────────────────────

async function getLunaSummary(today) {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  try {
    const [tradesRow, signalRows, posRow] = await Promise.all([
      pgPool.get('investment',
        `SELECT COUNT(*) AS cnt, SUM(CASE WHEN paper THEN 1 ELSE 0 END) AS paper_cnt
         FROM trades WHERE executed_at::date = $1`, [today]),
      pgPool.query('investment',
        `SELECT action, COUNT(*) AS cnt FROM signals WHERE created_at::date = $1 GROUP BY action`, [today]),
      pgPool.get('investment', `SELECT COUNT(*) AS cnt FROM positions WHERE amount > 0`),
    ]);
    return {
      trades:    Number(tradesRow?.cnt    ?? 0),
      dryRun:    (Number(tradesRow?.paper_cnt ?? 0) > 0) || Number(tradesRow?.cnt ?? 0) === 0,
      signals:   signalRows.map(r => ({ action: r.action, cnt: Number(r.cnt) })),
      positions: Number(posRow?.cnt ?? 0),
    };
  } catch {
    return null;
  }
}

// ─── 스카팀 PostgreSQL 현황 ──────────────────────────────────────────

async function getSkaSummary(today) {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  try {
    const [totalRow, completedRow, cancelledRow] = await Promise.all([
      pgPool.get('reservation', 'SELECT COUNT(*) AS cnt FROM reservations WHERE date = $1 AND seen_only = 0', [today]),
      pgPool.get('reservation', "SELECT COUNT(*) AS cnt FROM reservations WHERE date = $1 AND status = 'completed' AND seen_only = 0", [today]),
      pgPool.get('reservation', "SELECT COUNT(*) AS cnt FROM reservations WHERE date = $1 AND status = 'cancelled'", [today]),
    ]);
    return {
      total:     Number(totalRow?.cnt     ?? 0),
      confirmed: Number(completedRow?.cnt ?? 0),
      cancelled: Number(cancelledRow?.cnt ?? 0),
    };
  } catch {
    return null;
  }
}

// ─── 보고서 포맷 ─────────────────────────────────────────────────────

function buildReport(today, dexterLog, luna, ska, fixes) {
  const lines = [];
  const statusIcon = { OK: '✅', WARN: '⚠️', ERROR: '❌', null: '❓' };

  lines.push(`📊 *덱스터 일일 보고* — ${today}`);
  lines.push(`🕐 ${nowKST()} KST`);
  lines.push('');

  // ── 시스템 점검 이력
  lines.push('*📋 시스템 점검 이력*');
  if (dexterLog.runs === 0) {
    lines.push('  ❓ 오늘 점검 기록 없음');
  } else {
    const icon = statusIcon[dexterLog.lastStatus] ?? '❓';
    lines.push(`  ${icon} 점검 ${dexterLog.runs}회 실행`);
    if (dexterLog.errors > 0) lines.push(`  ❌ 오류 누적 ${dexterLog.errors}건`);
    if (dexterLog.warns  > 0) lines.push(`  ⚠️ 경고 누적 ${dexterLog.warns}건`);
    if (dexterLog.errors === 0 && dexterLog.warns === 0) lines.push('  ✅ 이상 없음');
  }
  lines.push('');

  // ── 루나팀 현황
  lines.push(`*🌙 ${TEAM_LUNA} 현황*`);
  if (!luna) {
    lines.push('  ❓ DB 미연결 (드라이런 대기 중)');
  } else {
    const modeTag = luna.dryRun ? ' _(드라이런)_' : '';
    lines.push(`  거래 실행: ${luna.trades}건${modeTag}`);
    lines.push(`  보유 포지션: ${luna.positions}개`);

    if (luna.signals && luna.signals.length > 0) {
      const sigMap = Object.fromEntries(luna.signals.map(s => [s.action, s.cnt]));
      const buy  = sigMap['BUY']  ?? 0;
      const sell = sigMap['SELL'] ?? 0;
      const hold = sigMap['HOLD'] ?? 0;
      lines.push(`  신호: BUY ${buy} / SELL ${sell} / HOLD ${hold}`);
    } else {
      lines.push('  신호: 없음');
    }
  }
  lines.push('');

  // ── 스카팀 현황
  lines.push(`*☕ ${TEAM_SKA} 현황*`);
  if (!ska) {
    lines.push('  ❓ DB 미연결');
  } else {
    lines.push(`  예약: 총 ${ska.total}건 (확정 ${ska.confirmed} / 취소 ${ska.cancelled})`);
  }
  lines.push('');

  // ── 자동 픽스 이력
  if (fixes && fixes.length > 0) {
    lines.push('*🔧 오늘 자동 처리 내역*');
    const okFixes   = fixes.filter(f => f.status === 'ok');
    const warnFixes = fixes.filter(f => f.status === 'warn');
    for (const f of okFixes)   lines.push(`  ✅ ${f.label}: ${f.detail}`);
    for (const f of warnFixes) lines.push(`  ⚠️ ${f.label}: ${f.detail}`);
    lines.push('');
  }

  lines.push('_자동 생성: 덱스터 (ai.claude.dexter.daily)_');
  return lines.join('\n');
}

// ─── 메인 ────────────────────────────────────────────────────────────

const { publishToMainBot } = require('./mainbot-client');

async function run({ telegram = false, print = true } = {}) {
  const today = todayKST();

  const dexterLog = parseDexterLog(today);
  const [luna, ska] = await Promise.all([getLunaSummary(today), getSkaSummary(today)]);
  const fixes     = getTodayFixes(today);

  const report = buildReport(today, dexterLog, luna, ska, fixes);

  if (print) console.log(report.replace(/\*/g, '').replace(/_/g, ''));

  if (telegram) {
    publishToMainBot({ from_bot: 'dexter', event_type: 'report', alert_level: 1, message: report });
    if (print) console.log('\n✅ 제이 큐 발행 완료');
  }

  return true;
}

module.exports = { run };

// @ts-nocheck
'use strict';
const kstUtil = require('../../../packages/core/lib/kst');

/**
 * lib/daily-report.js — 덱스터 일일 보고
 *
 * 매일 1회 실행 (launchd: ai.claude.dexter.daily)
 * - 덱스터 당일 점검 이력 집계
 * - 루나팀 거래·포지션 현황 (PostgreSQL investment 스키마)
 * - 스카팀 예약 현황 (PostgreSQL reservation 스키마)
 * - 텔레그램 발송
 */

const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');
const cfg            = require('./config');

// ── 팀 이름 (변경 시 이 상수만 수정)
const TEAM_SKA  = '스카팀';
const TEAM_LUNA = '루나팀';
const TEAM_CLAUDE = '클로드팀';

// ─── 날짜 유틸 ───────────────────────────────────────────────────────

function todayKST() {
  return kstUtil.today();
}

function nowKST() {
  return kstUtil.datetimeStr().slice(0, 16);
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

// ─── 서비스 가동률 ──────────────────────────────────────────────────

const KEY_SERVICES = [
  { label: 'ai.claude.dexter.quick',  name: '덱스터(퀵)' },
  { label: 'ai.investment.crypto',    name: '루나(크립토)' },
  { label: 'ai.ska.naver-monitor',    name: '앤디' },
  { label: 'ai.ska.commander',        name: '스카커맨더' },
  { label: 'ai.openclaw.gateway',     name: 'OpenClaw' },
  { label: 'ai.ska.rebecca',          name: '레베카' },
];

function _isServiceRunning(label) {
  try {
    const out = execSync(`launchctl list '${label}' 2>/dev/null`, {
      encoding: 'utf8', timeout: 3000,
    });
    // PID 존재 → 데몬 실행 중 / LastExitStatus=0 → 주기 작업 마지막 성공
    return out.includes('"PID"') || out.includes('"LastExitStatus" = 0');
  } catch {
    return false;
  }
}

function getServiceStatus() {
  return KEY_SERVICES.map(s => ({ ...s, running: _isServiceRunning(s.label) }));
}

// ─── LLM 비용 조회 ───────────────────────────────────────────────────

async function getLlmCostByProvider(today) {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  try {
    // provider 컬럼 또는 model prefix로 그룹핑 시도
    const rows = await pgPool.query('reservation', `
      SELECT
        COALESCE(provider,
          CASE
            WHEN model ILIKE 'groq%'    THEN 'Groq'
            WHEN model ILIKE 'gemini%'  THEN 'Gemini'
            WHEN model ILIKE 'claude%'  THEN 'Anthropic'
            WHEN model ILIKE 'gpt%'     THEN 'OpenAI'
            ELSE 'Other'
          END
        ) AS provider,
        COUNT(*) AS calls,
        COALESCE(SUM(cost_usd), 0) AS cost
      FROM llm_log
      WHERE created_at::date = $1
      GROUP BY 1
      ORDER BY cost DESC
    `, [today]);
    return rows || [];
  } catch {
    try {
      const row = await pgPool.get('reservation',
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_log WHERE created_at::date = $1`, [today]);
      return row ? [{ provider: '합계', calls: Number(row.calls), cost: Number(row.cost) }] : [];
    } catch {
      return [];
    }
  }
}

// ─── PostgreSQL 상태 ──────────────────────────────────────────────────

async function getPostgresStats() {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  try {
    const [connRow, sizeRow] = await Promise.all([
      pgPool.get('reservation',
        `SELECT COUNT(*) AS cnt FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'`),
      pgPool.get('reservation',
        `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`),
    ]);
    return {
      activeConnections: Number(connRow?.cnt ?? 0),
      dbSize: sizeRow?.db_size || 'N/A',
    };
  } catch {
    return null;
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

function buildReport(today, dexterLog, luna, ska, fixes, services, llmCost, pgStats) {
  const lines = [];
  const SEP   = '═'.repeat(19);

  lines.push(`📊 *클로드팀 일간 시스템 리포트*`);
  lines.push(`📅 ${today} ${nowKST().slice(-5)} KST`);
  lines.push(SEP);
  lines.push('');

  // ── 서비스 가동률
  if (services && services.length > 0) {
    const runCnt = services.filter(s => s.running).length;
    const pct    = Math.round(runCnt / services.length * 100);
    lines.push('*■ 서비스 가동률*');
    for (const s of services) {
      const icon = s.running ? '✅' : '❌';
      const pad  = ' '.repeat(Math.max(0, 22 - s.label.length));
      lines.push(`  ${s.label}${pad}${icon}`);
    }
    lines.push(`  가동률: ${pct}% (${runCnt}/${services.length})`);
    lines.push('');
  }

  // ── 24시간 이슈
  lines.push('*■ 24시간 이슈*');
  if (dexterLog.runs === 0) {
    lines.push('  ❓ 오늘 점검 기록 없음');
  } else {
    const issueCount = dexterLog.errors + dexterLog.warns;
    lines.push(`  감지: ${issueCount}건 (WARN ${dexterLog.warns} / CRITICAL ${dexterLog.errors})`);
    const okFixes = (fixes || []).filter(f => f.status === 'ok').length;
    if (dexterLog.errors > 0) {
      const recRate = dexterLog.errors > 0 ? Math.round(okFixes / dexterLog.errors * 100) : 100;
      lines.push(`  자동 복구: ${okFixes}/${dexterLog.errors} (${recRate}%) ${recRate === 100 ? '✅' : '⚠️'}`);
      lines.push(`  미복구: ${Math.max(0, dexterLog.errors - okFixes)}건`);
    } else {
      lines.push('  ✅ 이상 없음');
    }
  }
  lines.push('');

  // ── LLM 비용
  if (llmCost && llmCost.length > 0) {
    let totalCost = 0, totalCalls = 0;
    lines.push('*■ LLM 비용 (24시간)*');
    for (const r of llmCost) {
      const cost  = parseFloat(r.cost || 0);
      const calls = parseInt(r.calls || 0);
      totalCost  += cost; totalCalls += calls;
      lines.push(`  ${r.provider}: ${calls}회 ($${cost.toFixed(2)})`);
    }
    lines.push(`  합계: $${totalCost.toFixed(2)} (${totalCalls}회)`);
    lines.push('');
  }

  // ── PostgreSQL
  if (pgStats) {
    lines.push('*■ PostgreSQL*');
    lines.push(`  활성 커넥션: ${pgStats.activeConnections}개`);
    lines.push(`  DB 크기: ${pgStats.dbSize}`);
    lines.push('');
  }

  // ── 루나팀 현황
  lines.push(`*■ ${TEAM_LUNA}*`);
  if (!luna) {
    lines.push('  ❓ DB 미연결');
  } else {
    const modeTag = luna.dryRun ? ' _(드라이런)_' : '';
    lines.push(`  거래: ${luna.trades}건${modeTag}  포지션: ${luna.positions}개`);
    if (luna.signals && luna.signals.length > 0) {
      const sigMap = Object.fromEntries(luna.signals.map(s => [s.action, s.cnt]));
      lines.push(`  신호: BUY ${sigMap['BUY'] ?? 0} / SELL ${sigMap['SELL'] ?? 0} / HOLD ${sigMap['HOLD'] ?? 0}`);
    }
  }
  lines.push('');

  // ── 스카팀 현황
  lines.push(`*■ ${TEAM_SKA}*`);
  if (!ska) {
    lines.push('  ❓ DB 미연결');
  } else {
    lines.push(`  예약: 총 ${ska.total}건 (확정 ${ska.confirmed} / 취소 ${ska.cancelled})`);
  }
  lines.push('');

  // ── 자동 픽스 이력
  if (fixes && fixes.length > 0) {
    lines.push('*■ 자동 처리 내역*');
    for (const f of fixes.filter(x => x.status === 'ok'))   lines.push(`  ✅ ${f.label}: ${f.detail}`);
    for (const f of fixes.filter(x => x.status === 'warn'))  lines.push(`  ⚠️ ${f.label}: ${f.detail}`);
    lines.push('');
  }

  lines.push(SEP);
  lines.push('_자동 생성: 덱스터 (ai.claude.dexter.daily)_');
  return lines.join('\n');
}

// ─── 메인 ────────────────────────────────────────────────────────────

const { publishToMainBot } = require('./mainbot-client');

async function run({ telegram = false, print = true } = {}) {
  const today = todayKST();

  const dexterLog  = parseDexterLog(today);
  const services   = getServiceStatus();
  const [luna, ska, llmCost, pgStats] = await Promise.all([
    getLunaSummary(today),
    getSkaSummary(today),
    getLlmCostByProvider(today),
    getPostgresStats(),
  ]);
  const fixes = getTodayFixes(today);

  const report = buildReport(today, dexterLog, luna, ska, fixes, services, llmCost, pgStats);

  if (print) console.log(report.replace(/\*/g, '').replace(/_/g, ''));

  if (telegram) {
    publishToMainBot({ from_bot: 'dexter', event_type: 'report', alert_level: 1, message: report });
    if (print) console.log('\n✅ 제이 큐 발행 완료');
  }

  return true;
}

module.exports = { run };

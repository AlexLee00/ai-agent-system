'use strict';

/**
 * lib/daily-report.js — 덱스터 일일 보고
 *
 * 매일 1회 실행 (launchd: ai.claude.dexter.daily)
 * - 덱스터 당일 점검 이력 집계
 * - 루나팀 드라이런 거래·포지션 현황 (DuckDB)
 * - 스카팀 예약 현황 (SQLite)
 * - 텔레그램 발송
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cfg  = require('./config');
const { execSync } = require('child_process');

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

// ─── DB 쿼리 공통 ────────────────────────────────────────────────────

function resolveModule(botPath, moduleName) {
  const local = path.join(botPath, 'node_modules', moduleName);
  const root  = path.join(cfg.ROOT, 'node_modules', moduleName);
  return fs.existsSync(local) ? local : root;
}

function runScript(script) {
  const tmp = path.join(os.tmpdir(), `dexter-daily-${Date.now()}.js`);
  try {
    fs.writeFileSync(tmp, script);
    const out = execSync(`node "${tmp}"`, { timeout: 10000, encoding: 'utf8' });
    return JSON.parse(out.trim() || 'null');
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
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

// ─── 루나팀 DuckDB 현황 ─────────────────────────────────────────────

function getLunaSummary(today) {
  const duckdbPath = resolveModule(cfg.BOTS.invest, 'duckdb');
  if (!fs.existsSync(duckdbPath) || !fs.existsSync(cfg.DBS.invest)) {
    return null;
  }

  const script = `
'use strict';
const duckdb = require(${JSON.stringify(duckdbPath)});
const db = new duckdb.Database(${JSON.stringify(cfg.DBS.invest)});
const conn = db.connect();

const today = ${JSON.stringify(today)};

// 오늘 거래 수 + 드라이런 여부
conn.all(
  "SELECT CAST(COUNT(*) AS INTEGER) as cnt, CAST(SUM(CASE WHEN dry_run THEN 1 ELSE 0 END) AS INTEGER) as dry_cnt FROM trades WHERE DATE(executed_at) = ?",
  [today],
  (err, trades) => {
    if (err) { process.stdout.write(JSON.stringify(null)); conn.close(); db.close(); return; }

    // 오늘 신호 수
    conn.all(
      "SELECT CAST(COUNT(*) AS INTEGER) as cnt, action FROM signals WHERE DATE(created_at) = ? GROUP BY action",
      [today],
      (err2, signals) => {
        if (err2) { process.stdout.write(JSON.stringify(null)); conn.close(); db.close(); return; }

        // 현재 포지션 수
        conn.all(
          "SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM positions WHERE amount > 0",
          [],
          (err3, pos) => {
            const result = {
              trades: trades[0]?.cnt ?? 0,
              dryRun: (trades[0]?.dry_cnt ?? 0) > 0 || trades[0]?.cnt === 0,
              signals: signals,
              positions: pos?.[0]?.cnt ?? 0,
            };
            process.stdout.write(JSON.stringify(result));
            conn.close(); db.close();
          }
        );
      }
    );
  }
);
`;

  return runScript(script);
}

// ─── 스카팀 SQLite 현황 ──────────────────────────────────────────────

function getSkaSummary(today) {
  const sqlitePath = resolveModule(cfg.BOTS.reservation, 'better-sqlite3');
  if (!fs.existsSync(sqlitePath) || !fs.existsSync(cfg.DBS.reservation)) {
    return null;
  }

  const script = `
'use strict';
const Database = require(${JSON.stringify(sqlitePath)});
const db = new Database(${JSON.stringify(cfg.DBS.reservation)}, { readonly: true });
const today = ${JSON.stringify(today)};

try {
  const reservations = db.prepare(
    "SELECT COUNT(*) AS cnt FROM reservations WHERE date = ?"
  ).get(today);

  const confirmed = db.prepare(
    "SELECT COUNT(*) AS cnt FROM reservations WHERE date = ? AND confirmed = 1"
  ).get(today);

  const cancelled = db.prepare(
    "SELECT COUNT(*) AS cnt FROM reservations WHERE date = ? AND status = 'cancelled'"
  ).get(today);

  process.stdout.write(JSON.stringify({
    total:     reservations?.cnt ?? 0,
    confirmed: confirmed?.cnt ?? 0,
    cancelled: cancelled?.cnt ?? 0,
  }));
} catch (e) {
  process.stdout.write(JSON.stringify(null));
} finally {
  db.close();
}
`;

  return runScript(script);
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

// ─── 텔레그램 발송 ────────────────────────────────────────────────────

function loadTelegramCreds() {
  for (const p of Object.values(cfg.SECRETS)) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.telegram_bot_token && s.telegram_chat_id) {
        return { token: s.telegram_bot_token, chatId: s.telegram_chat_id };
      }
    } catch { /* try next */ }
  }
  return null;
}

function sendTelegram(text) {
  const https = require('https');
  const creds = loadTelegramCreds();
  if (!creds) return Promise.resolve(false);

  const body = Buffer.from(JSON.stringify({
    chat_id:    creds.chatId,
    text,
    parse_mode: 'Markdown',
  }));

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${creds.token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => { res.resume(); res.on('end', () => resolve(true)); });

    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── 메인 ────────────────────────────────────────────────────────────

async function run({ telegram = false, print = true } = {}) {
  const today = todayKST();

  const dexterLog = parseDexterLog(today);
  const luna      = getLunaSummary(today);
  const ska       = getSkaSummary(today);
  const fixes     = getTodayFixes(today);

  const report = buildReport(today, dexterLog, luna, ska, fixes);

  if (print) console.log(report.replace(/\*/g, '').replace(/_/g, ''));

  if (telegram) {
    const sent = await sendTelegram(report);
    if (print) console.log(sent ? '\n✅ 텔레그램 발송 완료' : '\n⚠️ 텔레그램 발송 실패');
    return sent;
  }

  return true;
}

module.exports = { run };

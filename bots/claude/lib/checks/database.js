'use strict';

/**
 * checks/database.js — DB 무결성 체크
 * - 스카팀 SQLite: 테이블 존재, row count, 파싱 테스트
 * - 루나팀 DuckDB: 테이블 존재, 스키마 버전, 데이터 파싱 테스트
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cfg  = require('../config');
const { execSync } = require('child_process');

// node_modules 경로 해석 (로컬 우선 → 루트 폴백)
function resolveModule(botPath, moduleName) {
  const local = path.join(botPath, 'node_modules', moduleName);
  const root  = path.join(cfg.ROOT, 'node_modules', moduleName);
  return fs.existsSync(local) ? local : root;
}

// 임시 스크립트 파일로 실행 (node -e 이스케이프 문제 회피)
function runScript(script) {
  const tmp = path.join(os.tmpdir(), `dexter-db-${Date.now()}.js`);
  try {
    fs.writeFileSync(tmp, script);
    const out = execSync(`node "${tmp}"`, { timeout: 10000, encoding: 'utf8' });
    return JSON.parse(out.trim());
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// SQLite 쿼리 (better-sqlite3 활용)
function sqliteQuery(sql) {
  const modulePath = resolveModule(cfg.BOTS.reservation, 'better-sqlite3');
  const script = `
'use strict';
const Database = require(${JSON.stringify(modulePath)});
const db = new Database(${JSON.stringify(cfg.DBS.reservation)}, { readonly: true });
const rows = db.prepare(${JSON.stringify(sql)}).all();
process.stdout.write(JSON.stringify(rows));
db.close();
`;
  try {
    return runScript(script);
  } catch (e) {
    throw new Error(e.message.slice(0, 200));
  }
}

// DuckDB 쿼리
function duckdbQuery(sql) {
  const modulePath = resolveModule(cfg.BOTS.investment, 'duckdb');
  const script = `
'use strict';
const duckdb = require(${JSON.stringify(modulePath)});
const db = new duckdb.Database(${JSON.stringify(cfg.DBS.investment)}, { access_mode: 'READ_ONLY' });
const conn = db.connect();
conn.all(${JSON.stringify(sql)}, (err, rows) => {
  if (err) { process.stderr.write(JSON.stringify({ error: err.message })); process.exit(1); }
  process.stdout.write(JSON.stringify(rows));
  conn.close(); db.close();
});
`;
  try {
    return runScript(script);
  } catch (e) {
    throw new Error(e.message.slice(0, 200));
  }
}

async function checkSQLite(items) {
  // node_modules 존재 여부 — 봇 로컬 또는 루트 워크스페이스
  const sqliteLocal = `${cfg.BOTS.reservation}/node_modules/better-sqlite3`;
  const sqliteRoot  = `${cfg.ROOT}/node_modules/better-sqlite3`;
  if (!fs.existsSync(sqliteLocal) && !fs.existsSync(sqliteRoot)) {
    items.push({ label: 'SQLite (스카)', status: 'warn', detail: 'better-sqlite3 모듈 미설치' });
    return;
  }

  // DB 파일 존재
  if (!fs.existsSync(cfg.DBS.reservation)) {
    items.push({ label: 'SQLite (스카)', status: 'warn', detail: 'DB 파일 없음' });
    return;
  }

  const REQUIRED = ['reservations', 'kiosk_blocks', 'daily_summary'];

  try {
    const tables = sqliteQuery("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
    const missing = REQUIRED.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      items.push({ label: 'SQLite 테이블', status: 'error', detail: `누락: ${missing.join(', ')}` });
    } else {
      items.push({ label: 'SQLite 테이블', status: 'ok', detail: `${tables.length}개 확인 (${REQUIRED.join(', ')})` });
    }

    // row count 체크
    for (const t of REQUIRED) {
      if (tables.includes(t)) {
        const rows = sqliteQuery(`SELECT COUNT(*) AS cnt FROM ${t}`);
        const cnt  = rows[0]?.cnt ?? 0;
        items.push({ label: `  ${t}`, status: 'ok', detail: `${cnt}행` });
      }
    }

    // 데이터 파싱 테스트 (최근 1건 SELECT)
    try {
      sqliteQuery('SELECT * FROM reservations ORDER BY rowid DESC LIMIT 1');
      items.push({ label: 'SQLite 파싱', status: 'ok', detail: 'SELECT/파싱 정상' });
    } catch (e) {
      items.push({ label: 'SQLite 파싱', status: 'error', detail: e.message });
    }

  } catch (e) {
    items.push({ label: 'SQLite (스카)', status: 'error', detail: e.message });
  }
}

async function checkDuckDB(items) {
  // node_modules 존재 여부 — 봇 로컬 또는 루트 워크스페이스
  const duckdbLocal = `${cfg.BOTS.investment}/node_modules/duckdb`;
  const duckdbRoot  = `${cfg.ROOT}/node_modules/duckdb`;
  if (!fs.existsSync(duckdbLocal) && !fs.existsSync(duckdbRoot)) {
    items.push({ label: 'DuckDB (루나)', status: 'warn', detail: 'duckdb 모듈 미설치 (npm install 필요)' });
    return;
  }

  // DB 파일 존재
  if (!fs.existsSync(cfg.DBS.investment)) {
    items.push({ label: 'DuckDB (루나)', status: 'warn', detail: 'DB 파일 없음 (setup-db.js 실행 필요)' });
    return;
  }

  const REQUIRED = ['analysis', 'signals', 'trades', 'positions', 'schema_migrations'];

  try {
    const tableRows = duckdbQuery("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
    const tables    = tableRows.map(r => r.table_name);
    const missing   = REQUIRED.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      items.push({ label: 'DuckDB 테이블', status: 'error', detail: `누락: ${missing.join(', ')}` });
    } else {
      items.push({ label: 'DuckDB 테이블', status: 'ok', detail: `${tables.length}개 확인` });
    }

    // 스키마 버전 (BigInt 방지: CAST)
    try {
      const ver = duckdbQuery('SELECT CAST(MAX(version) AS INTEGER) as v FROM schema_migrations');
      items.push({ label: 'DuckDB 스키마', status: 'ok', detail: `v${ver[0]?.v ?? 0}` });
    } catch {
      items.push({ label: 'DuckDB 스키마', status: 'warn', detail: 'schema_migrations 조회 실패' });
    }

    // row count (BigInt 방지: CAST)
    for (const t of ['trades', 'positions', 'signals']) {
      if (tables.includes(t)) {
        const rows = duckdbQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM ${t}`);
        items.push({ label: `  ${t}`, status: 'ok', detail: `${rows[0]?.cnt ?? 0}행` });
      }
    }

    // 포지션 무결성 (음수 수량 체크, BigInt 방지: CAST)
    if (tables.includes('positions')) {
      const neg = duckdbQuery('SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM positions WHERE amount < 0');
      const cnt = neg[0]?.cnt ?? 0;
      items.push({
        label:  'DuckDB 포지션 무결성',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0 ? `음수 수량 포지션 ${cnt}건` : '정상',
      });
    }

  } catch (e) {
    items.push({ label: 'DuckDB (루나)', status: 'error', detail: e.message });
  }
}

// claude-team.db 큐 건강 체크
function checkMainbotQueue(items) {
  const dbPath = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
  if (!fs.existsSync(dbPath)) {
    items.push({ label: 'mainbot_queue (제이)', status: 'warn', detail: 'claude-team.db 없음' });
    return;
  }

  const modulePath = resolveModule(cfg.BOTS.reservation, 'better-sqlite3');
  const script = `
'use strict';
const Database = require(${JSON.stringify(modulePath)});
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
if (!tables.includes('mainbot_queue')) { process.stdout.write(JSON.stringify({ noTable: true })); db.close(); process.exit(0); }

// pending 장기 적체 (5분 이상)
const stuckPending = db.prepare("SELECT COUNT(*) as cnt FROM mainbot_queue WHERE status='pending' AND created_at < datetime('now','-5 minutes')").get().cnt;
// batched 장기 적체 (3분 이상 — 배치 타이머 1분 + 여유)
const stuckBatched = db.prepare("SELECT COUNT(*) as cnt FROM mainbot_queue WHERE status='batched' AND processed_at < datetime('now','-3 minutes')").get().cnt;
// 최근 1분 내 같은 봇 알람 폭탄 (10개 초과)
const floodRows = db.prepare("SELECT from_bot, COUNT(*) as cnt FROM mainbot_queue WHERE created_at > datetime('now','-1 minutes') GROUP BY from_bot HAVING cnt > 10").all();
// 전체 현황
const summary = db.prepare("SELECT status, COUNT(*) as cnt FROM mainbot_queue GROUP BY status").all();

process.stdout.write(JSON.stringify({ stuckPending, stuckBatched, floodRows, summary }));
db.close();
`;

  try {
    const result = runScript(script);
    if (result.noTable) {
      items.push({ label: 'mainbot_queue', status: 'warn', detail: '테이블 없음 (마이그레이션 필요)' });
      return;
    }

    // 현황 요약
    const statusMap = {};
    for (const r of (result.summary || [])) statusMap[r.status] = r.cnt;
    const summaryStr = Object.entries(statusMap).map(([s, c]) => `${s}:${c}`).join(', ') || '빈 큐';
    items.push({ label: 'mainbot_queue 현황', status: 'ok', detail: summaryStr });

    // 알람 폭탄 감지
    for (const row of (result.floodRows || [])) {
      items.push({ label: `  알람폭탄 [${row.from_bot}]`, status: 'warn', detail: `1분 내 ${row.cnt}건 (10건 초과)` });
    }

    // pending 장기 적체
    if (result.stuckPending > 0) {
      items.push({ label: '  pending 장기 적체', status: 'error', detail: `5분 이상 미처리 ${result.stuckPending}건 — 메인봇 확인 필요` });
    }

    // batched 장기 적체
    if (result.stuckBatched > 0) {
      items.push({ label: '  batched 장기 적체', status: 'warn', detail: `3분 이상 ${result.stuckBatched}건 — 배치 타이머 이상` });
    }

  } catch (e) {
    items.push({ label: 'mainbot_queue', status: 'warn', detail: e.message.slice(0, 100) });
  }
}

async function run() {
  const items = [];

  await checkSQLite(items);
  await checkDuckDB(items);
  checkMainbotQueue(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'DB 무결성',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

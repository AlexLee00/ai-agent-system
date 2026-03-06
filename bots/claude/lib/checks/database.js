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
const pgPool = require('../../../../packages/core/lib/pg-pool');

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
    const out = execSync(`"${process.execPath}" "${tmp}"`, { timeout: 10000, encoding: 'utf8' });
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

    // 신호 exchange 불일치 체크 (예: BTC/USDT가 exchange='kis'로 저장된 경우)
    // - 암호화폐 심볼(/ 포함) → exchange='binance' 이어야 함
    // - KIS 국내 심볼(6자리 숫자) → exchange='kis' 이어야 함
    if (tables.includes('signals')) {
      try {
        const mismatchCrypto = duckdbQuery(
          "SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM signals WHERE symbol LIKE '%/%' AND exchange != 'binance' AND status NOT IN ('executed','failed','cancelled')"
        );
        const mismatchKis = duckdbQuery(
          "SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM signals WHERE regexp_matches(symbol, '^\\d{6}$') AND exchange != 'kis' AND status NOT IN ('executed','failed','cancelled')"
        );
        const staleSignals = duckdbQuery(
          "SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM signals WHERE status IN ('pending','approved') AND created_at < NOW() - INTERVAL 2 HOUR"
        );

        const mc = mismatchCrypto[0]?.cnt ?? 0;
        const mk = mismatchKis[0]?.cnt ?? 0;
        const ss = staleSignals[0]?.cnt ?? 0;

        if (mc > 0 || mk > 0) {
          const details = [];
          if (mc > 0) details.push(`암호화폐→KIS 오분류 ${mc}건`);
          if (mk > 0) details.push(`KIS→바이낸스 오분류 ${mk}건`);
          items.push({ label: 'DuckDB 신호 exchange 불일치', status: 'error', detail: details.join(', ') });
        } else {
          items.push({ label: 'DuckDB 신호 exchange 불일치', status: 'ok', detail: '정상' });
        }

        if (ss > 0) {
          items.push({ label: 'DuckDB 미처리 신호 (2h+)', status: 'warn', detail: `${ss}건 장기 미실행 (approved/pending)` });
        }
      } catch (e) {
        items.push({ label: 'DuckDB 신호 무결성', status: 'warn', detail: `조회 실패: ${e.message.slice(0, 80)}` });
      }
    }

  } catch (e) {
    items.push({ label: 'DuckDB (루나)', status: 'error', detail: e.message });
  }
}

// mainbot_queue 큐 건강 체크 (PostgreSQL claude 스키마)
async function checkMainbotQueue(items) {
  try {
    // pending 장기 적체 (5분 이상)
    const stuckPendingRow = await pgPool.get('claude', `
      SELECT COUNT(*) AS cnt FROM mainbot_queue
      WHERE status='pending' AND created_at < to_char(now() - INTERVAL '5 minutes', 'YYYY-MM-DD HH24:MI:SS')
    `);
    const stuckPending = Number(stuckPendingRow?.cnt ?? 0);

    // batched 장기 적체 (3분 이상)
    const stuckBatchedRow = await pgPool.get('claude', `
      SELECT COUNT(*) AS cnt FROM mainbot_queue
      WHERE status='batched' AND processed_at < to_char(now() - INTERVAL '3 minutes', 'YYYY-MM-DD HH24:MI:SS')
    `);
    const stuckBatched = Number(stuckBatchedRow?.cnt ?? 0);

    // 최근 1분 내 같은 봇 알람 폭탄 (10개 초과)
    const floodRows = await pgPool.query('claude', `
      SELECT from_bot, COUNT(*) AS cnt FROM mainbot_queue
      WHERE created_at > to_char(now() - INTERVAL '1 minutes', 'YYYY-MM-DD HH24:MI:SS')
      GROUP BY from_bot HAVING COUNT(*) > 10
    `);

    // 전체 현황
    const summary = await pgPool.query('claude', `
      SELECT status, COUNT(*) AS cnt FROM mainbot_queue GROUP BY status
    `);

    // 현황 요약
    const statusMap = {};
    for (const r of summary) statusMap[r.status] = Number(r.cnt);
    const summaryStr = Object.entries(statusMap).map(([s, c]) => `${s}:${c}`).join(', ') || '빈 큐';
    items.push({ label: 'mainbot_queue 현황', status: 'ok', detail: summaryStr });

    // 알람 폭탄 감지
    for (const row of floodRows) {
      items.push({ label: `  알람폭탄 [${row.from_bot}]`, status: 'warn', detail: `1분 내 ${Number(row.cnt)}건 (10건 초과)` });
    }

    // pending 장기 적체
    if (stuckPending > 0) {
      items.push({ label: '  pending 장기 적체', status: 'error', detail: `5분 이상 미처리 ${stuckPending}건 — 메인봇 확인 필요` });
    }

    // batched 장기 적체
    if (stuckBatched > 0) {
      items.push({ label: '  batched 장기 적체', status: 'warn', detail: `3분 이상 ${stuckBatched}건 — 배치 타이머 이상` });
    }

  } catch (e) {
    items.push({ label: 'mainbot_queue', status: 'warn', detail: e.message.slice(0, 100) });
  }
}

// ska DuckDB 쿼리 (Python venv duckdb 활용)
function skaDuckdbQuery(sql) {
  const dbPath = cfg.DBS.ska;
  const script = `
import duckdb, json, sys
try:
    db = duckdb.connect('${dbPath}', read_only=True)
    rows = db.execute(${JSON.stringify(sql)}).fetchall()
    cols = [d[0] for d in db.execute(${JSON.stringify(sql)}).description] if rows else []
    # description from execute
    conn2 = db.execute(${JSON.stringify(sql)})
    cols = [d[0] for d in conn2.description]
    result = [dict(zip(cols, row)) for row in rows]
    print(json.dumps(result))
    db.close()
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
`;
  const { execSync: _exec } = require('child_process');
  const tmp = path.join(os.tmpdir(), `dexter-ska-duck-${Date.now()}.py`);
  try {
    fs.writeFileSync(tmp, script);
    // ska venv python 우선, 없으면 시스템 python3
    const skaPython = path.join(cfg.BOTS.ska, 'venv', 'bin', 'python');
    const pythonBin = fs.existsSync(skaPython) ? skaPython : 'python3';
    const out = _exec(`${pythonBin} "${tmp}"`, { timeout: 10000, encoding: 'utf8' });
    const result = JSON.parse(out.trim());
    if (result?.error) throw new Error(result.error);
    return result;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function checkSkaDuckDB(items) {
  if (!fs.existsSync(cfg.DBS.ska)) {
    items.push({ label: 'DuckDB (스카)', status: 'warn', detail: 'ska.duckdb 파일 없음 (ETL 미실행)' });
    return;
  }

  const REQUIRED = ['revenue_daily', 'environment_factors', 'forecast_accuracy'];

  try {
    const tableRows = skaDuckdbQuery("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
    const tables    = tableRows.map(r => r.table_name);
    const missing   = REQUIRED.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      items.push({ label: 'DuckDB 테이블 (스카)', status: 'warn', detail: `누락: ${missing.join(', ')} (ETL 필요)` });
    } else {
      items.push({ label: 'DuckDB 테이블 (스카)', status: 'ok', detail: `${tables.length}개 확인` });
    }

    // ETL 최신 데이터 확인 (revenue_daily 마지막 날짜)
    if (tables.includes('revenue_daily')) {
      try {
        const lastRow = skaDuckdbQuery("SELECT MAX(date) as last_date FROM revenue_daily");
        const lastDate = lastRow[0]?.last_date;
        if (lastDate) {
          const daysDiff = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
          const detail   = `최신: ${lastDate} (${daysDiff}일 전)`;
          items.push({
            label:  'ETL 최신성 (revenue_daily)',
            status: daysDiff > 2 ? 'warn' : 'ok',
            detail: daysDiff > 2 ? `${detail} — ETL 미실행 의심` : detail,
          });
        }
      } catch { /* 쿼리 실패는 무시 */ }
    }

    // MAPE 경보 (forecast_accuracy 최근 7일 평균)
    if (tables.includes('forecast_accuracy')) {
      try {
        const mapeRow = skaDuckdbQuery(
          "SELECT AVG(mape) as avg_mape FROM forecast_accuracy WHERE forecast_date >= current_date - INTERVAL '7 days'"
        );
        const mape = mapeRow[0]?.avg_mape;
        if (mape !== null && mape !== undefined) {
          const mapeVal = Math.round(mape * 10) / 10;
          items.push({
            label:  'MAPE 예측 정확도 (7일)',
            status: mapeVal > 15 ? 'warn' : 'ok',
            detail: mapeVal > 15 ? `MAPE ${mapeVal}% (15% 초과 — 모델 재학습 필요)` : `MAPE ${mapeVal}%`,
          });
        } else {
          items.push({ label: 'MAPE 예측 정확도 (7일)', status: 'ok', detail: '데이터 없음 (예측 미실행)' });
        }
      } catch { /* 쿼리 실패는 무시 */ }
    }

  } catch (e) {
    items.push({ label: 'DuckDB (스카)', status: 'warn', detail: e.message.slice(0, 150) });
  }
}

async function run() {
  const items = [];

  await checkSQLite(items);
  await checkSkaDuckDB(items);
  await checkDuckDB(items);
  await checkMainbotQueue(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'DB 무결성',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

'use strict';

/**
 * checks/database.js — DB 무결성 체크
 * - 스카팀: PostgreSQL reservation 스키마 (연결, 테이블, 파싱)
 * - 루나팀: PostgreSQL investment 스키마 (연결, 테이블, 신호 무결성)
 * - 스카 분석: DuckDB ska 스키마 (ETL 최신성, MAPE) — Phase 5에서 PostgreSQL 전환 예정
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cfg  = require('../config');
const pgPool = require('../../../../packages/core/lib/pg-pool');


async function checkReservationPostgres(items) {
  const REQUIRED = ['reservations', 'kiosk_blocks', 'daily_summary'];

  // DB 연결 확인
  try {
    const ok = await pgPool.ping('reservation');
    if (!ok) {
      items.push({ label: 'PostgreSQL (스카 reservation)', status: 'error', detail: 'ping 실패' });
      return;
    }
    items.push({ label: 'PostgreSQL (스카 reservation)', status: 'ok', detail: 'reservation 스키마 연결 정상' });
  } catch (e) {
    items.push({ label: 'PostgreSQL (스카 reservation)', status: 'error', detail: `연결 실패: ${e.message.slice(0, 100)}` });
    return;
  }

  // row count 체크
  for (const t of REQUIRED) {
    try {
      const row = await pgPool.get('reservation', `SELECT COUNT(*) AS cnt FROM ${t}`);
      const cnt = Number(row?.cnt ?? 0);
      items.push({ label: `  ${t}`, status: 'ok', detail: `${cnt}행` });
    } catch (e) {
      items.push({ label: `  ${t}`, status: 'error', detail: `조회 실패: ${e.message.slice(0, 100)}` });
    }
  }

  // 데이터 파싱 테스트 (최근 1건 SELECT)
  try {
    await pgPool.get('reservation', 'SELECT * FROM reservations ORDER BY updated_at DESC LIMIT 1');
    items.push({ label: 'reservation 파싱', status: 'ok', detail: 'SELECT/파싱 정상' });
  } catch (e) {
    items.push({ label: 'reservation 파싱', status: 'error', detail: e.message.slice(0, 100) });
  }
}

async function checkInvestmentPostgres(items) {
  const REQUIRED = ['analysis', 'signals', 'trades', 'positions', 'schema_migrations', 'trade_journal', 'trade_review'];

  // DB 연결 확인
  try {
    const ok = await pgPool.ping('investment');
    if (!ok) {
      items.push({ label: 'PostgreSQL (루나 investment)', status: 'error', detail: 'ping 실패' });
      return;
    }
    items.push({ label: 'PostgreSQL (루나 investment)', status: 'ok', detail: 'investment 스키마 연결 정상' });
  } catch (e) {
    items.push({ label: 'PostgreSQL (루나 investment)', status: 'error', detail: `연결 실패: ${e.message.slice(0, 100)}` });
    return;
  }

  // 테이블 존재 확인
  try {
    const tableRows = await pgPool.query('investment',
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'investment'");
    const tables  = tableRows.map(r => r.table_name);
    const missing = REQUIRED.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      items.push({ label: 'investment 테이블', status: 'error', detail: `누락: ${missing.join(', ')}` });
    } else {
      items.push({ label: 'investment 테이블', status: 'ok', detail: `${tables.length}개 확인` });
    }

    // 스키마 버전
    try {
      const ver = await pgPool.get('investment', 'SELECT MAX(version) AS v FROM schema_migrations');
      items.push({ label: 'investment 스키마', status: 'ok', detail: `v${ver?.v ?? 0}` });
    } catch {
      items.push({ label: 'investment 스키마', status: 'warn', detail: 'schema_migrations 조회 실패' });
    }

    // row count
    for (const t of ['trades', 'positions', 'signals']) {
      if (tables.includes(t)) {
        const row = await pgPool.get('investment', `SELECT COUNT(*) AS cnt FROM ${t}`);
        items.push({ label: `  ${t}`, status: 'ok', detail: `${Number(row?.cnt ?? 0)}행` });
      }
    }

    // 포지션 무결성 (음수 수량 체크)
    if (tables.includes('positions')) {
      const neg = await pgPool.get('investment', 'SELECT COUNT(*) AS cnt FROM positions WHERE amount < 0');
      const cnt = Number(neg?.cnt ?? 0);
      items.push({
        label:  'investment 포지션 무결성',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0 ? `음수 수량 포지션 ${cnt}건` : '정상',
      });
    }

    // 신호 exchange 불일치 체크
    if (tables.includes('signals')) {
      try {
        const [mismatchCrypto, mismatchKis, staleSignals] = await Promise.all([
          pgPool.get('investment',
            "SELECT COUNT(*) AS cnt FROM signals WHERE symbol LIKE '%/%' AND exchange != 'binance' AND status NOT IN ('executed','failed','cancelled')"),
          pgPool.get('investment',
            "SELECT COUNT(*) AS cnt FROM signals WHERE symbol ~ '^[0-9]{6}$' AND exchange != 'kis' AND status NOT IN ('executed','failed','cancelled')"),
          pgPool.get('investment',
            "SELECT COUNT(*) AS cnt FROM signals WHERE status IN ('pending','approved') AND created_at < now() - INTERVAL '2 hours'"),
        ]);

        const mc = Number(mismatchCrypto?.cnt ?? 0);
        const mk = Number(mismatchKis?.cnt    ?? 0);
        const ss = Number(staleSignals?.cnt   ?? 0);

        if (mc > 0 || mk > 0) {
          const details = [];
          if (mc > 0) details.push(`암호화폐→KIS 오분류 ${mc}건`);
          if (mk > 0) details.push(`KIS→바이낸스 오분류 ${mk}건`);
          items.push({ label: 'investment 신호 exchange 불일치', status: 'error', detail: details.join(', ') });
        } else {
          items.push({ label: 'investment 신호 exchange 불일치', status: 'ok', detail: '정상' });
        }

        if (ss > 0) {
          items.push({ label: 'investment 미처리 신호 (2h+)', status: 'warn', detail: `${ss}건 장기 미실행 (approved/pending)` });
        } else {
          items.push({ label: 'investment 미처리 신호 (2h+)', status: 'ok', detail: '장기 미처리 approved/pending 신호 없음' });
        }
      } catch (e) {
        items.push({ label: 'investment 신호 무결성', status: 'warn', detail: `조회 실패: ${e.message.slice(0, 80)}` });
      }
    }

    if (tables.includes('trade_journal')) {
      try {
        const [closedTrades, missingReview, badPercentScale, badPercentMismatch, missingExcursions] = await Promise.all([
          pgPool.get('investment',
            "SELECT COUNT(*) AS cnt FROM trade_journal WHERE status = 'closed' AND exit_time IS NOT NULL"),
          tables.includes('trade_review')
            ? pgPool.get('investment', `
                SELECT COUNT(*) AS cnt
                FROM trade_journal j
                LEFT JOIN trade_review r ON r.trade_id = j.trade_id
                WHERE j.status = 'closed'
                  AND j.exit_time IS NOT NULL
                  AND r.trade_id IS NULL
              `)
            : Promise.resolve({ cnt: 0 }),
          pgPool.get('investment', `
            SELECT COUNT(*) AS cnt
            FROM trade_journal
            WHERE status = 'closed'
              AND exit_time IS NOT NULL
              AND pnl_percent IS NOT NULL
              AND entry_value > 0
              AND pnl_amount IS NOT NULL
              AND ABS(pnl_percent - ROUND((pnl_amount / entry_value)::numeric, 6)) <= 0.0005
          `),
          pgPool.get('investment', `
            SELECT COUNT(*) AS cnt
            FROM trade_journal
            WHERE status = 'closed'
              AND exit_time IS NOT NULL
              AND pnl_percent IS NOT NULL
              AND entry_value > 0
              AND pnl_amount IS NOT NULL
              AND ABS(pnl_percent - ROUND(((pnl_amount / entry_value) * 100)::numeric, 4)) > 0.02
          `),
          tables.includes('trade_review')
            ? pgPool.get('investment', `
                SELECT COUNT(*) AS cnt
                FROM trade_journal j
                JOIN trade_review r ON r.trade_id = j.trade_id
                WHERE j.status = 'closed'
                  AND j.exit_time IS NOT NULL
                  AND (r.max_favorable IS NULL OR r.max_adverse IS NULL)
              `)
            : Promise.resolve({ cnt: 0 }),
        ]);

        const totalClosed = Number(closedTrades?.cnt ?? 0);
        const missingReviewCnt = Number(missingReview?.cnt ?? 0);
        const badScaleCnt = Number(badPercentScale?.cnt ?? 0);
        const badMismatchCnt = Number(badPercentMismatch?.cnt ?? 0);
        const missingExcursionCnt = Number(missingExcursions?.cnt ?? 0);

        if (totalClosed === 0) {
          items.push({ label: 'investment trade_review 무결성', status: 'ok', detail: '종료 거래 없음' });
        } else if (missingReviewCnt > 0 || badScaleCnt > 0 || badMismatchCnt > 0 || missingExcursionCnt > 0) {
          const detail = [];
          if (missingReviewCnt > 0) detail.push(`리뷰 누락 ${missingReviewCnt}건`);
          if (missingExcursionCnt > 0) detail.push(`excursion 누락 ${missingExcursionCnt}건`);
          if (badScaleCnt > 0) detail.push(`pnl_percent 스케일 이상 ${badScaleCnt}건`);
          if (badMismatchCnt > 0) detail.push(`pnl_percent 불일치 ${badMismatchCnt}건`);
          items.push({ label: 'investment trade_review 무결성', status: 'warn', detail: detail.join(', ') });
        } else {
          items.push({ label: 'investment trade_review 무결성', status: 'ok', detail: `종료 거래 ${totalClosed}건 정상` });
        }
      } catch (e) {
        items.push({ label: 'investment trade_review 무결성', status: 'warn', detail: `조회 실패: ${e.message.slice(0, 80)}` });
      }
    }

  } catch (e) {
    items.push({ label: 'PostgreSQL (루나 investment)', status: 'error', detail: e.message.slice(0, 150) });
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

  const REQUIRED = ['revenue_daily', 'environment_factors'];

  try {
    const tableRows = skaDuckdbQuery("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
    const tables    = tableRows.map(r => r.table_name);
    const missing   = REQUIRED.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      items.push({ label: 'DuckDB 테이블 (스카)', status: 'warn', detail: `누락: ${missing.join(', ')} (ETL 필요)` });
    } else {
      items.push({ label: 'DuckDB 테이블 (스카)', status: 'ok', detail: `${tables.length}개 확인` });
    }

    if (!tables.includes('forecast_results')) {
      items.push({
        label: '예측 테이블 (스카)',
        status: 'ok',
        detail: 'forecast_results 없음 (예측 엔진 미구축 또는 미실행)',
      });
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

    // MAPE 경보 (forecast_results + revenue_daily 기준 최근 7일 실제 오차)
    if (tables.includes('forecast_results') && tables.includes('revenue_daily')) {
      try {
        const mapeRow = skaDuckdbQuery(
          `WITH latest AS (
             SELECT forecast_date, predictions, ROW_NUMBER() OVER (
               PARTITION BY forecast_date ORDER BY created_at DESC
             ) AS rn
             FROM forecast_results
             WHERE forecast_date >= current_date - INTERVAL '7 days'
           )
           SELECT AVG(
             ABS(
               (CAST(json_extract_string(latest.predictions, '$.yhat') AS DOUBLE) - revenue_daily.actual_revenue)
               / NULLIF(revenue_daily.actual_revenue, 0)
             ) * 100
           ) AS avg_mape
           FROM latest
           JOIN revenue_daily ON revenue_daily.date = latest.forecast_date
           WHERE latest.rn = 1
             AND revenue_daily.actual_revenue > 0`
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

// 커넥션 풀 상태 체크
async function checkPoolStatus(items) {
  try {
    const { stats, issues } = pgPool.checkPoolHealth(0.8);

    if (issues.length > 0) {
      for (const i of issues) {
        items.push({ label: `DB 풀 [${i.schema}]`, status: i.status === 'warning' ? 'warn' : i.status, detail: i.detail });
      }
    }

    if (stats.length > 0) {
      const summary = stats.map(s => `${s.schema}: ${s.active}/${s.total}`).join(', ');
      items.push({ label: 'DB 커넥션 풀', status: issues.length > 0 ? 'warn' : 'ok', detail: summary });
    }
  } catch (e) {
    items.push({ label: 'DB 커넥션 풀', status: 'warn', detail: e.message.slice(0, 60) });
  }
}

async function run() {
  const items = [];

  await checkReservationPostgres(items);
  await checkSkaDuckDB(items);
  await checkInvestmentPostgres(items);
  await checkMainbotQueue(items);
  await checkPoolStatus(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'DB 무결성',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };

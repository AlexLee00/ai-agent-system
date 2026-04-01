'use strict';

/**
 * scripts/collect-kpi.js — 팀별 KPI 일간 수집 + 주간 리포트
 *
 * 사용법:
 *   node scripts/collect-kpi.js              # 오늘 KPI 수집
 *   node scripts/collect-kpi.js --weekly     # 주간 리포트 생성 + 텔레그램
 *   node scripts/collect-kpi.js --report     # 주간 리포트만 콘솔 출력
 */

const path     = require('path');
const ROOT     = path.join(__dirname, '..');
const pgPool   = require(path.join(ROOT, 'packages/core/lib/pg-pool'));
const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));

const SCHEMA = 'reservation';

// ── 스카팀 KPI ────────────────────────────────────────────────────────
async function collectSkaKPI(date) {
  const [rev, err, sync] = await Promise.all([
    pgPool.get(SCHEMA,
      `SELECT
         /* 스카 KPI의 daily_revenue는 내부 운영 총합이다.
            - general_revenue     = payment_day|general
            - pickko_study_room   = use_day|study_room
            두 축을 운영 총매출 관점에서 합산해 본다. */
         COALESCE(SUM(COALESCE(general_revenue, 0) + COALESCE(pickko_study_room, 0)),0)::bigint AS total,
         COALESCE(SUM(entries_count),0)::int AS cnt
       FROM reservation.daily_summary WHERE date = $1`, [date]),
    pgPool.get(SCHEMA,
      `SELECT COUNT(*)::int AS cnt FROM reservation.agent_events
       WHERE type='error' AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
    pgPool.get(SCHEMA,
      `SELECT COUNT(*)::int AS total,
              COUNT(CASE WHEN type='naver_sync_ok' THEN 1 END)::int AS ok
       FROM reservation.agent_events
       WHERE type IN ('naver_sync_ok','naver_sync_fail')
         AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
  ]);

  const syncTotal = sync?.total || 0;
  const syncOk    = sync?.ok    || 0;
  return {
    daily_revenue:  Number(rev?.total  || 0),
    reservation_cnt: Number(rev?.cnt   || 0),
    error_count:    Number(err?.cnt    || 0),
    naver_sync_rate: syncTotal > 0 ? Math.round(syncOk * 100 / syncTotal) : null,
  };
}

// ── 루나팀 KPI ────────────────────────────────────────────────────────
async function collectLunaKPI(date) {
  const [trades7d, todayTrades] = await Promise.all([
    pgPool.query(SCHEMA,
      `SELECT metadata FROM reservation.rag_trades
       WHERE source_bot IN ('hephaestos','luna','nemesis')
         AND created_at >= NOW() - interval '7 days'`),
    pgPool.query(SCHEMA,
      `SELECT metadata FROM reservation.rag_trades
       WHERE source_bot IN ('hephaestos','luna','nemesis')
         AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
  ]);

  // 주간 승률
  const weeklyTrades = trades7d.filter(r => r.metadata?.outcome);
  const weekWins  = weeklyTrades.filter(r => r.metadata.outcome === 'profit').length;
  const weekTotal = weeklyTrades.length;

  // 일간 PnL 합산
  const dailyPnl = todayTrades.reduce((sum, r) => {
    const pct = Number(r.metadata?.pnl_percent || 0);
    return sum + pct;
  }, 0);

  // 서킷 브레이커 (agent_events에서 circuit_breaker 타입)
  const [cb] = await Promise.all([
    pgPool.get(SCHEMA,
      `SELECT COUNT(*)::int AS cnt FROM reservation.agent_events
       WHERE type='circuit_breaker'
         AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
  ]);

  return {
    daily_pnl_pct:       Math.round(dailyPnl * 100) / 100,
    weekly_win_rate:     weekTotal > 0 ? Math.round(weekWins * 100 / weekTotal) : null,
    weekly_trades:       weekTotal,
    weekly_wins:         weekWins,
    circuit_breaker_cnt: Number(cb?.cnt || 0),
  };
}

// ── 클로드팀 KPI ──────────────────────────────────────────────────────
async function collectClaudeKPI(date) {
  const [issues, recovered, emergency] = await Promise.all([
    pgPool.get(SCHEMA,
      `SELECT COUNT(*)::int AS cnt FROM reservation.agent_events
       WHERE source='dexter'
         AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
    pgPool.get(SCHEMA,
      `SELECT
         COUNT(*)::int AS total,
         COUNT(CASE WHEN status='completed' THEN 1 END)::int AS done
       FROM reservation.agent_tasks
       WHERE created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
    pgPool.get(SCHEMA,
      `SELECT COUNT(*)::int AS cnt FROM reservation.agent_events
       WHERE type='emergency_mode'
         AND created_at >= $1::date AND created_at < $1::date + interval '1 day'`, [date]),
  ]);

  const total = Number(recovered?.total || 0);
  const done  = Number(recovered?.done  || 0);
  return {
    issues_detected:      Number(issues?.cnt || 0),
    recovery_total:       total,
    recovery_success:     done,
    recovery_rate:        total > 0 ? Math.round(done * 100 / total) : null,
    emergency_mode_cnt:   Number(emergency?.cnt || 0),
  };
}

// ── KPI 수집 메인 ─────────────────────────────────────────────────────
async function collectDailyKPI(date) {
  date = date || new Date().toISOString().split('T')[0];
  console.log(`[KPI] ${date} 수집 중...`);

  const [ska, luna, claude] = await Promise.all([
    collectSkaKPI(date).catch(e => { console.warn('[KPI] 스카팀 오류:', e.message); return {}; }),
    collectLunaKPI(date).catch(e => { console.warn('[KPI] 루나팀 오류:', e.message); return {}; }),
    collectClaudeKPI(date).catch(e => { console.warn('[KPI] 클로드팀 오류:', e.message); return {}; }),
  ]);

  const kpi = { date, ska, luna, claude };

  await pgPool.run(SCHEMA,
    `INSERT INTO reservation.kpi_daily (date, data)
     VALUES ($1, $2)
     ON CONFLICT (date) DO UPDATE SET data = $2, created_at = NOW()`,
    [date, JSON.stringify(kpi)]
  );

  console.log(`[KPI] ${date} 저장 완료`);
  return kpi;
}

// ── 주간 리포트 ───────────────────────────────────────────────────────
async function weeklyReport() {
  // 최근 7일 + 이전 7일 데이터
  const rows = await pgPool.query(SCHEMA,
    `SELECT date, data FROM reservation.kpi_daily
     WHERE date >= TO_CHAR(CURRENT_DATE - 13, 'YYYY-MM-DD')
     ORDER BY date DESC`
  );

  const thisWeek = rows.slice(0, 7);
  const lastWeek = rows.slice(7, 14);

  const sum = (arr, key) => arr.reduce((s, r) => s + (Number(r.data?.[key] || 0)), 0);
  const avg = (arr, key) => arr.length ? Math.round(sum(arr, key) / arr.length * 10) / 10 : null;

  // 스카팀 집계
  const skaRevThis  = thisWeek.reduce((s, r) => s + Number(r.data?.ska?.daily_revenue || 0), 0);
  const skaRevLast  = lastWeek.reduce((s, r) => s + Number(r.data?.ska?.daily_revenue || 0), 0);
  const skaErrThis  = thisWeek.reduce((s, r) => s + Number(r.data?.ska?.error_count   || 0), 0);
  const skaErrLast  = lastWeek.reduce((s, r) => s + Number(r.data?.ska?.error_count   || 0), 0);
  const revChg  = skaRevLast > 0 ? ((skaRevThis - skaRevLast) / skaRevLast * 100).toFixed(1) : null;
  const errChg  = skaErrLast > 0 ? ((skaErrThis - skaErrLast) / skaErrLast * 100).toFixed(1) : null;

  // 루나팀 집계
  const lunaWR   = thisWeek[0]?.data?.luna?.weekly_win_rate ?? null;
  const lunaTrades = thisWeek[0]?.data?.luna?.weekly_trades ?? 0;
  const lunaWins   = thisWeek[0]?.data?.luna?.weekly_wins   ?? 0;
  const lunaCB     = thisWeek.reduce((s, r) => s + Number(r.data?.luna?.circuit_breaker_cnt || 0), 0);

  // 클로드팀 집계
  const claudeIssues  = thisWeek.reduce((s, r) => s + Number(r.data?.claude?.issues_detected   || 0), 0);
  const claudeTotal   = thisWeek.reduce((s, r) => s + Number(r.data?.claude?.recovery_total    || 0), 0);
  const claudeDone    = thisWeek.reduce((s, r) => s + Number(r.data?.claude?.recovery_success  || 0), 0);
  const claudeRR      = claudeTotal > 0 ? Math.round(claudeDone * 100 / claudeTotal) : null;
  const claudeEM      = thisWeek.reduce((s, r) => s + Number(r.data?.claude?.emergency_mode_cnt || 0), 0);

  const fmt = n => n?.toLocaleString('ko-KR') ?? '-';
  const chg = v => v === null ? '' : (v >= 0 ? ` (+${v}%)` : ` (${v}%)`);

  const msg = [
    `📊 주간 KPI 리포트`,
    `═══════════════════`,
    ``,
    `🏢 스카팀:`,
    `  매출: ${fmt(skaRevThis)}원${chg(revChg)}`,
    `  에러: ${skaErrThis}건${chg(errChg)}`,
    ``,
    `💰 루나팀:`,
    `  승률: ${lunaWR !== null ? `${lunaWR}% (${lunaWins}/${lunaTrades})` : '-'}`,
    `  서킷 브레이커: ${lunaCB}회${lunaCB === 0 ? ' ✅' : ' ⚠️'}`,
    ``,
    `🔧 클로드팀:`,
    `  이슈 감지: ${claudeIssues}건`,
    `  자동 복구: ${claudeDone}/${claudeTotal}${claudeRR !== null ? ` (${claudeRR}%)` : ''}`,
    `  Emergency 발동: ${claudeEM}회${claudeEM === 0 ? ' ✅' : ' ⚠️'}`,
  ].join('\n');

  return msg;
}

// ── CLI 진입점 ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--weekly')) {
      const today = new Date().toISOString().split('T')[0];
      await collectDailyKPI(today);
      const report = await weeklyReport();
      console.log(report);
      await openclawClient.postAlarm({
        team: 'general',
        message: report,
        alertLevel: 1,
        fromBot: 'collect-kpi',
      });
      console.log('[KPI] 텔레그램 발송 완료');
    } else if (args.includes('--report')) {
      const report = await weeklyReport();
      console.log(report);
    } else {
      const today = new Date().toISOString().split('T')[0];
      const kpi = await collectDailyKPI(today);
      console.log('[KPI] 결과:', JSON.stringify(kpi, null, 2));
    }
  } catch (e) {
    console.error('[KPI] 오류:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

main();

module.exports = { collectDailyKPI, weeklyReport };

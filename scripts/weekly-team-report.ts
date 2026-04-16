// @ts-nocheck
'use strict';

/**
 * scripts/weekly-team-report.js — 4개 팀 KPI 주간 종합 리포트
 *
 * 매주 일요일 09:00 실행 (launchd 또는 n8n)
 * 스카팀 / 루나팀 / 클로드팀 / 워커팀 핵심 지표 수집 → 텔레그램 발송 + RAG 저장
 *
 * 실행: node scripts/weekly-team-report.js [--days=7]
 */

const pgPool = require('../packages/core/lib/pg-pool');
const rag    = require('../packages/core/lib/rag');
const openclawClient = require('../packages/core/lib/openclaw-client');

const args    = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS    = daysArg ? parseInt(daysArg.split('=')[1]) : 7;

// ─── 팀별 KPI 수집 ─────────────────────────────────────────────────

async function collectSkaKPI() {
  try {
    const [resRow, alertRow] = await Promise.all([
      pgPool.get('reservation', `
        SELECT
          COUNT(*)                                   AS total_reservations,
          COUNT(*) FILTER (WHERE source = 'naver')  AS naver_count,
          COUNT(*) FILTER (WHERE status = 'cancelled') AS cancel_count,
          COALESCE(SUM(amount), 0)                   AS total_revenue
        FROM reservations
        WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      `),
      pgPool.get('reservation', `
        SELECT
          COUNT(*)                                        AS cnt,
          COUNT(*) FILTER (WHERE resolved = true)         AS resolved
        FROM alerts
        WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      `),
    ]);

    return {
      team:            '스카팀',
      reservations:    parseInt(resRow?.total_reservations || 0),
      naver_sync:      parseInt(resRow?.naver_count        || 0),
      cancellations:   parseInt(resRow?.cancel_count       || 0),
      revenue:         parseInt(resRow?.total_revenue      || 0),
      alerts:          parseInt(alertRow?.cnt              || 0),
      alerts_resolved: parseInt(alertRow?.resolved         || 0),
    };
  } catch (e) {
    return { team: '스카팀', error: e.message.slice(0, 80) };
  }
}

async function collectLunaKPI() {
  try {
    const row = await pgPool.get('investment', `
      SELECT
        COUNT(*)                                    AS total_trades,
        COUNT(*) FILTER (WHERE pnl_percent > 0)     AS wins,
        ROUND(AVG(pnl_percent)::numeric, 4)         AS avg_pnl,
        ROUND(SUM(pnl_usdt)::numeric, 2)            AS total_pnl_usdt
      FROM trades
      WHERE status = 'closed'
        AND created_at > NOW() - INTERVAL '${DAYS} days'
    `);
    const total = parseInt(row?.total_trades || 0);
    const wins  = parseInt(row?.wins         || 0);

    return {
      team:            '루나팀',
      trades:          total,
      wins,
      win_rate:        total > 0 ? (wins / total * 100).toFixed(1) + '%' : 'N/A',
      avg_pnl:         row?.avg_pnl         ?? 'N/A',
      total_pnl_usdt:  row?.total_pnl_usdt  ?? 0,
    };
  } catch (e) {
    return { team: '루나팀', error: e.message.slice(0, 80) };
  }
}

async function collectClaudeKPI() {
  try {
    const [evRow, fixRow] = await Promise.all([
      pgPool.get('reservation', `
        SELECT
          COUNT(*) AS total_events,
          COUNT(*) FILTER (WHERE event_type LIKE '%critical%') AS critical,
          COUNT(*) FILTER (WHERE event_type LIKE '%error%')    AS errors
        FROM agent_events
        WHERE from_agent = 'dexter'
          AND created_at > NOW() - INTERVAL '${DAYS} days'
      `),
      pgPool.get('reservation', `
        SELECT
          COUNT(*)                               AS total,
          COUNT(*) FILTER (WHERE success = true) AS ok
        FROM doctor_log
        WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      `),
    ]);

    return {
      team:           '클로드팀',
      dexter_events:  parseInt(evRow?.total_events || 0),
      critical:       parseInt(evRow?.critical     || 0),
      errors:         parseInt(evRow?.errors       || 0),
      doctor_fixes:   parseInt(fixRow?.total       || 0),
      doctor_success: parseInt(fixRow?.ok          || 0),
    };
  } catch (e) {
    return { team: '클로드팀', error: e.message.slice(0, 80) };
  }
}

async function collectWorkerKPI() {
  try {
    const [userRow, logRow] = await Promise.all([
      pgPool.get('worker', `
        SELECT
          COUNT(DISTINCT company_id) AS active_companies,
          COUNT(*)                   AS total_users
        FROM users
        WHERE is_active = true
      `),
      pgPool.get('worker', `
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      `),
    ]);

    return {
      team:             '워커팀',
      active_companies: parseInt(userRow?.active_companies || 0),
      total_users:      parseInt(userRow?.total_users      || 0),
      audit_events:     parseInt(logRow?.cnt               || 0),
    };
  } catch (e) {
    return { team: '워커팀', error: e.message.slice(0, 80) };
  }
}

async function collectLLMCost() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT
        model,
        COUNT(*)                      AS calls,
        ROUND(SUM(cost_usd)::numeric, 4) AS cost
      FROM llm_logs
      WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      GROUP BY model
      ORDER BY cost DESC
      LIMIT 10
    `);
    const total = rows.reduce((s, r) => s + parseFloat(r.cost || 0), 0);
    return {
      total_cost:  total.toFixed(4),
      by_model:    rows.map(r => `${r.model}: $${r.cost} (${r.calls}건)`),
      budget_pct:  (total / 120 * 100).toFixed(1),  // $120/월 예산 대비
    };
  } catch {
    return { total_cost: 'N/A', by_model: [], budget_pct: 'N/A' };
  }
}

// ─── 리포트 조립 ────────────────────────────────────────────────────

function buildReport(ska, luna, claude, worker, llm) {
  const lines = [
    `📋 주간 종합 리포트 (최근 ${DAYS}일)`,
    `📅 ${new Date().toLocaleDateString('ko-KR')} 기준`,
    '',
    `📊 스카팀 예약관리`,
    ska.error
      ? `  ⚠️ ${ska.error}`
      : `  예약 ${ska.reservations}건 | 매출 ${(ska.revenue || 0).toLocaleString('ko-KR')}원\n  알람 ${ska.alerts}건 (해결 ${ska.alerts_resolved}) | 취소 ${ska.cancellations}건`,
    '',
    `💰 루나팀 자동매매`,
    luna.error
      ? `  ⚠️ ${luna.error}`
      : `  매매 ${luna.trades}건 | 승률 ${luna.win_rate} | PnL ${luna.total_pnl_usdt} USDT`,
    '',
    `🔧 클로드팀 시스템`,
    claude.error
      ? `  ⚠️ ${claude.error}`
      : `  덱스터 이벤트 ${claude.dexter_events}건 (🔴${claude.critical} ⚠️${claude.errors})\n  독터 복구 ${claude.doctor_fixes}건 (성공 ${claude.doctor_success})`,
    '',
    `🏢 워커팀 HR`,
    worker.error
      ? `  ⚠️ ${worker.error}`
      : `  업체 ${worker.active_companies}개 | 사용자 ${worker.total_users}명 | 감사로그 ${worker.audit_events}건`,
    '',
    `💳 LLM 비용: $${llm.total_cost} (예산 ${llm.budget_pct}%)`,
    ...(llm.by_model || []).map(m => `  ${m}`),
  ];
  return lines.join('\n');
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  console.log(`=== 주간 종합 리포트 (최근 ${DAYS}일) ===\n`);

  const [ska, luna, claude, worker, llm] = await Promise.all([
    collectSkaKPI(),
    collectLunaKPI(),
    collectClaudeKPI(),
    collectWorkerKPI(),
    collectLLMCost(),
  ]);

  // 콘솔 출력
  console.log('📊 스카팀:',   JSON.stringify(ska));
  console.log('💰 루나팀:',   JSON.stringify(luna));
  console.log('🔧 클로드팀:', JSON.stringify(claude));
  console.log('🏢 워커팀:',   JSON.stringify(worker));
  console.log('💳 LLM 비용:', JSON.stringify(llm));

  const report = buildReport(ska, luna, claude, worker, llm);
  console.log('\n--- 텔레그램 리포트 ---');
  console.log(report);

  // 텔레그램 발송
  try {
    const sent = await openclawClient.postAlarm({
      team: 'claude-lead',
      message: report,
      alertLevel: 1,
      fromBot: 'weekly-team-report',
    });
    if (!sent?.ok) throw new Error(sent?.error || `status_${sent?.status || 'unknown'}`);
    console.log('\n✅ OpenClaw 발송 완료');
  } catch (e) {
    console.warn('\n⚠️ OpenClaw 발송 실패:', e.message);
  }

  // RAG 저장
  try {
    await rag.initSchema();
    await rag.store('operations', `[주간 종합 리포트 ${new Date().toISOString().slice(0, 10)}]\n${report.slice(0, 600)}`, {
      type:       'weekly_team_report',
      ska:        ska.error ? null : ska,
      luna:       luna.error ? null : luna,
      claude:     claude.error ? null : claude,
      worker:     worker.error ? null : worker,
      llm_cost:   llm.total_cost,
      days:       DAYS,
    }, 'orchestrator');
    console.log('✅ RAG 저장 완료');
  } catch (e) {
    console.warn('⚠️ RAG 저장 실패:', e.message);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('❌ 리포트 생성 실패:', e.message);
  process.exit(1);
});

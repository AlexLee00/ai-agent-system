// @ts-nocheck
'use strict';

/**
 * scripts/weekly-team-report.js — 현역 팀 KPI 주간 종합 리포트
 *
 * 매주 일요일 09:00 실행 (launchd 또는 n8n)
 * 스카팀 / 루나팀 / 클로드팀 / 블로팀 핵심 지표 수집 → 텔레그램 발송 + RAG 저장
 *
 * 실행: node scripts/weekly-team-report.js [--days=7]
 */

const pgPool = require('../packages/core/lib/pg-pool');
const rag    = require('../packages/core/lib/rag');
const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');

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

async function collectBlogKPI() {
  try {
    const [postRow, instaRow] = await Promise.all([
      pgPool.get('blog', `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('ready', 'published')) AS ready_or_published,
          COUNT(*) FILTER (WHERE status = 'draft') AS drafts,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${DAYS} days') AS created_recent
        FROM posts
      `),
      pgPool.get('blog', `
        SELECT
          COUNT(*) FILTER (WHERE status = 'ok') AS insta_ok,
          COUNT(*) FILTER (WHERE status = 'failed') AS insta_failed
        FROM instagram_crosspost
        WHERE created_at > NOW() - INTERVAL '${DAYS} days'
      `),
    ]);

    return {
      team:               '블로팀',
      ready_or_published: parseInt(postRow?.ready_or_published || 0),
      drafts:             parseInt(postRow?.drafts || 0),
      created_recent:     parseInt(postRow?.created_recent || 0),
      insta_ok:           parseInt(instaRow?.insta_ok || 0),
      insta_failed:       parseInt(instaRow?.insta_failed || 0),
    };
  } catch (e) {
    return { team: '블로팀', error: e.message.slice(0, 80) };
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

function buildReport(ska, luna, claude, blog, llm) {
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
    `✍️ 블로팀 콘텐츠`,
    blog.error
      ? `  ⚠️ ${blog.error}`
      : `  작성 ${blog.created_recent}건 | 발행대기/완료 ${blog.ready_or_published}건 | 초안 ${blog.drafts}건\n  인스타 OK ${blog.insta_ok}건 | 실패 ${blog.insta_failed}건`,
    '',
    `💳 LLM 비용: $${llm.total_cost} (예산 ${llm.budget_pct}%)`,
    ...(llm.by_model || []).map(m => `  ${m}`),
  ];
  return lines.join('\n');
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  console.log(`=== 주간 종합 리포트 (최근 ${DAYS}일) ===\n`);

  const [ska, luna, claude, blog, llm] = await Promise.all([
    collectSkaKPI(),
    collectLunaKPI(),
    collectClaudeKPI(),
    collectBlogKPI(),
    collectLLMCost(),
  ]);

  // 콘솔 출력
  console.log('📊 스카팀:',   JSON.stringify(ska));
  console.log('💰 루나팀:',   JSON.stringify(luna));
  console.log('🔧 클로드팀:', JSON.stringify(claude));
  console.log('✍️ 블로팀:',   JSON.stringify(blog));
  console.log('💳 LLM 비용:', JSON.stringify(llm));

  const report = buildReport(ska, luna, claude, blog, llm);
  console.log('\n--- 텔레그램 리포트 ---');
  console.log(report);

  // 텔레그램 발송
  try {
    const sent = await hubAlarmClient.postAlarm({
      team: 'claude-lead',
      message: report,
      alertLevel: 1,
      fromBot: 'weekly-team-report',
    });
    if (!sent?.ok) throw new Error(sent?.error || `status_${sent?.status || 'unknown'}`);
    console.log('\n✅ Hub alarm 발송 완료');
  } catch (e) {
    console.warn('\n⚠️ Hub alarm 발송 실패:', e.message);
  }

  // RAG 저장
  try {
    await rag.initSchema();
    await rag.store('operations', `[주간 종합 리포트 ${new Date().toISOString().slice(0, 10)}]\n${report.slice(0, 600)}`, {
      type:       'weekly_team_report',
      ska:        ska.error ? null : ska,
      luna:       luna.error ? null : luna,
      claude:     claude.error ? null : claude,
      blog:       blog.error ? null : blog,
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

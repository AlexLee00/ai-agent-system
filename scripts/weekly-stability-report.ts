// @ts-nocheck
'use strict';

/**
 * scripts/weekly-stability-report.js — 5주차 주간 종합 리포트
 *
 * 일요일 자동 실행 → 📌 총괄 Topic에 발송
 * launchd 등록: scripts/launchd/com.jay.weekly-report.plist
 *
 * 사용법:
 *   node scripts/weekly-stability-report.js            # 콘솔 출력
 *   node scripts/weekly-stability-report.js --telegram # 텔레그램 발송
 */

const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const openclawClient = require(path.join(ROOT, 'packages/core/lib/openclaw-client'));
const shadow = require(path.join(ROOT, 'packages/core/lib/shadow-mode'));
const logger = require(path.join(ROOT, 'packages/core/lib/llm-logger'));
const cache  = require(path.join(ROOT, 'packages/core/lib/llm-cache'));
const grad   = require(path.join(ROOT, 'packages/core/lib/llm-graduation'));
const pgPool = require(path.join(ROOT, 'packages/core/lib/pg-pool'));
const { collectStabilityMetrics, buildDailyStabilityReport } = require('./stability-dashboard');

const SEND_TG = process.argv.includes('--telegram');

// ── 루나 전환 기준 ────────────────────────────────────────────────
const LUNA_READY_THRESHOLD  = 90;
const LUNA_TUNING_THRESHOLD = 80;

// ════════════════════════════════════════════════════════════════════
// 주간 데이터 수집 (7일)
// ════════════════════════════════════════════════════════════════════

async function collectWeeklyMetrics() {
  const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
  const DAYS  = 7;

  // ── Shadow 일치율 (7일) ──────────────────────────────────────────
  const shadowRates = {};
  for (const team of ['ska', 'luna', 'claude-lead']) {
    try {
      shadowRates[team] = await shadow.getMatchRate(team, null, DAYS);
    } catch {
      shadowRates[team] = { total: 0, matched: 0, matchRate: null, llmErrors: 0 };
    }
  }

  // ── LLM 비용 (7일 합산) ──────────────────────────────────────────
  let weeklyLlmCost = 0;
  let weeklyLlmCalls = 0;
  try {
    for (let i = 0; i < DAYS; i++) {
      const d   = new Date(Date.now() + (9 - i*24)*3600*1000).toISOString().slice(0,10);
      const day = await logger.getDailyCost(null, d);
      weeklyLlmCost  += day?.totalCost  ?? 0;
      weeklyLlmCalls += day?.totalCalls ?? 0;
    }
  } catch {}

  // ── 캐시 히트율 (7일) ────────────────────────────────────────────
  let cacheStats = { hitRate: null };
  try { cacheStats = await cache.getCacheStats(DAYS) ?? cacheStats; } catch {}

  // ── LLM 졸업 후보 ────────────────────────────────────────────────
  let graduationCandidates = [];
  let graduationReport = '';
  let graduationReverted = [];
  try {
    for (const team of ['ska', 'claude-lead', 'luna']) {
      const c = await grad.findGraduationCandidates(team, 20, 0.90);
      graduationCandidates = graduationCandidates.concat(c || []);
      // 졸업 규칙 주간 검증 — 불일치 20%+ 시 자동 복귀
      const reverted = await grad.weeklyValidation(team);
      graduationReverted = graduationReverted.concat(reverted || []);
    }
    graduationReport = await grad.buildGraduationReport('all') ?? '';
  } catch {}

  // ── 루나팀 거래 현황 (7일) ───────────────────────────────────────
  let lunaTradeCount = 0;
  let lunaTradeSuccess = 0;
  try {
    const rows = await pgPool.query('investment', `
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'closed') AS closed
      FROM trades
      WHERE created_at > to_char(now() - INTERVAL '7 days', 'YYYY-MM-DD HH24:MI:SS')
    `);
    lunaTradeCount   = Number(rows[0]?.total ?? 0);
    lunaTradeSuccess = Number(rows[0]?.closed ?? 0);
  } catch {}

  // ── 스카팀 예약 (7일) ────────────────────────────────────────────
  let skaWeeklyReservations = 0;
  try {
    const rows = await pgPool.query('reservation', `
      SELECT COUNT(*) AS cnt FROM reservations
      WHERE created_at > to_char(now() - INTERVAL '7 days', 'YYYY-MM-DD HH24:MI:SS')
    `);
    skaWeeklyReservations = Number(rows[0]?.cnt ?? 0);
  } catch {}

  // ── 크래시 횟수 (7일) ────────────────────────────────────────────
  let crashCount = 0;
  try {
    const rows = await pgPool.query('claude', `
      SELECT COUNT(*) AS cnt FROM mainbot_queue
      WHERE status = 'error'
        AND created_at > to_char(now() - INTERVAL '7 days', 'YYYY-MM-DD HH24:MI:SS')
    `);
    crashCount = Number(rows[0]?.cnt ?? 0);
  } catch {}

  // ── 루나 전환 판단 ────────────────────────────────────────────────
  const lunaRate = shadowRates['luna']?.matchRate;
  const lunaTransition =
    lunaRate === null        ? 'DATA_INSUFFICIENT'
    : lunaRate >= LUNA_READY_THRESHOLD  ? 'READY'
    : lunaRate >= LUNA_TUNING_THRESHOLD ? 'TUNING'
    : 'HOLD';

  // ── 맥미니 이관 체크리스트 진행률 ────────────────────────────────
  const migrationChecklist = {
    phase_a: { name: '기본 세팅', done: 0, total: 6 },
    phase_b: { name: '시스템 복제', done: 0, total: 6 },
    phase_c: { name: '병렬 운영 검증', done: 0, total: 4 },
    phase_d: { name: '전환', done: 0, total: 5 },
  };
  const migrationTotal = Object.values(migrationChecklist).reduce((s, p) => s + p.total, 0);
  const migrationDone  = Object.values(migrationChecklist).reduce((s, p) => s + p.done, 0);

  return {
    week_end: today,
    days: DAYS,
    ska: {
      weekly_reservations: skaWeeklyReservations,
      shadow: shadowRates['ska'],
    },
    luna: {
      trade_count: lunaTradeCount,
      trade_success: lunaTradeSuccess,
      shadow: shadowRates['luna'],
      transition: lunaTransition,
    },
    claude: {
      shadow: shadowRates['claude-lead'],
    },
    system: {
      weekly_llm_cost:  weeklyLlmCost,
      weekly_llm_calls: weeklyLlmCalls,
      weekly_budget_ratio: Math.min(100, weeklyLlmCost / 10 * 100),
      cache_hit_rate: cacheStats.hitRate ?? null,
      graduation_candidates: graduationCandidates.length,
      graduation_report: graduationReport,
      graduation_reverted: graduationReverted,
      crash_count: crashCount,
    },
    migration: {
      checklist: migrationChecklist,
      done: migrationDone,
      total: migrationTotal,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 주간 리포트 텍스트 빌드
// ════════════════════════════════════════════════════════════════════

function fmtRate(r) {
  return r !== null && r !== undefined ? `${r}%` : 'N/A';
}

function goalIcon(value, goal, invert = false) {
  if (value === null || value === undefined) return '❓';
  return (invert ? value <= goal : value >= goal) ? '✅' : '⚠️';
}

function buildWeeklyReport(m) {
  const s = m.system;

  const transitionText = {
    READY:             '✅ READY (90%+) — 마스터 승인 후 전환 가능',
    TUNING:            '🔧 TUNING (80-90%) — 프롬프트 튜닝 필요',
    HOLD:              '🛑 HOLD (<80%) — 기존 gpt-4o 유지',
    DATA_INSUFFICIENT: '❓ 데이터 부족',
  }[m.luna.transition] ?? '❓';

  const lunaTradeStr = m.luna.trade_count > 0
    ? `${m.luna.trade_count}건 (완료 ${m.luna.trade_success}건)`
    : '거래 없음';

  const cacheStr = s.cache_hit_rate !== null ? `${s.cache_hit_rate.toFixed(1)}%` : 'N/A';

  const goals = [
    { name: '스카 Shadow',    val: m.ska.shadow.matchRate,    goal: 80,  invert: false },
    { name: '루나 Shadow',    val: m.luna.shadow.matchRate,   goal: 90,  invert: false },
    { name: '클로드 Shadow',  val: m.claude.shadow.matchRate, goal: 85,  invert: false },
    { name: 'LLM 예산',       val: s.weekly_budget_ratio,     goal: 100, invert: true  },
    { name: '크래시',         val: s.crash_count,             goal: 0,   invert: true  },
  ];
  const achieved = goals.filter(g => {
    if (g.val === null) return false;
    return g.invert ? g.val <= g.goal : g.val >= g.goal;
  }).length;

  return [
    `📊 5주차 주간 안정화 리포트 (${m.week_end})`,
    '════════════════════════════════════════',
    '',
    '■ 안정화 지표 (목표 vs 실제)',
    `  스카 Shadow:    목표 80%  | 실제 ${fmtRate(m.ska.shadow.matchRate)} ${goalIcon(m.ska.shadow.matchRate, 80)}`,
    `  루나 Shadow:    목표 90%  | 실제 ${fmtRate(m.luna.shadow.matchRate)} ${goalIcon(m.luna.shadow.matchRate, 90)}`,
    `  클로드 Shadow:  목표 85%  | 실제 ${fmtRate(m.claude.shadow.matchRate)} ${goalIcon(m.claude.shadow.matchRate, 85)}`,
    `  LLM 예산:       목표 100% | 실제 ${s.weekly_budget_ratio.toFixed(1)}% ${goalIcon(s.weekly_budget_ratio, 100, true)}`,
    `  전체 크래시:    목표 0회  | 실제 ${s.crash_count}회 ${goalIcon(s.crash_count, 0, true)}`,
    '',
    '■ 팀별 현황',
    `  스카:  예약 ${m.ska.weekly_reservations}건 (7일)`,
    `  루나:  거래 ${lunaTradeStr}`,
    `  클로드: LLM $${s.weekly_llm_cost.toFixed(4)} / ${s.weekly_llm_calls}회`,
    `  캐시 히트: ${cacheStr}`,
    '',
    '■ Shadow Mode 일치율 (7일)',
    `  스카 (${m.ska.shadow.total}건):    ${fmtRate(m.ska.shadow.matchRate)}`,
    `  루나 (${m.luna.shadow.total}건):   ${fmtRate(m.luna.shadow.matchRate)}`,
    `  클로드 (${m.claude.shadow.total}건): ${fmtRate(m.claude.shadow.matchRate)}`,
    '',
    `■ 루나팀 전환 판단: ${transitionText}`,
    '',
    `■ LLM 졸업 후보: ${s.graduation_candidates}건${s.graduation_reverted?.length > 0 ? ` (복귀 ${s.graduation_reverted.length}건 ⚠️)` : ''}`,
    `■ 맥미니 이관 준비: ${m.migration.done}/${m.migration.total} 체크`,
    '',
    `목표 달성: ${achieved}/${goals.length} ${achieved === goals.length ? '🎉 전체 달성!' : '📈 계속 진행'}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════
// 메인
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('📊 주간 안정화 리포트 생성 중 (7일 기준)...\n');

  const metrics = await collectWeeklyMetrics();
  const report  = buildWeeklyReport(metrics);

  console.log(report);

  // 졸업 후보 상세
  if (metrics.system.graduation_report) {
    console.log('\n── LLM 졸업 후보 상세 ──────────────────────');
    console.log(metrics.system.graduation_report.slice(0, 500));
  }

  if (SEND_TG) {
    const ok = (await openclawClient.postAlarm({
      team: 'general',
      message: report,
      alertLevel: 1,
      fromBot: 'weekly-stability-report',
    })).ok;
    console.log(`\n텔레그램 발송: ${ok ? '✅' : '❌'}`);

    // 졸업 후보 있으면 클로드 Topic에 상세 발송
    if (metrics.system.graduation_candidates > 0 && metrics.system.graduation_report) {
      await openclawClient.postAlarm({
        team: 'claude-lead',
        message: `🎓 LLM 졸업 후보 ${metrics.system.graduation_candidates}건\n⚠️ 마스터 승인 후 적용\n\n${metrics.system.graduation_report.slice(0, 500)}`,
        alertLevel: 2,
        fromBot: 'weekly-stability-report',
      });
    }
    // 복귀 항목 있으면 별도 알림
    if (metrics.system.graduation_reverted?.length > 0) {
      const revertLines = metrics.system.graduation_reverted
        .map(r => `  • [${r.team}/${r.context}] ${r.decision} — ${r.mismatchRate} 불일치`)
        .join('\n');
      await openclawClient.postAlarm({
        team: 'claude-lead',
        message:
          `↩️ LLM 졸업 규칙 자동 복귀 ${metrics.system.graduation_reverted.length}건\n` +
          `최근 7일 불일치율 20%+ 초과\n\n${revertLines}`,
        alertLevel: 2,
        fromBot: 'weekly-stability-report',
      });
    }
  }
}

main().catch(e => { console.error('❌:', e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * scripts/stability-dashboard.js — 안정화 지표 자동 수집 + 리포트
 *
 * 5주차 안정화 일간/주간 지표 수집.
 * 덱스터 일일 점검에 통합 가능 (require하여 호출).
 *
 * 사용법:
 *   node scripts/stability-dashboard.js            # 콘솔 출력
 *   node scripts/stability-dashboard.js --telegram # 텔레그램 📌 총괄 발송
 *   node scripts/stability-dashboard.js --days=7   # 기간 변경
 */

const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const sender = require(path.join(ROOT, 'packages/core/lib/telegram-sender'));
const shadow = require(path.join(ROOT, 'packages/core/lib/shadow-mode'));
const logger = require(path.join(ROOT, 'packages/core/lib/llm-logger'));
const cache  = require(path.join(ROOT, 'packages/core/lib/llm-cache'));
const grad   = require(path.join(ROOT, 'packages/core/lib/llm-graduation'));
const pgPool = require(path.join(ROOT, 'packages/core/lib/pg-pool'));

const SEND_TG = process.argv.includes('--telegram');
const DAYS    = (() => { const m = process.argv.join(' ').match(/--days=(\d+)/); return m ? Number(m[1]) : 1; })();

// ── 루나 전환 판단 기준 ─────────────────────────────────────────────
const LUNA_READY_THRESHOLD  = 90;   // 90%+ → READY
const LUNA_TUNING_THRESHOLD = 80;   // 80-90% → TUNING

// ── 안정화 목표 ────────────────────────────────────────────────────
const GOALS = {
  ska_shadow:          80,   // 스카 Shadow 일치율 목표 (%)
  luna_shadow:         90,   // 루나 Shadow 일치율 목표 (%)
  claude_shadow:       85,   // 클로드 Shadow 일치율 목표 (%)
  llm_budget_ratio:    80,   // LLM 예산 사용률 목표 (%)
};

// ════════════════════════════════════════════════════════════════════
// 지표 수집
// ════════════════════════════════════════════════════════════════════

async function collectStabilityMetrics() {
  const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);

  // ── Shadow 일치율 ────────────────────────────────────────────────
  const shadowRates = {};
  for (const team of ['ska', 'luna', 'claude-lead']) {
    try {
      const r = await shadow.getMatchRate(team, null, DAYS);
      shadowRates[team] = {
        total:     r.total ?? 0,
        matched:   r.matched ?? 0,
        matchRate: r.matchRate ?? null,
        llmErrors: r.llmErrors ?? 0,
      };
    } catch {
      shadowRates[team] = { total: 0, matched: 0, matchRate: null, llmErrors: 0 };
    }
  }

  // ── LLM 비용 ─────────────────────────────────────────────────────
  let llmCost = { totalCost: 0, totalCalls: 0 };
  try { llmCost = await logger.getDailyCost(null, today) ?? llmCost; } catch {}

  // ── 캐시 히트율 ──────────────────────────────────────────────────
  let cacheStats = { hitRate: null, totalRequests: 0, hits: 0 };
  try { cacheStats = await cache.getCacheStats(DAYS) ?? cacheStats; } catch {}

  // ── LLM 졸업 후보 ────────────────────────────────────────────────
  let graduationCandidates = [];
  try {
    for (const team of ['ska', 'claude-lead', 'luna']) {
      const c = await grad.findGraduationCandidates(team, 20, 0.90);
      graduationCandidates = graduationCandidates.concat(c || []);
    }
  } catch {}

  // ── DB 행수 (스카 예약 정합성 대리 지표) ───────────────────────
  let skaReservations = 0;
  try {
    const rows = await pgPool.query('reservation',
      `SELECT COUNT(*) AS cnt FROM reservations WHERE created_at::date = $1`, [today]);
    skaReservations = Number(rows[0]?.cnt ?? 0);
  } catch {}

  // ── 크래시 횟수 (mainbot_queue error 기준) ─────────────────────
  let crashCount = 0;
  try {
    const rows = await pgPool.query('claude',
      `SELECT COUNT(*) AS cnt FROM mainbot_queue
       WHERE status = 'error'
         AND created_at > to_char(now() - INTERVAL '${DAYS} days', 'YYYY-MM-DD HH24:MI:SS')`
    );
    crashCount = Number(rows[0]?.cnt ?? 0);
  } catch {}

  // ── 루나 TP/SL 설정률 ────────────────────────────────────────────
  let tpSlRate = null;
  try {
    const rows = await pgPool.query('investment',
      `SELECT COUNT(*) FILTER (WHERE tp_sl_set = true) AS set_cnt,
              COUNT(*) AS total_cnt
       FROM positions
       WHERE created_at > to_char(now() - INTERVAL '${DAYS} days', 'YYYY-MM-DD HH24:MI:SS')`
    );
    const total = Number(rows[0]?.total_cnt ?? 0);
    const set   = Number(rows[0]?.set_cnt ?? 0);
    tpSlRate    = total > 0 ? Math.round(set / total * 100) : null;
  } catch {}

  // ── 루나 전환 판단 ────────────────────────────────────────────────
  const lunaRate = shadowRates['luna']?.matchRate;
  const lunaRecommendation =
    lunaRate === null        ? 'DATA_INSUFFICIENT'
    : lunaRate >= LUNA_READY_THRESHOLD  ? 'READY'
    : lunaRate >= LUNA_TUNING_THRESHOLD ? 'TUNING'
    : 'HOLD';

  return {
    date: today,
    days: DAYS,
    ska: {
      reservations_today: skaReservations,
      shadow: shadowRates['ska'],
    },
    luna: {
      tp_sl_rate: tpSlRate,
      shadow: shadowRates['luna'],
      transition: lunaRecommendation,
    },
    claude: {
      shadow: shadowRates['claude-lead'],
    },
    system: {
      llm_daily_cost: llmCost.totalCost ?? 0,
      llm_daily_calls: llmCost.totalCalls ?? 0,
      llm_budget_ratio: Math.min(100, ((llmCost.totalCost ?? 0) / (10/30)) * 100),
      cache_hit_rate: cacheStats.hitRate ?? null,
      graduation_candidates: graduationCandidates.length,
      crash_count: crashCount,
    },
    goals: GOALS,
  };
}

// ════════════════════════════════════════════════════════════════════
// 리포트 빌드
// ════════════════════════════════════════════════════════════════════

function goalIcon(value, goal, invert = false) {
  if (value === null) return '❓';
  const pass = invert ? value <= goal : value >= goal;
  return pass ? '✅' : '⚠️';
}

function fmtRate(r) {
  if (r === null || r === undefined) return '데이터 없음';
  return `${r}%`;
}

function buildDailyStabilityReport(m) {
  const si = m.system;
  const budgetIcon = goalIcon(si.llm_budget_ratio, GOALS.llm_budget_ratio, true);
  const cacheStr   = si.cache_hit_rate !== null ? `${si.cache_hit_rate.toFixed(1)}%` : '측정 중';

  // 루나 전환 판단 텍스트
  const transitionText = {
    READY:              '✅ READY — 마스터 승인 후 전환 가능',
    TUNING:             '🔧 TUNING — 프롬프트 튜닝 필요',
    HOLD:               '🛑 HOLD — 기존 gpt-4o 유지',
    DATA_INSUFFICIENT:  '❓ 데이터 부족 — 계속 수집 중',
  }[m.luna.transition] ?? '❓';

  const lines = [
    `📊 5주차 안정화 리포트 (${m.date}, ${m.days}일 기준)`,
    '════════════════════════════════',
    '',
    '▪ 스카팀',
    `  오늘 예약: ${m.ska.reservations_today}건`,
    `  Shadow: ${fmtRate(m.ska.shadow.matchRate)} (${m.ska.shadow.total}건) ${goalIcon(m.ska.shadow.matchRate, GOALS.ska_shadow)}`,
    '',
    '▪ 루나팀',
    `  TP/SL 설정률: ${m.luna.tp_sl_rate !== null ? m.luna.tp_sl_rate+'%' : '거래 없음'}`,
    `  Shadow: ${fmtRate(m.luna.shadow.matchRate)} (${m.luna.shadow.total}건) ${goalIcon(m.luna.shadow.matchRate, GOALS.luna_shadow)}`,
    `  전환 판단: ${transitionText}`,
    '',
    '▪ 클로드팀',
    `  Shadow: ${fmtRate(m.claude.shadow.matchRate)} (${m.claude.shadow.total}건) ${goalIcon(m.claude.shadow.matchRate, GOALS.claude_shadow)}`,
    '',
    '▪ 시스템',
    `  LLM 비용: $${si.llm_daily_cost.toFixed(4)} (예산 ${si.llm_budget_ratio.toFixed(1)}%) ${budgetIcon}`,
    `  LLM 호출: ${si.llm_daily_calls}건 | 캐시 히트: ${cacheStr}`,
    `  졸업 후보: ${si.graduation_candidates}건 | 크래시: ${si.crash_count}건`,
  ];

  // 전체 목표 달성 수
  const checks = [
    m.ska.shadow.matchRate    >= GOALS.ska_shadow,
    m.luna.shadow.matchRate   >= GOALS.luna_shadow,
    m.claude.shadow.matchRate >= GOALS.claude_shadow,
    si.llm_budget_ratio       <= GOALS.llm_budget_ratio,
  ].filter(Boolean).length;
  const total = 4;

  lines.push('');
  lines.push(`안정화 목표: ${checks}/${total} 달성 ${checks === total ? '🎉' : '📈'}`);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// 콘솔 출력
// ════════════════════════════════════════════════════════════════════

function printDashboard(m) {
  console.log('\n' + buildDailyStabilityReport(m) + '\n');

  // Shadow 상세
  console.log('── Shadow 상세 ──────────────────────────');
  for (const [team, s] of Object.entries({ ska: m.ska.shadow, luna: m.luna.shadow, 'claude-lead': m.claude.shadow })) {
    const rate = s.matchRate !== null ? `${s.matchRate}%` : 'N/A';
    console.log(`  ${team.padEnd(12)} ${rate.padStart(5)} (${s.total}건, LLM오류 ${s.llmErrors}건)`);
  }
  console.log('');
}

// ════════════════════════════════════════════════════════════════════
// 모듈 export (덱스터 통합용)
// ════════════════════════════════════════════════════════════════════

module.exports = { collectStabilityMetrics, buildDailyStabilityReport };

// ── 직접 실행 ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    console.log('📊 안정화 지표 수집 중...');
    const metrics = await collectStabilityMetrics();
    printDashboard(metrics);

    if (SEND_TG) {
      const report = buildDailyStabilityReport(metrics);
      const ok = await sender.send('general', report);
      console.log(`텔레그램 발송: ${ok ? '✅' : '❌'}`);
    }
  })().catch(e => { console.error('❌:', e.message); process.exit(1); });
}

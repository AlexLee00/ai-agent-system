// @ts-nocheck
/**
 * bots/investment/shared/dual-model-report.js — 주간 멀티 모델 경쟁 분석 리포트
 *
 * dual_model_results 테이블을 집계해 gpt-oss-20b vs llama-4-scout 성과 비교.
 * 텔레그램 investment 토픽으로 발송.
 *
 * 실행: node bots/investment/shared/dual-model-report.js
 * 스케줄: 매주 일요일 21:00 KST (weekly-report.js에서 호출)
 */

import * as db from './db.ts';
import { publishAlert } from './mainbot-client.ts';

const DIVIDER = '──────────';

/**
 * 주간 멀티 모델 경쟁 분석 리포트 생성 + 텔레그램 발송
 * @param {number} days — 분석 기간 (기본 7일)
 * @returns {string|null} 리포트 텍스트 (데이터 없으면 null)
 */
export async function buildDualModelReport(days = 7) {
  // ── 1. 전체 승률 집계 ─────────────────────────────────────────────
  const overallRows = await db.query(`
    SELECT winner,
           COUNT(*) AS wins,
           ROUND(AVG(oss_score)::numeric, 2)        AS avg_oss_score,
           ROUND(AVG(scout_score)::numeric, 2)      AS avg_scout_score,
           ROUND(AVG(oss_latency_ms))               AS avg_oss_latency,
           ROUND(AVG(scout_latency_ms))             AS avg_scout_latency,
           SUM(CASE WHEN oss_parseable   THEN 1 ELSE 0 END) AS oss_json_ok,
           SUM(CASE WHEN scout_parseable THEN 1 ELSE 0 END) AS scout_json_ok
    FROM dual_model_results
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY winner
    ORDER BY wins DESC
  `);

  const total = (overallRows || []).reduce((s, r) => s + parseInt(r.wins), 0);
  if (total === 0) return null;

  // ── 2. 에이전트별 선호 모델 ───────────────────────────────────────
  const agentRows = await db.query(`
    SELECT agent, winner, COUNT(*) AS wins,
           ROUND(AVG(oss_score)::numeric, 2)   AS avg_oss,
           ROUND(AVG(scout_score)::numeric, 2) AS avg_scout
    FROM dual_model_results
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY agent, winner
    ORDER BY agent, wins DESC
  `);

  // ── 3. 신호 일치율 ────────────────────────────────────────────────
  const agreeRow = await db.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN signals_agree THEN 1 ELSE 0 END) AS agreed
    FROM dual_model_results
    WHERE created_at >= NOW() - INTERVAL '${days} days'
      AND oss_parseable AND scout_parseable
  `);

  // ── 4. 일별 트렌드 (최근 3일) ─────────────────────────────────────
  const dailyRows = await db.query(`
    SELECT date(created_at) AS date,
           SUM(CASE WHEN winner = 'gpt-oss-20b'   THEN 1 ELSE 0 END) AS oss_wins,
           SUM(CASE WHEN winner = 'llama-4-scout' THEN 1 ELSE 0 END) AS scout_wins,
           ROUND(AVG(oss_score)::numeric, 2)   AS avg_oss,
           ROUND(AVG(scout_score)::numeric, 2) AS avg_scout
    FROM dual_model_results
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY date(created_at)
    ORDER BY date DESC
    LIMIT 3
  `);

  // ── 리포트 텍스트 생성 ────────────────────────────────────────────
  const lines = [
    `🏆 [루나팀] 멀티 모델 경쟁 주간 리포트 (최근 ${days}일)`,
    DIVIDER,
    '',
    `📊 전체 승률 (${total}회 대결):`,
  ];

  for (const r of (overallRows || [])) {
    const pct  = (parseInt(r.wins) / total * 100).toFixed(1);
    const icon = r.winner === 'gpt-oss-20b' ? '🟢' : r.winner === 'llama-4-scout' ? '🔵' : '🔴';
    lines.push(`  ${icon} ${r.winner}: ${r.wins}회 (${pct}%)`);
  }

  // 평균 품질 점수 (첫 번째 행 기준으로 둘 다 표시)
  if (overallRows?.length) {
    const ossRow   = overallRows.find(r => r.winner === 'gpt-oss-20b')   || overallRows[0];
    const scoutRow = overallRows.find(r => r.winner === 'llama-4-scout') || overallRows[0];
    lines.push('');
    lines.push('📈 평균 품질 점수:');
    lines.push(`  gpt-oss-20b:   ${ossRow.avg_oss_score || 0}점`);
    lines.push(`  llama-4-scout: ${scoutRow.avg_scout_score || 0}점`);
    lines.push('');
    lines.push('⚡ 평균 응답 속도:');
    lines.push(`  gpt-oss-20b:   ${ossRow.avg_oss_latency || 0}ms`);
    lines.push(`  llama-4-scout: ${scoutRow.avg_scout_latency || 0}ms`);

    const ossOk   = (overallRows || []).reduce((s, r) => s + parseInt(r.oss_json_ok   || 0), 0);
    const scoutOk = (overallRows || []).reduce((s, r) => s + parseInt(r.scout_json_ok || 0), 0);
    lines.push('');
    lines.push('🔧 JSON 파싱 성공률:');
    lines.push(`  gpt-oss-20b:   ${ossOk}/${total} (${(ossOk / total * 100).toFixed(0)}%)`);
    lines.push(`  llama-4-scout: ${scoutOk}/${total} (${(scoutOk / total * 100).toFixed(0)}%)`);
  }

  // 신호 일치율
  const agreeTotal   = parseInt(agreeRow?.total   || 0);
  const agreeAgreed  = parseInt(agreeRow?.agreed  || 0);
  if (agreeTotal > 0) {
    const pct = (agreeAgreed / agreeTotal * 100).toFixed(1);
    lines.push('');
    lines.push(`🤝 신호 일치율: ${agreeAgreed}/${agreeTotal} (${pct}%)`);
    if (parseFloat(pct) > 80) lines.push('  → 높은 일치율: 빠른 모델 단독 전환 검토 가능');
    if (parseFloat(pct) < 50) lines.push('  → 낮은 일치율: 멀티 모델 경쟁의 가치 높음');
  }

  // 에이전트별 선호 모델
  const agentMap = {};
  for (const r of (agentRows || [])) {
    if (!agentMap[r.agent]) agentMap[r.agent] = r;  // 승수 최다 = 첫 번째
  }
  if (Object.keys(agentMap).length > 0) {
    lines.push('');
    lines.push('🤖 에이전트별 선호 모델:');
    for (const [agent, r] of Object.entries(agentMap)) {
      lines.push(`  ${agent}: ${r.winner} 우세 (${r.wins}회, oss=${r.avg_oss} scout=${r.avg_scout})`);
    }
  }

  // 일별 트렌드
  if ((dailyRows || []).length > 0) {
    lines.push('');
    lines.push('📅 일별 트렌드:');
    for (const d of dailyRows) {
      lines.push(`  ${d.date}: oss ${d.oss_wins}승 vs scout ${d.scout_wins}승 (점수 ${d.avg_oss}:${d.avg_scout})`);
    }
  }

  // 권장
  lines.push('');
  lines.push(DIVIDER);
  const ossWins   = parseInt((overallRows || []).find(r => r.winner === 'gpt-oss-20b')?.wins   || 0);
  const scoutWins = parseInt((overallRows || []).find(r => r.winner === 'llama-4-scout')?.wins || 0);

  if (total >= 20) {
    if (ossWins > scoutWins * 2)   lines.push('💡 권장: gpt-oss-20b 단독 전환 검토 (압도적 우세)');
    else if (scoutWins > ossWins * 2) lines.push('💡 권장: llama-4-scout 단독 전환 검토 (압도적 우세)');
    else                           lines.push('💡 권장: 멀티 모델 경쟁 유지 (양측 균형)');
  } else {
    lines.push(`💡 데이터 수집 중 (${total}/20회) — 아직 판단하기 이름`);
  }

  const report = lines.join('\n');

  // 텔레그램 발송
  publishAlert({
    from_bot: 'luna', event_type: 'report', alert_level: 1, message: report,
  });

  return report;
}

// ── CLI 직접 실행 ──────────────────────────────────────────────────────

if (process.argv[1] === new URL(import.meta.url).pathname) {
  import('./db.ts').then(async () => {
    const report = await buildDualModelReport(7);
    if (report) console.log('\n' + report);
    else console.log('[dual-model-report] 데이터 없음 (7일 내 dual_model_results 기록 없음)');
  }).catch(console.error);
}

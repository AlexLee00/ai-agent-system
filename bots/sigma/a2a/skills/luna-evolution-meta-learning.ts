// @ts-nocheck
/**
 * bots/sigma/a2a/skills/luna-evolution-meta-learning.ts
 *
 * 시그마 메타 학습: 루나 에이전트 진화 결과 분석 + 시스템 일관성 검증
 *
 * 시그마 역할: 루나의 weekly evolution 결과를 검토하고
 *   - 진화 방향이 시스템 원칙에 부합하는지 검증
 *   - 커리큘럼 상태의 일관성 확인
 *   - 개선 방향 제안 (feedback_effectiveness 갱신)
 */

import { registerSkillHandler } from '../handlers/task-handler.ts';

const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN;

async function hubQuery(sql: string): Promise<any[]> {
  if (!HUB_TOKEN) return [];
  const res = await fetch(`${HUB_URL}/hub/pg/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HUB_TOKEN}`,
    },
    body: JSON.stringify({ sql }),
  }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json().catch(() => null);
  return data?.rows || [];
}

async function fetchLatestEvolutionLog(weeks = 4): Promise<any[]> {
  return hubQuery(`
    SELECT week_id, loss_pattern_count, win_pattern_count,
           adjustment_count, evolution_summary, logged_at
      FROM investment.luna_evolution_log
     ORDER BY week_id DESC
     LIMIT ${weeks}
  `);
}

async function fetchCurriculumState(): Promise<any | null> {
  const rows = await hubQuery(`
    SELECT week_id, avoid_patterns, priority_patterns,
           market_weights, regime_weights, evolution_notes, updated_at
      FROM investment.agent_curriculum_state
     ORDER BY week_id DESC
     LIMIT 1
  `);
  return rows[0] || null;
}

async function fetchTopLossPatterns(limit = 5): Promise<any[]> {
  return hubQuery(`
    SELECT pattern_key, market, trade_count, total_penalty,
           avoidance_guide, confidence
      FROM investment.luna_loss_patterns
     ORDER BY total_penalty DESC
     LIMIT ${limit}
  `);
}

async function fetchTopWinPatterns(limit = 5): Promise<any[]> {
  return hubQuery(`
    SELECT pattern_key, market, trade_count, avg_win_pct,
           priority_guide, confidence
      FROM investment.luna_win_patterns
     ORDER BY total_profit DESC
     LIMIT ${limit}
  `);
}

async function persistMetaLearningResult(result: {
  weekId: string;
  consistencyScore: number;
  findings: string[];
  recommendations: string[];
  analyzedAt: string;
}): Promise<void> {
  const sql = `
    INSERT INTO investment.sigma_meta_learning_log
      (week_id, consistency_score, findings_json, recommendations_json, analyzed_at)
    VALUES (
      '${result.weekId}',
      ${result.consistencyScore},
      '${JSON.stringify(result.findings).replace(/'/g, "''")}',
      '${JSON.stringify(result.recommendations).replace(/'/g, "''")}',
      '${result.analyzedAt}'
    )
    ON CONFLICT (week_id) DO UPDATE SET
      consistency_score    = EXCLUDED.consistency_score,
      findings_json        = EXCLUDED.findings_json,
      recommendations_json = EXCLUDED.recommendations_json,
      analyzed_at          = EXCLUDED.analyzed_at
  `;
  await hubQuery(sql);
}

function assessConsistency(curriculum: any, topLoss: any[], topWin: any[]): {
  score: number;
  findings: string[];
} {
  const findings: string[] = [];
  let score = 1.0;

  const avoidPatterns: string[] = Array.isArray(curriculum?.avoid_patterns)
    ? curriculum.avoid_patterns
    : [];
  const priorityPatterns: string[] = Array.isArray(curriculum?.priority_patterns)
    ? curriculum.priority_patterns
    : [];

  // 손실 패턴이 avoid_patterns에 포함되어 있는지 검증
  for (const lp of topLoss) {
    if (lp.total_penalty > 0.5 && !avoidPatterns.includes(lp.pattern_key)) {
      findings.push(`고손실 패턴 ${lp.pattern_key} (penalty=${lp.total_penalty}) 가 avoid_patterns 미포함`);
      score -= 0.1;
    }
  }

  // 수익 패턴이 priority_patterns에 포함되어 있는지 검증
  for (const wp of topWin) {
    if (wp.avg_win_pct > 0.05 && !priorityPatterns.includes(wp.pattern_key)) {
      findings.push(`고수익 패턴 ${wp.pattern_key} (avgWin=${(Number(wp.avg_win_pct) * 100).toFixed(1)}%) 가 priority_patterns 미포함`);
      score -= 0.05;
    }
  }

  if (findings.length === 0) {
    findings.push('커리큘럼 상태 일관성 확인 완료 — 이상 없음');
  }

  return { score: Math.max(0, Math.min(1, score)), findings };
}

function buildRecommendations(logs: any[], consistencyScore: number): string[] {
  const recs: string[] = [];

  if (logs.length >= 2) {
    const latest = logs[0];
    const prev = logs[1];
    const lossDelta = Number(latest.loss_pattern_count || 0) - Number(prev.loss_pattern_count || 0);
    const winDelta = Number(latest.win_pattern_count || 0) - Number(prev.win_pattern_count || 0);

    if (lossDelta > 3) {
      recs.push(`손실 패턴 급증 (+${lossDelta}) — 리스크 파라미터 재검토 권고`);
    }
    if (winDelta > 3) {
      recs.push(`수익 패턴 증가 (+${winDelta}) — 해당 전략 sizing 확대 검토`);
    }
  }

  if (consistencyScore < 0.7) {
    recs.push(`커리큘럼 일관성 점수 낮음 (${(consistencyScore * 100).toFixed(0)}%) — 수동 검토 권고`);
  }

  if (recs.length === 0) {
    recs.push('현재 진화 방향 정상 — 다음 주 진행 유지');
  }

  return recs;
}

async function runLunaEvolutionMetaLearning(params: { weeks?: number } = {}): Promise<{
  weekId: string;
  consistencyScore: number;
  findings: string[];
  recommendations: string[];
}> {
  const weeks = params.weeks ?? 4;
  const [logs, curriculum, topLoss, topWin] = await Promise.all([
    fetchLatestEvolutionLog(weeks),
    fetchCurriculumState(),
    fetchTopLossPatterns(5),
    fetchTopWinPatterns(5),
  ]);

  if (!curriculum) {
    return {
      weekId: 'unknown',
      consistencyScore: 0,
      findings: ['커리큘럼 상태 없음 — 아직 진화 미실행'],
      recommendations: ['일요일 06:00 agent-evolution 실행 후 재분석'],
    };
  }

  const { score, findings } = assessConsistency(curriculum, topLoss, topWin);
  const recommendations = buildRecommendations(logs, score);

  const result = {
    weekId: curriculum.week_id,
    consistencyScore: score,
    findings,
    recommendations,
    analyzedAt: new Date().toISOString(),
  };

  await persistMetaLearningResult(result);
  return result;
}

registerSkillHandler('luna_evolution_meta_learning', async (params) => {
  const result = await runLunaEvolutionMetaLearning(params);
  return {
    success: true,
    weekId: result.weekId,
    consistencyScore: result.consistencyScore,
    findings: result.findings,
    recommendations: result.recommendations,
  };
});

export default runLunaEvolutionMetaLearning;

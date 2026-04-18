/**
 * LLM Shadow Mode 비교 분석 스크립트 (수동 실행용)
 *
 * sigma_shadow_comparison / darwin_shadow_comparison 테이블에서
 * Hub vs Direct 비교 결과를 집계하여 Telegram으로 전송.
 *
 * 사용:
 *   HUB_AUTH_TOKEN=... tsx bots/hub/scripts/llm-shadow-analysis.ts
 *   HUB_AUTH_TOKEN=... tsx bots/hub/scripts/llm-shadow-analysis.ts --team sigma
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const telegramSender = require('../../../packages/core/lib/telegram-sender');
const pgPool = require('../../../packages/core/lib/pg-pool');

const TEAM = process.argv.includes('--team')
  ? process.argv[process.argv.indexOf('--team') + 1]
  : 'all';

interface ShadowStats {
  team: string;
  total_comparisons: number;
  hub_ok_rate: number;
  direct_ok_rate: number;
  hub_avg_ms: number;
  direct_avg_ms: number;
  hub_total_cost: number;
  direct_total_cost: number;
  avg_similarity: number;
}

async function analyzeTeam(team: 'sigma' | 'darwin'): Promise<ShadowStats | null> {
  const table = `${team}_shadow_comparison`;
  try {
    const result = await pgPool.query(`
      SELECT
        COUNT(*)                                          AS total,
        AVG(CASE WHEN hub_ok THEN 1.0 ELSE 0.0 END)      AS hub_ok_rate,
        AVG(CASE WHEN direct_ok THEN 1.0 ELSE 0.0 END)   AS direct_ok_rate,
        AVG(hub_ms)                                       AS hub_avg_ms,
        AVG(direct_ms)                                    AS direct_avg_ms,
        SUM(hub_cost)                                     AS hub_total_cost,
        SUM(direct_cost)                                  AS direct_total_cost,
        AVG(result_similarity)                            AS avg_similarity
      FROM ${table}
    `);
    const row = result.rows[0];
    if (!row || Number(row.total) === 0) return null;
    return {
      team,
      total_comparisons: Number(row.total),
      hub_ok_rate: Number(row.hub_ok_rate || 0),
      direct_ok_rate: Number(row.direct_ok_rate || 0),
      hub_avg_ms: Number(row.hub_avg_ms || 0),
      direct_avg_ms: Number(row.direct_avg_ms || 0),
      hub_total_cost: Number(row.hub_total_cost || 0),
      direct_total_cost: Number(row.direct_total_cost || 0),
      avg_similarity: Number(row.avg_similarity || 0),
    };
  } catch (err: any) {
    if (err.message.includes('does not exist')) {
      console.log(`[shadow-analysis] ${table} 테이블 없음 (Shadow 미실행)`);
      return null;
    }
    throw err;
  }
}

function formatStats(stats: ShadowStats): string[] {
  const lines: string[] = [];
  const costSaved = stats.direct_total_cost - stats.hub_total_cost;
  const switchRecommended = stats.avg_similarity >= 0.90 && stats.hub_ok_rate >= 0.95;

  lines.push(`*${stats.team.toUpperCase()} Shadow 분석 (${stats.total_comparisons}회 비교)*`);
  lines.push(`  품질 유사도 평균: ${(stats.avg_similarity * 100).toFixed(1)}%`);
  lines.push(`  Hub 성공률: ${(stats.hub_ok_rate * 100).toFixed(1)}% | Direct: ${(stats.direct_ok_rate * 100).toFixed(1)}%`);
  lines.push(`  Hub avg: ${Math.round(stats.hub_avg_ms)}ms | Direct avg: ${Math.round(stats.direct_avg_ms)}ms`);
  lines.push(`  Hub 비용: $${stats.hub_total_cost.toFixed(4)} | Direct: $${stats.direct_total_cost.toFixed(4)}`);
  lines.push(`  절감 예상: $${costSaved.toFixed(4)}`);
  lines.push(`  판정: ${switchRecommended ? '✅ LIVE 전환 권장' : '⚠️ 추가 관찰 필요'}`);
  return lines;
}

async function main() {
  const teams: ('sigma' | 'darwin')[] = TEAM === 'all' ? ['sigma', 'darwin'] : [TEAM as 'sigma' | 'darwin'];

  const lines: string[] = ['📊 *LLM Shadow Mode 비교 분석*', ''];

  for (const team of teams) {
    const stats = await analyzeTeam(team);
    if (stats) {
      lines.push(...formatStats(stats));
    } else {
      lines.push(`*${team.toUpperCase()}*: Shadow 비교 데이터 없음 (아직 미실행)`);
    }
    lines.push('');
  }

  const message = lines.join('\n');
  console.log('[shadow-analysis]', message);
  await telegramSender.send('general', message);
  console.log('[shadow-analysis] Telegram 전송 완료');
}

main().catch((err: Error) => {
  console.error('[shadow-analysis] 실패:', err.message);
  process.exit(1);
});

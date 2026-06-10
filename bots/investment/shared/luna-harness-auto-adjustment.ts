// @ts-nocheck
/**
 * Luna Harness Auto-Adjustment
 *
 * 마스터 철학: "하네스 결과 → 자율 조정!"
 * 2026 트렌드: Self-Rewarding + Strategy Evolution
 *
 * 매일 06:00:
 *   1. 기존 Evaluator/Harness 결과 수집
 *   2. 성과 임계값 이하 → strategy_mutation_events 자동 생성
 *   3. Self-Rewarding 통합 → 자율 mutation 활성화
 *   4. 에이전트 커리큘럼 갱신 권고
 */

import * as db from './db/core.ts';

// ─── 타입 정의 ─────────────────────────────────────────────────

export interface HarnessCheckResult {
  harnessName: string;
  market: string;
  symbol?: string;
  score: number;          // 0~1 품질 점수
  passed: boolean;
  details: Record<string, unknown>;
  checkedAt: string;
}

export interface AutoAdjustmentResult {
  market: string;
  harnessResults: HarnessCheckResult[];
  mutationsCreated: number;
  mutationsPlanned?: number;
  writeApplied?: boolean;
  dryRun?: boolean;
  agentsAdjusted: string[];
  configAdjustments: ConfigAdjustment[];
  summary: string;
}

export interface ConfigAdjustment {
  paramName: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  severity: 'minor' | 'moderate' | 'major';
}

// ─── 하네스 결과 수집 ─────────────────────────────────────────

/**
 * 최근 하네스 실행 결과 조회
 * (strategy-validity-evaluator, trade-quality-evaluator 등)
 */
async function collectHarnessResults(market: string): Promise<HarnessCheckResult[]> {
  const results: HarnessCheckResult[] = [];

  // 1. Trade Quality 하네스
  try {
    const res = await db.query(`
      SELECT
        'trade_quality' AS harness_name,
        market,
        AVG(overall_score) AS score,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE overall_score >= 0.6) AS passed_count,
        MAX(created_at) AS last_at
      FROM investment.trade_quality_evaluations
      WHERE market = $1 AND created_at >= CURRENT_DATE - INTERVAL '1 day'
      GROUP BY market
    `, [market]);

    for (const row of res.rows) {
      const score = Number(row.score ?? 0);
      results.push({
        harnessName: 'trade_quality',
        market: row.market,
        score,
        passed: score >= 0.55,
        details: { count: row.count, passedCount: row.passed_count, lastAt: row.last_at },
        checkedAt: new Date().toISOString(),
      });
    }
  } catch (_err) {
    // skip
  }

  // 2. Strategy Validity 하네스
  try {
    const res = await db.query(`
      SELECT
        'strategy_validity' AS harness_name,
        market,
        AVG(validity_score) AS score,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE would_block = false) AS healthy_count
      FROM investment.candidate_backtest_status
      WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      GROUP BY market
    `, []);

    for (const row of res.rows) {
      const score = Number(row.score ?? 0);
      results.push({
        harnessName: 'strategy_validity',
        market: row.market,
        score,
        passed: score >= 0.60,
        details: { count: row.count, healthyCount: row.healthy_count },
        checkedAt: new Date().toISOString(),
      });
    }
  } catch (_err) {
    // skip
  }

  // 3. 분석팀 정확도 하네스
  try {
    const agents = ['aria', 'sophia', 'hermes', 'oracle'];
    for (const agent of agents) {
      const res = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${agent}_accurate = true)::float /
          NULLIF(COUNT(*) FILTER (WHERE ${agent}_accurate IS NOT NULL), 0) AS accuracy,
          COUNT(*) FILTER (WHERE ${agent}_accurate IS NOT NULL) AS cnt
        FROM investment.trade_review
        WHERE market = $1 AND created_at >= NOW() - INTERVAL '7 days'
      `, [market]);

      const accuracy = Number(res.rows[0]?.accuracy ?? 0.5);
      const cnt = Number(res.rows[0]?.cnt ?? 0);
      if (cnt >= 3) {
        results.push({
          harnessName: `analyst_accuracy_${agent}`,
          market,
          score: accuracy,
          passed: accuracy >= 0.55,
          details: { agent, accuracy, sampleCount: cnt },
          checkedAt: new Date().toISOString(),
        });
      }
    }
  } catch (_err) {
    // skip
  }

  // 4. 신호 수집 하네스 (오늘 신호가 충분한가)
  try {
    const res = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM investment.position_signal_history
      WHERE market = $1 AND created_at >= CURRENT_DATE
    `, [market]);

    const cnt = Number(res.rows[0]?.cnt ?? 0);
    const score = Math.min(1, cnt / 10);  // 10건 = 만점
    results.push({
      harnessName: 'signal_collection',
      market,
      score,
      passed: cnt >= 3,
      details: { signalCount: cnt, target: 10 },
      checkedAt: new Date().toISOString(),
    });
  } catch (_err) {
    // skip
  }

  return results;
}

// ─── 하네스 실패 → Mutation 자동 생성 ───────────────────────

async function createMutationsFromHarness(results: HarnessCheckResult[], options: { write?: boolean; dryRun?: boolean } = {}): Promise<{ created: number; planned: number }> {
  let created = 0;
  let planned = 0;
  const writeEnabled = options.write !== false && options.dryRun !== true;
  const failed = results.filter(r => !r.passed);

  for (const result of failed) {
    const mutationType = getMutationType(result);
    if (!mutationType) continue;
    planned++;

    if (!writeEnabled) {
      console.log(`[HarnessAdjust][DRY-RUN] mutation 계획: ${mutationType} ← ${result.harnessName}(${result.score.toFixed(2)})`);
      continue;
    }

    try {
      await db.query(`
        INSERT INTO investment.strategy_mutation_events (
          event_type, lifecycle_phase, position_scope_key, exchange, symbol, trade_mode,
          old_setup_type, validity_score, predictive_score, reason, metadata, created_at
        ) VALUES ($1, 'shadow', $2, 'learning', $3, 'shadow', $3, $4, $5, $6, $7::jsonb, NOW())
      `, [
        mutationType,
        `harness:${result.harnessName}`,
        result.harnessName,
        result.score,
        result.score + 0.10,  // 기대 개선
        `harness ${result.harnessName} score=${result.score.toFixed(3)} triggered ${mutationType}`,
        JSON.stringify({ source: 'luna_harness_auto_adjustment', harnessName: result.harnessName, score: result.score }),
      ]);
      created++;
      console.log(`[HarnessAdjust] mutation 생성: ${mutationType} ← ${result.harnessName}(${result.score.toFixed(2)})`);
    } catch (_err) {
      // 중복 등 무시
    }
  }
  return { created, planned };
}

function getMutationType(result: HarnessCheckResult): string | null {
  if (result.harnessName === 'trade_quality' && result.score < 0.45) {
    return 'quality_degradation_alert';
  }
  if (result.harnessName === 'strategy_validity' && result.score < 0.50) {
    return 'strategy_validity_degradation';
  }
  if (result.harnessName.startsWith('analyst_accuracy_') && result.score < 0.50) {
    return 'analyst_accuracy_degradation';
  }
  if (result.harnessName === 'signal_collection' && result.score < 0.3) {
    return 'insufficient_signal_collection';
  }
  return null;
}

// ─── 자동 파라미터 조정 제안 ─────────────────────────────────

function buildConfigAdjustments(results: HarnessCheckResult[]): ConfigAdjustment[] {
  const adjustments: ConfigAdjustment[] = [];
  const failed = results.filter(r => !r.passed);

  for (const result of failed) {
    if (result.harnessName === 'trade_quality' && result.score < 0.40) {
      adjustments.push({
        paramName: 'confidence_threshold',
        oldValue: 0.55,
        newValue: 0.65,
        reason: `거래 품질 ${result.score.toFixed(2)} < 0.40 — 신뢰도 임계값 강화`,
        severity: result.score < 0.30 ? 'major' : 'moderate',
      });
    }

    if (result.harnessName.startsWith('analyst_accuracy_') && result.score < 0.45) {
      const agentName = result.harnessName.replace('analyst_accuracy_', '');
      adjustments.push({
        paramName: `analyst_weight_${agentName}`,
        oldValue: 'current',
        newValue: 'reduce_20pct',
        reason: `${agentName} 정확도 ${result.score.toFixed(2)} < 0.45 — 가중치 20% 감소 권장`,
        severity: 'minor',
      });
    }

    if (result.harnessName === 'signal_collection' && result.score < 0.2) {
      adjustments.push({
        paramName: 'screening_threshold',
        oldValue: 'current',
        newValue: 'relax_10pct',
        reason: `일일 신호 ${(result.details as any)?.signalCount ?? 0}건 — 스크리닝 기준 완화 권장`,
        severity: 'minor',
      });
    }
  }

  return adjustments;
}

// ─── 에이전트 조정 대상 식별 ─────────────────────────────────

function identifyAgentsToAdjust(results: HarnessCheckResult[]): string[] {
  const agents = new Set<string>();
  for (const result of results) {
    if (!result.passed && result.harnessName.startsWith('analyst_accuracy_')) {
      const agentName = result.harnessName.replace('analyst_accuracy_', '');
      agents.add(agentName);
    }
  }
  return Array.from(agents);
}

// ─── 메인: 일간 하네스 자율 조정 ─────────────────────────────

export async function runHarnessAutoAdjustment(market: string, options: { write?: boolean; dryRun?: boolean } = {}): Promise<AutoAdjustmentResult> {
  const dryRun = options.dryRun === true;
  const writeApplied = options.write !== false && !dryRun;
  const prefix = dryRun ? '[HarnessAdjust][DRY-RUN]' : '[HarnessAdjust]';
  console.log(`${prefix} ${market} 시작`);

  const harnessResults = await collectHarnessResults(market);
  console.log(`${prefix} ${harnessResults.length}개 하네스 체크 완료`);

  const mutationResult = await createMutationsFromHarness(harnessResults, { dryRun, write: writeApplied });
  const mutationsCreated = mutationResult.created;
  const mutationsPlanned = mutationResult.planned;
  const configAdjustments = buildConfigAdjustments(harnessResults);
  const agentsAdjusted = identifyAgentsToAdjust(harnessResults);

  const passedCount = harnessResults.filter(r => r.passed).length;
  const summary = [
    `하네스 ${harnessResults.length}개 체크: 통과 ${passedCount}/${harnessResults.length}`,
    writeApplied ? `mutation ${mutationsCreated}건 생성` : `mutation ${mutationsPlanned}건 계획(dry-run)`,
    `조정 대상 에이전트: ${agentsAdjusted.join(', ') || '없음'}`,
    `파라미터 조정 제안: ${configAdjustments.length}건`,
  ].join(' | ');

  console.log(`${prefix} ${summary}`);
  return { market, harnessResults, mutationsCreated, mutationsPlanned, writeApplied, dryRun, agentsAdjusted, configAdjustments, summary };
}

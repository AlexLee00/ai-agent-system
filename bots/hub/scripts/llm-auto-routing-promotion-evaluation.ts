// @ts-nocheck
'use strict';

// Week 4 Day 25-26: LLM Auto-Routing Promotion 평가 스크립트
// 21일 Shadow 누적 + 라우팅 패턴 통계 + Promotion 적합성 평가
//
// 실행:
//   tsx bots/hub/scripts/llm-auto-routing-promotion-evaluation.ts
//   tsx bots/hub/scripts/llm-auto-routing-promotion-evaluation.ts --json

import path from 'node:path';
import fs from 'node:fs';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

export const AUTO_ROUTING_PROMOTION_CRITERIA = {
  minShadowDays: 21,
  minSamples: 100,
  maxFailureRate: 0.05,
  maxP99LatencyMs: 5000,
  minManualComparisonSamples: 30,
  minManualAgreementRate: 0.85,
  minClusterSamples: 30,
} as const;

const CLUSTER_PROMOTION_ENV = 'LLM_CLUSTER_PROMOTION_EVALUATION_ENABLED';

type ClusterPromotionRow = {
  cluster_id?: string | null;
  signature_key?: string | null;
  recommended_model?: string | null;
  selected_model?: string | null;
  success?: boolean | string | null;
};

type ClusterPromotionSummary = {
  clusterId: string;
  signatureKey: string | null;
  recommendedModel: string | null;
  sampleCount: number;
  recommendationMatchCount: number;
  recommendationMatchRate: number;
  recommendedSuccessRate: number | null;
  alternativeSuccessRate: number | null;
  successRateDelta: number | null;
  signatureMatched: boolean;
  sufficientSamples: boolean;
};

export type ClusterPromotionEvaluation = {
  enabled: true;
  applied: boolean;
  fallbackReason?: 'insufficient_cluster_data';
  minSamplesPerCluster: number;
  clusters: ClusterPromotionSummary[];
  checks: Array<{ name: string; passed: boolean; value: string }>;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface RoutingPromotionResult {
  ok: boolean;
  ts: string;
  promotionEligible: boolean;
  shadowDays: number;
  stats: {
    total: number;
    byMode: Record<string, number>;
    byComplexity: Record<string, number>;
    byProvider: Record<string, number>;
    failureRate: number;
    p99LatencyMs: number;
    estimatedSavingsUsd: number;
    manualComparisonCount: number;
    manualAgreementRate: number;
  };
  checks: Array<{ name: string; passed: boolean; value: string }>;
  blockers: string[];
  nextStep: string;
  clusterEvaluation?: ClusterPromotionEvaluation;
}

type PromotionEvaluationDeps = {
  env?: Record<string, string | undefined>;
  pgPool?: any;
};

async function queryWithFallback(pgPool: any, sql: string, params: any[] = []): Promise<any[]> {
  try {
    const rows = await pgPool.query('public', sql, params);
    return Array.isArray(rows) ? rows : (rows?.rows ?? []);
  } catch (_) {
    return [];
  }
}

function envEnabled(value: unknown): boolean {
  return /^(1|true|yes|on|shadow)$/i.test(String(value || '').trim());
}

function booleanSuccess(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === 'true';
}

function rate(successes: number, total: number): number | null {
  return total > 0 ? successes / total : null;
}

export function evaluateClusterPromotion(
  rows: ClusterPromotionRow[],
  minSamples = AUTO_ROUTING_PROMOTION_CRITERIA.minClusterSamples,
): ClusterPromotionEvaluation {
  const groups = new Map<string, ClusterPromotionRow[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const clusterId = String(row.cluster_id || '').trim();
    if (!clusterId) continue;
    const group = groups.get(clusterId) || [];
    group.push(row);
    groups.set(clusterId, group);
  }

  const safeMinSamples = Math.max(1, Math.floor(Number(minSamples) || AUTO_ROUTING_PROMOTION_CRITERIA.minClusterSamples));
  const clusters = [...groups.entries()].map(([clusterId, group]): ClusterPromotionSummary => {
    const signatures = new Set(group.map((row) => String(row.signature_key || '').trim()).filter(Boolean));
    const recommendedModels = new Set(group.map((row) => String(row.recommended_model || '').trim()).filter(Boolean));
    const signatureMatched = signatures.size === 1 && recommendedModels.size === 1;
    const recommendedModel = recommendedModels.size === 1 ? [...recommendedModels][0] : null;
    const recommendationMatches = recommendedModel
      ? group.filter((row) => String(row.selected_model || '').trim() === recommendedModel)
      : [];
    const alternatives = recommendedModel
      ? group.filter((row) => {
        const selected = String(row.selected_model || '').trim();
        return selected && selected !== recommendedModel;
      })
      : [];
    const recommendedSuccessRate = rate(recommendationMatches.filter((row) => booleanSuccess(row.success)).length, recommendationMatches.length);
    const alternativeSuccessRate = rate(alternatives.filter((row) => booleanSuccess(row.success)).length, alternatives.length);
    const successRateDelta = recommendedSuccessRate == null || alternativeSuccessRate == null
      ? null
      : Number((recommendedSuccessRate - alternativeSuccessRate).toFixed(4));
    return {
      clusterId,
      signatureKey: signatures.size === 1 ? [...signatures][0] : null,
      recommendedModel,
      sampleCount: group.length,
      recommendationMatchCount: recommendationMatches.length,
      recommendationMatchRate: group.length ? Number((recommendationMatches.length / group.length).toFixed(4)) : 0,
      recommendedSuccessRate: recommendedSuccessRate == null ? null : Number(recommendedSuccessRate.toFixed(4)),
      alternativeSuccessRate: alternativeSuccessRate == null ? null : Number(alternativeSuccessRate.toFixed(4)),
      successRateDelta,
      signatureMatched,
      sufficientSamples: signatureMatched
        && group.length >= safeMinSamples
        && recommendationMatches.length > 0
        && alternatives.length > 0,
    };
  }).sort((left, right) => left.clusterId.localeCompare(right.clusterId));

  const applied = clusters.length > 0 && clusters.every((cluster) => cluster.sufficientSamples);
  const checks = applied
    ? clusters.map((cluster) => ({
      name: `Cluster ${cluster.clusterId} 추천 성공률 delta 0%p+`,
      passed: Number(cluster.successRateDelta) >= 0,
      value: `${(Number(cluster.successRateDelta) * 100).toFixed(1)}%p (n=${cluster.sampleCount}, match=${(cluster.recommendationMatchRate * 100).toFixed(1)}%)`,
    }))
    : [];

  return {
    enabled: true,
    applied,
    ...(!applied ? { fallbackReason: 'insufficient_cluster_data' as const } : {}),
    minSamplesPerCluster: safeMinSamples,
    clusters,
    checks,
  };
}

export async function runLlmAutoRoutingPromotionEvaluation(
  deps: PromotionEvaluationDeps = {},
): Promise<RoutingPromotionResult> {
  const pgPool = deps.pgPool || require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
  const env = deps.env || process.env;

  const twentyOneDaysAgo = new Date(Date.now() - 21 * 86400_000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [shadowDaysRows, totalRows, modeRows, complexityRows, providerRows, failRows, latencyRows, costRows, manualRows] = await Promise.allSettled([
    // Shadow 기간 측정
    queryWithFallback(pgPool, `
      SELECT ceil(extract(epoch from (now() - min(created_at))) / 86400) AS days
      FROM hub.llm_auto_routing_log
    `),
    // 전체 건수
    queryWithFallback(pgPool, `SELECT count(*) AS cnt FROM hub.llm_auto_routing_log`),
    // 모드별
    queryWithFallback(pgPool, `SELECT mode, count(*) AS cnt FROM hub.llm_auto_routing_log GROUP BY mode`),
    // 복잡도별 (최근 7일)
    queryWithFallback(pgPool, `
      SELECT task_complexity, count(*) AS cnt
      FROM hub.llm_auto_routing_log
      WHERE created_at > $1
      GROUP BY task_complexity
    `, [sevenDaysAgo]),
    // provider별
    queryWithFallback(pgPool, `
      SELECT selected_provider, count(*) AS cnt
      FROM hub.llm_auto_routing_log
      WHERE created_at > $1 AND selected_provider IS NOT NULL
      GROUP BY selected_provider
    `, [sevenDaysAgo]),
    // 실패율
    queryWithFallback(pgPool, `
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE success = false) AS failures
      FROM hub.llm_auto_routing_log
      WHERE created_at > $1
    `, [sevenDaysAgo]),
    // p99 latency
    queryWithFallback(pgPool, `
      SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
      FROM hub.llm_auto_routing_log
      WHERE created_at > $1 AND latency_ms IS NOT NULL
    `, [sevenDaysAgo]),
    // 비용 절감 추정
    queryWithFallback(pgPool, `
      SELECT
        sum(cost_usd) FILTER (WHERE auto_model = 'anthropic_haiku') AS haiku_cost,
        count(*) FILTER (WHERE auto_model = 'anthropic_haiku') AS haiku_count,
        sum(cost_usd) AS total_cost
      FROM hub.llm_auto_routing_log
      WHERE created_at > $1 AND mode = 'shadow'
    `, [sevenDaysAgo]),
    // v1 shadow 정확도: 현재 수동 모델과 auto 모델 일치율
    queryWithFallback(pgPool, `
      SELECT
        count(*) FILTER (WHERE manual_model IS NOT NULL) AS manual_count,
        count(*) FILTER (WHERE manual_model IS NOT NULL AND manual_model = auto_model) AS manual_agreement_count
      FROM hub.llm_auto_routing_log
      WHERE mode = 'shadow'
    `),
  ]);

  const getVal = (settled: PromiseSettledResult<any[]>, field: string, def: any = 0) =>
    (settled.status === 'fulfilled' ? settled.value : [])[0]?.[field] ?? def;

  const shadowDays = parseInt(String(getVal(shadowDaysRows, 'days', 0)), 10);
  const total = parseInt(String(getVal(totalRows, 'cnt', 0)), 10);

  const byMode: Record<string, number> = {};
  if (modeRows.status === 'fulfilled') {
    for (const r of modeRows.value || []) byMode[r.mode] = parseInt(r.cnt || '0', 10);
  }

  const byComplexity: Record<string, number> = {};
  if (complexityRows.status === 'fulfilled') {
    for (const r of complexityRows.value || []) byComplexity[r.task_complexity] = parseInt(r.cnt || '0', 10);
  }

  const byProvider: Record<string, number> = {};
  if (providerRows.status === 'fulfilled') {
    for (const r of providerRows.value || []) byProvider[r.selected_provider] = parseInt(r.cnt || '0', 10);
  }

  const failTotal = parseInt(String(getVal(failRows, 'total', 1)), 10) || 1;
  const failCount = parseInt(String(getVal(failRows, 'failures', 0)), 10);
  const failureRate = failCount / failTotal;

  const p99LatencyMs = parseFloat(String(getVal(latencyRows, 'p99', 0)));
  const haikuCost = parseFloat(String(getVal(costRows, 'haiku_cost', 0)));
  const totalCost = parseFloat(String(getVal(costRows, 'total_cost', 0)));
  const estimatedSavingsUsd = haikuCost * 0.73; // haiku가 sonnet 대비 73% 저렴
  const manualComparisonCount = parseInt(String(getVal(manualRows, 'manual_count', 0)), 10);
  const manualAgreementCount = parseInt(String(getVal(manualRows, 'manual_agreement_count', 0)), 10);
  const manualAgreementRate = manualComparisonCount > 0 ? manualAgreementCount / manualComparisonCount : 0;

  // Promotion 체크
  const criteria = AUTO_ROUTING_PROMOTION_CRITERIA;
  const checks = [
    { name: `Shadow 관찰 기간 (${criteria.minShadowDays}일+)`, passed: shadowDays >= criteria.minShadowDays, value: `${shadowDays}일` },
    { name: `총 라우팅 건수 (${criteria.minSamples}건+)`, passed: total >= criteria.minSamples, value: `${total}건` },
    { name: '실패율 5% 미만', passed: failureRate <= criteria.maxFailureRate, value: `${(failureRate * 100).toFixed(1)}%` },
    { name: `P99 Latency ${criteria.maxP99LatencyMs}ms 이하`, passed: p99LatencyMs <= criteria.maxP99LatencyMs || p99LatencyMs === 0, value: `${p99LatencyMs.toFixed(0)}ms` },
    {
      name: `manual 비교 표본 (${criteria.minManualComparisonSamples}건+)`,
      passed: manualComparisonCount >= criteria.minManualComparisonSamples,
      value: `${manualComparisonCount}건`,
    },
    {
      name: `manual 일치율 ${(criteria.minManualAgreementRate * 100).toFixed(0)}%+`,
      passed: manualAgreementRate >= criteria.minManualAgreementRate,
      value: `${(manualAgreementRate * 100).toFixed(1)}%`,
    },
  ];

  let clusterEvaluation: ClusterPromotionEvaluation | undefined;
  if (envEnabled(env[CLUSTER_PROMOTION_ENV])) {
    const clusterRows = await queryWithFallback(pgPool, `
      SELECT
        routing_signals #>> '{cluster_recommendation,cluster_id}' AS cluster_id,
        routing_signals #>> '{cluster_recommendation,signature_key}' AS signature_key,
        routing_signals #>> '{cluster_recommendation,recommended_model}' AS recommended_model,
        routing_signals #>> '{execution,model}' AS selected_model,
        success
      FROM hub.llm_auto_routing_log
      WHERE mode = 'shadow'
        AND created_at >= $1
        AND success IS NOT NULL
        AND NULLIF(routing_signals ->> 'routing_request_id', '') IS NOT NULL
        AND NULLIF(routing_signals #>> '{cluster_recommendation,cluster_id}', '') IS NOT NULL
        AND NULLIF(routing_signals #>> '{cluster_recommendation,signature_key}', '') IS NOT NULL
        AND NULLIF(routing_signals #>> '{cluster_recommendation,recommended_model}', '') IS NOT NULL
        AND NULLIF(routing_signals #>> '{execution,model}', '') IS NOT NULL
    `, [twentyOneDaysAgo]);
    clusterEvaluation = evaluateClusterPromotion(clusterRows);
    if (clusterEvaluation.applied) checks.push(...clusterEvaluation.checks);
  }

  const blockers = checks.filter((c) => !c.passed).map((c) => c.name);
  const promotionEligible = blockers.length === 0;

  let nextStep: string;
  if (!promotionEligible) {
    nextStep = `❌ Promotion 불가 — 미충족: ${blockers.join(', ')}`;
  } else {
    nextStep = [
      '✅ LLM Auto-Routing Promotion 준비 완료! 마스터 Action:',
      '  launchctl setenv LLM_AUTO_ROUTING_ENABLED active',
      '  launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api',
    ].join('\n');
  }

  return {
    ok: true,
    ts: new Date().toISOString(),
    promotionEligible,
    shadowDays,
    stats: {
      total,
      byMode,
      byComplexity,
      byProvider,
      failureRate,
      p99LatencyMs,
      estimatedSavingsUsd,
      manualComparisonCount,
      manualAgreementRate,
    },
    checks,
    blockers,
    nextStep,
    ...(clusterEvaluation ? { clusterEvaluation } : {}),
  };
}

async function main() {
  console.log('[llm-auto-routing-promotion-evaluation] LLM Auto-Routing Promotion 평가 시작...');
  const result = await runLlmAutoRoutingPromotionEvaluation();

  const lines = [
    `Shadow 기간: ${result.shadowDays}일`,
    `총 라우팅: ${result.stats.total}건`,
    `실패율: ${(result.stats.failureRate * 100).toFixed(1)}%`,
    `P99 Latency: ${result.stats.p99LatencyMs.toFixed(0)}ms`,
    `manual 비교: ${result.stats.manualComparisonCount}건`,
    `manual 일치율: ${(result.stats.manualAgreementRate * 100).toFixed(1)}%`,
    `예상 절감: $${result.stats.estimatedSavingsUsd.toFixed(4)}`,
    '',
    '체크 목록:',
    ...result.checks.map((c) => `  ${c.passed ? '✅' : '❌'} ${c.name}: ${c.value}`),
    '',
    result.nextStep,
  ];
  console.log(lines.join('\n'));

  const outPath = '/tmp/llm-auto-routing-promotion.md';
  fs.writeFileSync(outPath, `# LLM Auto-Routing Promotion 평가\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`, 'utf8');

  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[llm-auto-routing-promotion-evaluation] 오류:', err?.message || err);
    process.exit(1);
  });
}

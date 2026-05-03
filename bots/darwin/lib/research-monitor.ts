'use strict';

/**
 * 다윈 연구 스캐너 모니터링
 */

interface RagStore {
  store: (
    category: string,
    content: string,
    metadata: Record<string, unknown>,
    source?: string
  ) => Promise<unknown>;
}

interface PgPool {
  query: (schema: string, sql: string, params?: unknown[]) => Promise<Array<{ metadata?: Record<string, unknown> }>>;
}

interface AlarmPayload {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  alarmType?: string;
  visibility?: string;
  actionability?: string;
  incidentKey?: string;
  title?: string;
  eventType?: string;
}

interface KstClient {
  today: () => string;
}

interface ScanResult {
  total?: number;
  totalRaw?: number;
  evaluated?: number;
  stored?: number;
  highRelevance?: number;
  alarmSent?: boolean;
  evaluationFailures?: number;
  keywordEvolutionCount?: number;
  proposals?: number;
  verified?: number;
}

interface ResearchMetrics {
  date: string;
  total_raw: number;
  total_collected: number;
  duplicate_rate: number;
  evaluated: number;
  effective_evaluated: number;
  stored: number;
  high_relevance: number;
  alarm_sent: boolean;
  duration_sec: number;
  evaluation_failures: number;
  relevance_rate: number;
  store_success_rate: number;
  keyword_evolution_count: number;
  proposals_generated: number;
  proposals_verified: number;
  proposal_pass_rate: number;
}

interface AnomalyRoute {
  alertLevel: number;
  alarmType: 'report' | 'error';
  visibility: 'digest' | 'notify';
  actionability: 'none' | 'needs_human';
  incidentKey: string;
  eventType: string;
  title: string;
}

const rag: RagStore = require('../../../packages/core/lib/rag');
const pgPool: PgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm }: { postAlarm: (payload: AlarmPayload) => Promise<unknown> } = require('../../../packages/core/lib/hub-alarm-client');
const kst: KstClient = require('../../../packages/core/lib/kst');

const SCHEMA = 'reservation';
const TABLE = 'rag_research';

function collectMetrics(scanResult: ScanResult, durationMs: number): ResearchMetrics {
  const totalCollected = Number(scanResult.total || 0);
  const totalRaw = Number(scanResult.totalRaw || totalCollected);
  const evaluated = Number(scanResult.evaluated || 0);
  const evaluationFailures = Number(scanResult.evaluationFailures || 0);
  const effectiveEvaluated = Math.max(0, evaluated - evaluationFailures);
  const stored = Number(scanResult.stored || 0);
  const highRelevance = Number(scanResult.highRelevance || 0);
  const duplicateRate = totalRaw > 0 ? Math.round(((totalRaw - totalCollected) / totalRaw) * 100) : 0;
  const relevanceRate = effectiveEvaluated > 0 ? Math.round((highRelevance / effectiveEvaluated) * 100) : 0;
  const storeSuccessRate = evaluated > 0 ? Math.round((stored / evaluated) * 100) : 0;

  return {
    date: kst.today(),
    total_raw: totalRaw,
    total_collected: totalCollected,
    duplicate_rate: duplicateRate,
    evaluated,
    effective_evaluated: effectiveEvaluated,
    stored,
    high_relevance: highRelevance,
    alarm_sent: scanResult.alarmSent || false,
    duration_sec: Math.round(durationMs / 1000),
    evaluation_failures: evaluationFailures,
    relevance_rate: relevanceRate,
    store_success_rate: storeSuccessRate,
    keyword_evolution_count: Number(scanResult.keywordEvolutionCount || 0),
    proposals_generated: Number(scanResult.proposals || 0),
    proposals_verified: Number(scanResult.verified || 0),
    proposal_pass_rate: Number(scanResult.proposals || 0) > 0
      ? Math.round((Number(scanResult.verified || 0) / Number(scanResult.proposals || 0)) * 100)
      : 0,
  };
}

async function storeMetrics(metrics: ResearchMetrics): Promise<void> {
  try {
    await rag.store('research', `스캔 메트릭 ${metrics.date}`, {
      type: 'daily_metrics',
      ...metrics,
    }, 'research-monitor');
  } catch (err) {
    const errorMessage =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message || 'unknown error')
        : String(err || 'unknown error');
    console.warn(`[research-monitor] 메트릭 저장 실패: ${errorMessage}`);
  }
}

async function checkAnomalies(metrics: ResearchMetrics): Promise<string[]> {
  const alerts: string[] = [];
  const evaluated = Math.max(0, Number(metrics.evaluated || 0));
  const evaluationFailures = Math.max(0, Number(metrics.evaluation_failures || 0));
  const evaluationFailureRate = evaluated > 0 ? Math.round((evaluationFailures / evaluated) * 100) : 0;
  let route: AnomalyRoute | null = null;

  function upgradeRoute(candidate: AnomalyRoute) {
    if (!route || candidate.alertLevel > route.alertLevel) {
      route = candidate;
      return;
    }
    if (candidate.alertLevel === route.alertLevel && route.visibility === 'digest' && candidate.visibility === 'notify') {
      route = candidate;
    }
  }

  if (metrics.total_collected === 0) {
    alerts.push('🚨 수집 0건! 네트워크 장애 또는 API 차단 가능');
    upgradeRoute({
      alertLevel: 3,
      alarmType: 'error',
      visibility: 'notify',
      actionability: 'needs_human',
      incidentKey: 'claude:research-monitor:collection-empty',
      eventType: 'research_monitor_collection_empty',
      title: '[다윈 리서치] 수집 0건',
    });
  }
  if (metrics.store_success_rate < 90) {
    alerts.push(`⚠️ 저장 성공률 ${metrics.store_success_rate}% (목표 95%+)`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:store-success-low',
      eventType: 'research_monitor_store_success_low',
      title: '[다윈 리서치] 저장 성공률 저하',
    });
  }
  if (metrics.duration_sec > 300) {
    alerts.push(`⚠️ 소요 시간 ${metrics.duration_sec}초 (목표 300초 이내)`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:duration-slow',
      eventType: 'research_monitor_duration_slow',
      title: '[다윈 리서치] 스캔 지연',
    });
  }
  if (metrics.relevance_rate > 80) {
    alerts.push(`⚠️ 적합성 비율 ${metrics.relevance_rate}% — 키워드가 너무 좁을 수 있음`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:keywords-too-narrow',
      eventType: 'research_monitor_keywords_too_narrow',
      title: '[다윈 리서치] 키워드 폭 점검 필요',
    });
  }
  if (evaluationFailures > 0 && evaluationFailureRate >= 20) {
    alerts.push(`⚠️ 평가 실패율 ${evaluationFailureRate}% — evaluator/parser 안정성 점검 필요`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:evaluator-instability',
      eventType: 'research_monitor_evaluator_instability',
      title: '[다윈 리서치] 평가 안정성 저하',
    });
  } else if (metrics.relevance_rate < 5 && metrics.effective_evaluated > 0) {
    alerts.push(`⚠️ 적합성 비율 ${metrics.relevance_rate}% — 키워드 튜닝 필요`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:keyword-tuning-needed',
      eventType: 'research_monitor_keyword_tuning_needed',
      title: '[다윈 리서치] 키워드 튜닝 필요',
    });
  }
  if (!metrics.alarm_sent && metrics.high_relevance > 0) {
    alerts.push('🚨 알림 전달 실패! postAlarm 점검 필요');
    upgradeRoute({
      alertLevel: 3,
      alarmType: 'error',
      visibility: 'notify',
      actionability: 'needs_human',
      incidentKey: 'claude:research-monitor:delivery-failed',
      eventType: 'research_monitor_delivery_failed',
      title: '[다윈 리서치] 후보 알림 전달 실패',
    });
  }
  if (metrics.proposals_generated > 0 && metrics.proposal_pass_rate < 30) {
    alerts.push(`⚠️ 프로토타입 검증 통과율 ${metrics.proposal_pass_rate}% — edison 프롬프트 튜닝 필요`);
    upgradeRoute({
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:proposal-pass-low',
      eventType: 'research_monitor_proposal_pass_low',
      title: '[다윈 리서치] 제안 검증 통과율 저하',
    });
  }

  if (alerts.length > 0) {
    const finalRoute = route || {
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
      incidentKey: 'claude:research-monitor:metrics-anomaly',
      eventType: 'research_monitor_metrics_anomaly',
      title: '[다윈 리서치] 메트릭 이상 감지',
    };
    await postAlarm({
      message: `🔍 다윈 연구 모니터링 이상 감지\n${alerts.join('\n')}\n\n메트릭: ${JSON.stringify(metrics)}`,
      team: 'claude',
      alertLevel: finalRoute.alertLevel,
      fromBot: 'research-monitor',
      alarmType: finalRoute.alarmType,
      visibility: finalRoute.visibility,
      actionability: finalRoute.actionability,
      incidentKey: finalRoute.incidentKey,
      title: finalRoute.title,
      eventType: finalRoute.eventType,
    });
  }

  return alerts;
}

async function weeklyTrend(): Promise<string> {
  const rows = await pgPool.query(SCHEMA, `
    SELECT metadata
    FROM ${SCHEMA}.${TABLE}
    WHERE created_at >= now() - interval '14 days'
      AND metadata->>'type' = 'daily_metrics'
    ORDER BY created_at ASC
  `, []);

  if (!rows || rows.length < 3) return '데이터 부족 (3일 이상 필요)';

  const avgCollected = Math.round(rows.reduce((sum, row) => sum + Number(row.metadata?.total_collected || 0), 0) / rows.length);
  const avgRelevance = Math.round(rows.reduce((sum, row) => sum + Number(row.metadata?.relevance_rate || 0), 0) / rows.length);
  const avgDuration = Math.round(rows.reduce((sum, row) => sum + Number(row.metadata?.duration_sec || 0), 0) / rows.length);

  return [
    `📊 주간 트렌드 (${rows.length}일 평균)`,
    `  수집: ${avgCollected}건/일`,
    `  적합률: ${avgRelevance}%`,
    `  소요: ${avgDuration}초`,
  ].join('\n');
}

module.exports = {
  collectMetrics,
  storeMetrics,
  checkAnomalies,
  weeklyTrend,
};

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

const rag: RagStore = require('../../../packages/core/lib/rag');
const pgPool: PgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm }: { postAlarm: (payload: AlarmPayload) => Promise<unknown> } = require('../../../packages/core/lib/openclaw-client');
const kst: KstClient = require('../../../packages/core/lib/kst');

const SCHEMA = 'reservation';
const TABLE = 'rag_research';

function collectMetrics(scanResult: ScanResult, durationMs: number): ResearchMetrics {
  const totalCollected = Number(scanResult.total || 0);
  const totalRaw = Number(scanResult.totalRaw || totalCollected);
  const evaluated = Number(scanResult.evaluated || 0);
  const stored = Number(scanResult.stored || 0);
  const highRelevance = Number(scanResult.highRelevance || 0);
  const duplicateRate = totalRaw > 0 ? Math.round(((totalRaw - totalCollected) / totalRaw) * 100) : 0;
  const relevanceRate = evaluated > 0 ? Math.round((highRelevance / evaluated) * 100) : 0;
  const storeSuccessRate = evaluated > 0 ? Math.round((stored / evaluated) * 100) : 0;

  return {
    date: kst.today(),
    total_raw: totalRaw,
    total_collected: totalCollected,
    duplicate_rate: duplicateRate,
    evaluated,
    stored,
    high_relevance: highRelevance,
    alarm_sent: scanResult.alarmSent || false,
    duration_sec: Math.round(durationMs / 1000),
    evaluation_failures: Number(scanResult.evaluationFailures || 0),
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

  if (metrics.total_collected === 0) alerts.push('🚨 수집 0건! 네트워크 장애 또는 API 차단 가능');
  if (metrics.store_success_rate < 90) alerts.push(`⚠️ 저장 성공률 ${metrics.store_success_rate}% (목표 95%+)`);
  if (metrics.duration_sec > 300) alerts.push(`⚠️ 소요 시간 ${metrics.duration_sec}초 (목표 300초 이내)`);
  if (metrics.relevance_rate > 80) alerts.push(`⚠️ 적합성 비율 ${metrics.relevance_rate}% — 키워드가 너무 좁을 수 있음`);
  if (metrics.relevance_rate < 5 && metrics.evaluated > 0) alerts.push(`⚠️ 적합성 비율 ${metrics.relevance_rate}% — 키워드 튜닝 필요`);
  if (!metrics.alarm_sent && metrics.high_relevance > 0) alerts.push('🚨 알림 전달 실패! postAlarm 점검 필요');
  if (metrics.proposals_generated > 0 && metrics.proposal_pass_rate < 30) {
    alerts.push(`⚠️ 프로토타입 검증 통과율 ${metrics.proposal_pass_rate}% — edison 프롬프트 튜닝 필요`);
  }

  if (alerts.length > 0) {
    await postAlarm({
      message: `🔍 다윈 연구 모니터링 이상 감지\n${alerts.join('\n')}\n\n메트릭: ${JSON.stringify(metrics)}`,
      team: 'claude',
      alertLevel: alerts.some((alert) => alert.startsWith('🚨')) ? 3 : 2,
      fromBot: 'research-monitor',
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

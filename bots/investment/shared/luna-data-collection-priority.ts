// @ts-nocheck
/**
 * Luna Data Collection Priority
 *
 * 마스터 철학: "거래 = 데이터 수집 도구"
 * - 모든 거래 시도(성공/실패)를 학습 데이터로 수집
 * - 가드는 "경고 + 기록"이지 "차단"이 아님
 * - 실패도 귀중한 데이터: luna_failure_reflexions에 자동 기록
 */

import * as db from './db/core.ts';
import { getMarketExecutionModeInfo } from './secrets.ts';

// ─── 타입 정의 ─────────────────────────────────────────────────

export interface TradeAttemptRecord {
  tradeId?: string;
  market: 'crypto' | 'stocks' | 'overseas';
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price?: number;
  paper: boolean;

  // 가드/검증 결과 (실패해도 기록)
  guardResults: GuardCheckResult[];
  allGuardsPassed: boolean;
  blockedBy?: string;     // 어떤 가드가 경고했는지

  // 실행 결과
  executionSuccess?: boolean;
  executionError?: string;
  orderId?: string;

  // 분석 컨텍스트 (학습용)
  signalSources: string[];
  confidence: number;
  regime?: string;
  fundamentalScore?: number;
  technicalScore?: number;
  sentimentScore?: number;

  attemptedAt: string;
}

export interface GuardCheckResult {
  guardName: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  value?: number;
  threshold?: number;
}

export interface DataCollectionResult {
  collected: boolean;
  signalId?: number;
  reflexionId?: number;
  warnings: string[];
}

// ─── 핵심: 가드 결과를 "차단"이 아닌 "데이터"로 처리 ─────────────

/**
 * 가드 체크 — 실패해도 데이터 수집 후 계속 진행
 * 마스터 철학: 가드 = 알림 + 기록 (거래 막기 X)
 */
export async function runGuardAsDataCollection(
  checks: Array<() => GuardCheckResult | Promise<GuardCheckResult>>,
  context: { symbol: string; market: string; side: string }
): Promise<{ results: GuardCheckResult[]; allPassed: boolean; criticalFailed: boolean }> {
  const results: GuardCheckResult[] = [];

  for (const check of checks) {
    try {
      const result = await check();
      results.push(result);
      if (!result.passed) {
        console.log(`[DataCollection] ⚠️ 가드 경고 (차단 X): ${result.guardName} — ${result.message}`);
      }
    } catch (err) {
      results.push({
        guardName: 'unknown',
        passed: false,
        severity: 'warning',
        message: `가드 실행 오류: ${err?.message || err}`,
      });
    }
  }

  const allPassed = results.every(r => r.passed);
  // critical severity만 실제 차단 허용 (나머지는 데이터 수집 후 진행)
  const criticalFailed = results.some(r => !r.passed && r.severity === 'critical');

  return { results, allPassed, criticalFailed };
}

// ─── 거래 시도 기록 (성공/실패 무관) ─────────────────────────────

/**
 * 모든 거래 시도를 position_signal_history에 기록
 * 성공/실패 무관 — 데이터가 곧 자산
 */
export async function recordTradeAttempt(record: TradeAttemptRecord): Promise<DataCollectionResult> {
  const warnings: string[] = [];
  let signalId: number | undefined;
  let reflexionId: number | undefined;

  // 1. position_signal_history에 항상 기록
  try {
    const res = await db.query(`
      INSERT INTO investment.position_signal_history (
        exchange, symbol, market, trade_mode, source, event_type,
        confidence, sentiment_score, evidence_snapshot, quality_flags, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW()
      ) RETURNING id
    `, [
      record.exchange,
      record.symbol,
      record.market,
      record.paper ? 'paper' : 'live',
      record.signalSources.join(',') || 'data-collection',
      record.executionSuccess === false ? 'trade_failed' : (record.blockedBy ? 'guard_warned' : 'trade_attempted'),
      record.confidence,
      record.sentimentScore ?? null,
      JSON.stringify({
        side: record.side,
        size: record.size,
        price: record.price,
        guardResults: record.guardResults,
        allGuardsPassed: record.allGuardsPassed,
        blockedBy: record.blockedBy,
        executionSuccess: record.executionSuccess,
        executionError: record.executionError,
        orderId: record.orderId,
        regime: record.regime,
        fundamentalScore: record.fundamentalScore,
        technicalScore: record.technicalScore,
      }),
      record.guardResults.filter(g => !g.passed).map(g => `guard_warn:${g.guardName}`),
    ]);
    signalId = res.rows[0]?.id;
  } catch (err) {
    warnings.push(`position_signal_history 기록 실패: ${err?.message}`);
    console.error('[DataCollection] signal 기록 오류:', err?.message);
  }

  // 2. 실패한 거래 → luna_failure_reflexions 자동 생성 (학습!)
  if (record.executionSuccess === false && record.tradeId) {
    try {
      const failedGuards = record.guardResults.filter(g => !g.passed);
      const fiveWhy = buildFiveWhy(record, failedGuards);

      const res = await db.query(`
        INSERT INTO investment.luna_failure_reflexions (
          trade_id, five_why, stage_attribution, hindsight, avoid_pattern, created_at
        ) VALUES (
          $1, $2::jsonb, $3::jsonb, $4, $5::jsonb, NOW()
        )
        ON CONFLICT (trade_id) DO NOTHING
        RETURNING id
      `, [
        record.tradeId,
        JSON.stringify(fiveWhy),
        JSON.stringify({
          guard_results: failedGuards.map(g => g.guardName),
          execution_stage: 'order_submission',
          error: record.executionError,
        }),
        `거래 실패: ${record.executionError || record.blockedBy || '알 수 없음'}. 다음 기회에 활용.`,
        JSON.stringify({
          symbol: record.symbol,
          side: record.side,
          regime: record.regime,
          failed_guards: failedGuards.map(g => ({ name: g.guardName, threshold: g.threshold, value: g.value })),
        }),
      ]);
      reflexionId = res.rows[0]?.id;
      console.log(`[DataCollection] 📚 실패 반성 기록: trade_id=${record.tradeId}`);
    } catch (err) {
      warnings.push(`luna_failure_reflexions 기록 실패: ${err?.message}`);
    }
  }

  return { collected: !!signalId, signalId, reflexionId, warnings };
}

// ─── 실매매 모드 정보 + 데이터 수집 상태 ─────────────────────────

export interface LiveTradingDataStatus {
  paper: boolean;
  market: string;
  exchange: string;
  dataCollectionEnabled: boolean;
  todaySignalCount: number;
  todayFailedCount: number;
  learningRate: string;   // 'active' | 'warm-up' | 'insufficient'
  message: string;
}

export async function getLiveTradingDataStatus(marketType = 'crypto'): Promise<LiveTradingDataStatus> {
  const modeInfo = getMarketExecutionModeInfo(marketType);

  let todaySignalCount = 0;
  let todayFailedCount = 0;

  try {
    const res = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type != 'trade_failed') AS signal_count,
        COUNT(*) FILTER (WHERE event_type = 'trade_failed') AS failed_count
      FROM investment.position_signal_history
      WHERE market = $1 AND created_at >= CURRENT_DATE
    `, [modeInfo.marketType]);
    todaySignalCount = Number(res.rows[0]?.signal_count ?? 0);
    todayFailedCount = Number(res.rows[0]?.failed_count ?? 0);
  } catch (_err) {
    // DB 접근 불가 시 0으로 유지
  }

  const learningRate = todaySignalCount >= 10
    ? 'active'
    : todaySignalCount >= 3
      ? 'warm-up'
      : 'insufficient';

  return {
    paper: modeInfo.paper,
    market: modeInfo.marketType,
    exchange: modeInfo.broker,
    dataCollectionEnabled: true,
    todaySignalCount,
    todayFailedCount,
    learningRate,
    message: modeInfo.paper
      ? `[PAPER] 데이터 수집 중 — 오늘 ${todaySignalCount}건 (실패 ${todayFailedCount}건 포함)`
      : `[LIVE] 실매매 + 데이터 수집 — 오늘 ${todaySignalCount}건 (실패 ${todayFailedCount}건 포함)`,
  };
}

// ─── 내부 헬퍼 ──────────────────────────────────────────────────

function buildFiveWhy(record: TradeAttemptRecord, failedGuards: GuardCheckResult[]): string[] {
  const whys: string[] = [];

  if (record.executionError) {
    whys.push(`Why 1: 실행 오류 — ${record.executionError}`);
  }
  if (failedGuards.length > 0) {
    whys.push(`Why 2: 가드 경고 — ${failedGuards.map(g => g.guardName).join(', ')}`);
    const firstFailed = failedGuards[0];
    if (firstFailed.value !== undefined && firstFailed.threshold !== undefined) {
      whys.push(`Why 3: ${firstFailed.guardName} 값(${firstFailed.value}) vs 임계값(${firstFailed.threshold})`);
    }
  }
  if (record.regime) {
    whys.push(`Why 4: 시장 레짐 — ${record.regime} 에서 ${record.side} 시도`);
  }
  whys.push(`Why 5: 신호 소스 — ${record.signalSources.join(', ')} (신뢰도 ${record.confidence})`);

  return whys.slice(0, 5);
}

// ─── 데이터 수집 요약 리포트 ────────────────────────────────────

export async function buildDailyDataCollectionReport(market: string): Promise<string> {
  try {
    const res = await db.query(`
      SELECT
        event_type,
        COUNT(*) AS cnt,
        AVG(confidence) AS avg_confidence,
        COUNT(*) FILTER (WHERE quality_flags != '{}') AS flagged_count
      FROM investment.position_signal_history
      WHERE market = $1 AND created_at >= CURRENT_DATE
      GROUP BY event_type
      ORDER BY cnt DESC
    `, [market]);

    if (res.rows.length === 0) {
      return `[DataCollection] ${market} 오늘 수집 데이터 없음`;
    }

    const lines = res.rows.map(r =>
      `  ${r.event_type}: ${r.cnt}건 (평균신뢰도 ${Number(r.avg_confidence ?? 0).toFixed(2)}, 플래그 ${r.flagged_count}건)`
    );

    return [
      `[DataCollection] ${market} 일일 데이터 수집 현황:`,
      ...lines,
    ].join('\n');
  } catch (err) {
    return `[DataCollection] 리포트 생성 오류: ${err?.message}`;
  }
}

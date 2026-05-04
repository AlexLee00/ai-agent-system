// @ts-nocheck
/**
 * shared/strategy-family-classifier.ts — strategy_family 자동 라벨링
 *
 * 분석 결과: 76% 거래가 strategy_family NULL → 학습 데이터 활용도 저하.
 * 이 모듈은 진입 컨텍스트(reasoning, regime, analyst signals)에서
 * strategy_family를 결정론적으로 분류한다.
 *
 * 지원 family:
 *   momentum_rotation   — 추세 momentum, fast-path
 *   trend_following     — 추세 추종, pullback
 *   breakout            — 돌파, squeeze, 거래량 급증
 *   mean_reversion      — 반등, 되돌림, oversold
 *   equity_swing        — 국내/해외 주식 스윙
 *   defensive_rotation  — 방어적 로테이션 (bear/volatile)
 *   short_term_scalping — 단기 스캘핑 (1일 이내, 4h 이하)
 *   micro_swing         — 단기 스윙 (1-3일, 4h~1d)
 */

// ── 타입 ─────────────────────────────────────────────────

export type StrategyFamily =
  | 'momentum_rotation'
  | 'trend_following'
  | 'breakout'
  | 'mean_reversion'
  | 'equity_swing'
  | 'defensive_rotation'
  | 'short_term_scalping'
  | 'micro_swing';

export interface ClassifyInput {
  /** reasoning 텍스트 (루나 결정 이유) */
  reasoning?: string | null;
  /** 시장 구분: 'crypto' | 'domestic' | 'overseas' */
  market?: string | null;
  /** 거래소: 'binance' | 'kis' | etc. */
  exchange?: string | null;
  /** market_regime */
  regime?: string | null;
  /** 애널리스트 신호 맵 또는 파이프 구분 문자열 ('A:B|O:S|...') */
  analystSignals?: Record<string, string> | string | null;
  /** 전략 이름 */
  strategyName?: string | null;
  /** 전략 요약 */
  strategySummary?: string | null;
  /** 적용 타임프레임 */
  timeframe?: string | null;
  /** confidence */
  confidence?: number | null;
  /** strategy_route (기존 라우터 결과 활용) */
  strategyRoute?: { setupType?: string; selectedFamily?: string } | null;
}

export interface ClassifyResult {
  family: StrategyFamily;
  /** 분류 근거 */
  source: 'strategy_route' | 'keyword' | 'regime_default' | 'market_default';
  confidence: 'high' | 'medium' | 'low';
}

// ── 내부 유틸 ─────────────────────────────────────────────

const VALID_FAMILIES = new Set<string>([
  'momentum_rotation', 'trend_following', 'breakout',
  'mean_reversion', 'equity_swing', 'defensive_rotation',
  'short_term_scalping', 'micro_swing',
]);

function normalizeFamily(raw: string | null | undefined): StrategyFamily | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (VALID_FAMILIES.has(s)) return s as StrategyFamily;
  if (s.includes('momentum')) return 'momentum_rotation';
  if (s.includes('trend')) return 'trend_following';
  if (s.includes('break')) return 'breakout';
  if (s.includes('mean') || s.includes('reversion')) return 'mean_reversion';
  if (s.includes('swing')) return 'equity_swing';
  if (s.includes('defensive') || s.includes('rotation')) return 'defensive_rotation';
  if (s.includes('scalp')) return 'short_term_scalping';
  if (s.includes('micro')) return 'micro_swing';
  return null;
}

function parseAnalystSignals(raw: Record<string, string> | string | null): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const result: Record<string, string> = {};
  for (const part of String(raw).split('|')) {
    const [name, signal] = part.split(':');
    if (name && signal) result[name.trim()] = signal.trim().toUpperCase();
  }
  return result;
}

function isShortTermTimeframe(tf: string | null | undefined): boolean {
  const s = String(tf || '').toLowerCase();
  return s.includes('15m') || s.includes('30m') || s.includes('1h') || s === '4h';
}

// ── 핵심 분류 ─────────────────────────────────────────────

/**
 * 진입 컨텍스트에서 strategy_family를 결정.
 * NULL 없이 항상 값을 반환한다.
 */
export function classifyStrategyFamily(input: ClassifyInput): ClassifyResult {
  const exchange = String(input.exchange || '').toLowerCase();
  const market = String(input.market || '').toLowerCase();
  const regime = String(input.regime || '').toLowerCase();
  const isCrypto = market === 'crypto' || exchange === 'binance';
  const isDomestic = market === 'domestic' || market === 'overseas' || exchange === 'kis';

  // 1. strategy_route에서 이미 분류된 값 우선 사용
  const routeFamily = normalizeFamily(
    input.strategyRoute?.selectedFamily || input.strategyRoute?.setupType,
  );
  if (routeFamily) {
    return { family: routeFamily, source: 'strategy_route', confidence: 'high' };
  }

  // 2. reasoning + strategyName 키워드 분류
  const text = [
    input.reasoning,
    input.strategyName,
    input.strategySummary,
  ].filter(Boolean).join(' ').toLowerCase();

  if (text) {
    // 단타 키워드 (타임프레임 우선 확인)
    if (isShortTermTimeframe(input.timeframe)) {
      if (text.includes('scalp') || text.includes('단타') || text.includes('스캘핑')) {
        return { family: 'short_term_scalping', source: 'keyword', confidence: 'high' };
      }
      if (text.includes('micro') || text.includes('단기')) {
        return { family: 'micro_swing', source: 'keyword', confidence: 'medium' };
      }
    }

    // 방어적 패턴
    if (
      text.includes('defensive') || text.includes('방어')
      || text.includes('protective') || text.includes('hedge')
      || (regime === 'trending_bear' && isDomestic)
    ) {
      return { family: 'defensive_rotation', source: 'keyword', confidence: 'medium' };
    }

    // mean reversion
    if (
      text.includes('반등') || text.includes('oversold')
      || text.includes('되돌림') || text.includes('mean reversion')
      || text.includes('support bounce') || text.includes('rsi oversold')
    ) {
      return { family: 'mean_reversion', source: 'keyword', confidence: 'high' };
    }

    // breakout
    if (
      text.includes('돌파') || text.includes('breakout')
      || text.includes('squeeze') || text.includes('volume expansion')
      || text.includes('거래량 급증') || text.includes('consolidation break')
    ) {
      return { family: 'breakout', source: 'keyword', confidence: 'high' };
    }

    // trend following
    if (
      text.includes('trend following') || text.includes('추세 추종')
      || text.includes('pullback') || text.includes('higher high')
      || text.includes('bullish trend')
    ) {
      return {
        family: isCrypto ? 'trend_following' : 'equity_swing',
        source: 'keyword',
        confidence: 'high',
      };
    }

    // momentum
    if (
      text.includes('momentum') || text.includes('fast-path')
      || text.includes('relative strength') || text.includes('모멘텀')
    ) {
      return { family: 'momentum_rotation', source: 'keyword', confidence: 'high' };
    }

    // swing (국내/해외)
    if (text.includes('swing') || text.includes('스윙') || text.includes('equity')) {
      return { family: 'equity_swing', source: 'keyword', confidence: 'medium' };
    }
  }

  // 3. analyst signal 기반 추론
  const signals = parseAnalystSignals(input.analystSignals);
  const bullishVotes = Object.values(signals).filter(s => s === 'B').length;
  const confidence = Math.max(0, Number(input.confidence || 0));

  if (bullishVotes >= 3 && confidence >= 0.62 && isCrypto) {
    return { family: 'trend_following', source: 'keyword', confidence: 'medium' };
  }

  // 4. regime 기반 기본값
  if (regime === 'trending_bear' || regime === 'volatile') {
    return {
      family: isDomestic ? 'defensive_rotation' : 'mean_reversion',
      source: 'regime_default',
      confidence: 'low',
    };
  }
  if (regime === 'ranging') {
    return { family: 'mean_reversion', source: 'regime_default', confidence: 'low' };
  }

  // 5. 시장별 최종 기본값
  return {
    family: isDomestic ? 'equity_swing' : 'momentum_rotation',
    source: 'market_default',
    confidence: 'low',
  };
}

/**
 * DB에서 strategy_family가 NULL인 trade_journal을 재분류해 업데이트.
 * 배치 백필 용도.
 */
export async function backfillStrategyFamilies(
  db: { query: Function; run: Function },
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<{ updated: number; skipped: number }> {
  const limit = opts.limit ?? 500;

  const rows = await db.query(`
    SELECT
      j.id, j.symbol, j.market, j.exchange,
      j.market_regime,
      tr.reasoning, tr.strategy_config
    FROM investment.trade_journal j
    LEFT JOIN investment.trade_rationale tr ON tr.trade_id = j.id
    WHERE COALESCE(j.strategy_family, '') = ''
    ORDER BY j.id DESC
    LIMIT $1
  `, [limit]);

  let updated = 0;
  let skipped = 0;

  for (const row of (rows || [])) {
    const strategyConfig = row.strategy_config || {};
    const result = classifyStrategyFamily({
      reasoning: row.reasoning,
      market: row.market,
      exchange: row.exchange,
      regime: row.market_regime,
      strategyName: strategyConfig.strategy_name,
      strategySummary: strategyConfig.summary,
      timeframe: strategyConfig.applicable_timeframe,
      strategyRoute: strategyConfig.strategyRoute,
    });

    if (result.source === 'market_default') {
      // 근거 없는 기본값은 스킵 (낮은 신뢰도)
      skipped++;
      continue;
    }

    if (!opts.dryRun) {
      await db.run(
        `UPDATE investment.trade_journal SET strategy_family = $1 WHERE id = $2 AND COALESCE(strategy_family, '') = ''`,
        [result.family, row.id],
      );
    }
    updated++;
  }

  return { updated, skipped };
}

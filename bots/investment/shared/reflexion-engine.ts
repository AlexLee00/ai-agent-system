// @ts-nocheck
/**
 * shared/reflexion-engine.ts — Phase C: Reflexion + Chain-of-Hindsight
 *
 * 실패한 거래(score < 0.4)에 대해:
 *   1. 5-Why 분석 (왜 실패했나 → 원인 → 더 깊은 원인)
 *   2. Stage Attribution (어느 단계가 가장 영향 컸는가)
 *   3. Hindsight Generation (CoH 패턴: "X 대신 Y를 했어야 했다")
 *   4. Avoid Pattern 추출 → luna_failure_reflexions 저장
 *   5. 다음 진입 시점에서 유사 패턴 retrieval
 *
 * 참조: Reflexion (Shinn et al. 2023), Chain-of-Hindsight (Berkeley 2023)
 */

import * as db from './db.ts';
import { callLLM } from './llm-client.ts';
import type { TradeQualityResult } from './trade-quality-evaluator.ts';
import type { StageAttribution } from './stage-attribution-analyzer.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';

export interface ReflexionResult {
  trade_id: number;
  five_why: Array<{ q: string; a: string }>;
  stage_attribution: Record<string, number>;
  hindsight: string;
  avoid_pattern: {
    symbol_pattern: string;
    avoid_action: string;
    reason: string;
    evidence: number[];
  };
}

/**
 * 거래 결과를 바탕으로 Reflexion을 수행한다.
 * rejected(overall_score ≤ 0.4) 거래에 대해서만 실행.
 */
export async function runReflexion(
  quality: TradeQualityResult,
  stageAttrs: StageAttribution[],
  opts: { dryRun?: boolean } = {}
): Promise<ReflexionResult | null> {
  if (quality.category !== 'rejected') return null;

  const trade    = await fetchTradeDetail(quality.trade_id);
  if (!trade) return null;

  const result   = await llmReflect(trade, quality, stageAttrs);
  if (!result) return null;

  if (!opts.dryRun) {
    await persistReflexion(result);
    await db.run(
      `INSERT INTO investment.mapek_knowledge (event_type, payload)
       VALUES ('reflexion_created', $1)`,
      [JSON.stringify({
        trade_id: quality.trade_id,
        category: quality.category,
        hindsight: result.hindsight,
        created_at: new Date().toISOString(),
      })],
    ).catch(() => {});
  }

  return result;
}

/**
 * 다음 진입 시 유사한 실패 패턴이 있는지 검색.
 * confidence_penalty를 반환: 매칭 시 -0.10 적용 권장.
 */
export async function checkAvoidPatterns(
  symbol: string,
  market: string,
  direction: string,
  regime: string = ''
): Promise<{ matched: boolean; penalty: number; reason: string }> {
  const penalty = Number(getPosttradeFeedbackRuntimeConfig()?.reflexion?.avoid_pattern_penalty || 0.10);
  const rows = await db.query(`
    SELECT id, avoid_pattern, trade_id
    FROM investment.luna_failure_reflexions
    WHERE avoid_pattern->>'avoid_action' = $1
      AND (
        avoid_pattern->>'symbol_pattern' ILIKE '%' || $2 || '%'
        OR avoid_pattern->>'symbol_pattern' ILIKE '%' || $3 || '%'
      )
    ORDER BY created_at DESC
    LIMIT 5
  `, [
    direction === 'long' ? 'long_entry' : 'short_entry',
    symbol.split('/')[0] ?? symbol,
    market,
  ]);

  if (rows.length === 0) return { matched: false, penalty: 0, reason: '' };

  const latest = rows[0] as any;
  const pattern = typeof latest.avoid_pattern === 'string'
    ? JSON.parse(latest.avoid_pattern)
    : latest.avoid_pattern;

  return {
    matched: true,
    penalty,
    reason: pattern?.reason ?? '이전 유사 실패 패턴 감지',
  };
}

/**
 * 모든 avoid_pattern 목록 반환 (Voyager skill library 연계).
 */
export async function getAllAvoidPatterns(limit = 50) {
  return db.query(`
    SELECT id, trade_id, avoid_pattern, hindsight, created_at
    FROM investment.luna_failure_reflexions
    WHERE avoid_pattern IS NOT NULL
      AND avoid_pattern != '{}'
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
}

// ─── Private ─────────────────────────────────────────────────────────────────

async function fetchTradeDetail(tradeId: number) {
  return db.get(`
    SELECT th.id, th.symbol, th.market, th.direction,
           th.entry_price, th.exit_price, th.entry_at, th.exit_at,
           th.exit_reason, th.setup_type, th.exchange,
           tr.regime, tr.strategy_family, tr.analyst_accuracy
    FROM investment.trade_history th
    LEFT JOIN investment.trade_review tr ON tr.trade_id = th.id
    WHERE th.id = $1
  `, [tradeId]);
}

async function llmReflect(
  trade: any,
  quality: TradeQualityResult,
  stageAttrs: StageAttribution[]
): Promise<ReflexionResult | null> {
  // 가장 낮은 contribution stage 추출 (상위 3개)
  const worstStages = [...stageAttrs]
    .sort((a, b) => a.contribution_to_outcome - b.contribution_to_outcome)
    .slice(0, 3)
    .map(s => `${s.stage_id}(기여도:${s.contribution_to_outcome.toFixed(3)})`);

  const systemPrompt = `당신은 퀀트 트레이딩 전문 반성 코치입니다.
실패한 거래를 분석하여 학습 가능한 인사이트를 추출합니다.
반드시 JSON 형식으로만 답하세요.`;

  const userPrompt = `
## 실패 거래 분석 요청
- 심볼: ${trade.symbol} | 시장: ${trade.market} | 방향: ${trade.direction}
- PnL 품질 점수: ${quality.overall_score.toFixed(3)} (rejected 분류)
- 청산 이유: ${trade.exit_reason}
- 셋업: ${trade.setup_type ?? '?'} | 레지임: ${trade.regime ?? '?'}

## 4-차원 점수 분해
- 매매 적절성:        ${quality.market_decision_score.toFixed(3)}
- 파이프라인 품질:    ${quality.pipeline_quality_score.toFixed(3)}
- 모니터링 충실도:    ${quality.monitoring_score.toFixed(3)}
- 백테스팅 활용도:    ${quality.backtest_utilization_score.toFixed(3)}

## 최악 단계 (기여도 하위)
${worstStages.join(', ')}

---

다음 3가지를 생성하세요:

1. **five_why**: 실패 원인을 5단계로 파고드는 Q&A 배열 (각 질문-답변 쌍)
2. **hindsight**: "이 상황에서는 X 대신 Y를 했어야 했다" 형식의 1~2문장
3. **avoid_pattern**: 다음 거래에서 회피해야 할 패턴
   - symbol_pattern: 어떤 심볼/조건 (예: "BTC/* funding>0.1", "domestic/*/재무이상")
   - avoid_action: "long_entry" 또는 "short_entry" 또는 "hold_extended"
   - reason: 회피 이유 (한국어 1문장)

JSON:
{
  "five_why": [
    {"q": "왜 실패했나?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."}
  ],
  "hindsight": "...",
  "avoid_pattern": {
    "symbol_pattern": "...",
    "avoid_action": "long_entry",
    "reason": "..."
  }
}`;

  try {
    const text = await callLLM('luna.reflexion_coach', systemPrompt, userPrompt, 768, {
      market: trade.market,
      symbol: trade.symbol,
    });

    const parsed = parseJson(text);
    if (!parsed) return null;

    return {
      trade_id: quality.trade_id,
      five_why: parsed.five_why ?? [],
      stage_attribution: buildStageMap(stageAttrs),
      hindsight: parsed.hindsight ?? '',
      avoid_pattern: {
        ...(parsed.avoid_pattern ?? {}),
        evidence: [quality.trade_id],
      },
    };
  } catch (err) {
    console.error(`[ReflexionEngine] LLM 반성 실패 trade_id=${quality.trade_id}:`, err);
    return null;
  }
}

async function persistReflexion(result: ReflexionResult) {
  await db.run(`
    INSERT INTO investment.luna_failure_reflexions
      (trade_id, five_why, stage_attribution, hindsight, avoid_pattern)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (trade_id) DO UPDATE SET
      five_why = EXCLUDED.five_why,
      stage_attribution = EXCLUDED.stage_attribution,
      hindsight = EXCLUDED.hindsight,
      avoid_pattern = EXCLUDED.avoid_pattern,
      created_at = NOW()
  `, [
    result.trade_id,
    JSON.stringify(result.five_why),
    JSON.stringify(result.stage_attribution),
    result.hindsight,
    JSON.stringify(result.avoid_pattern),
  ]);
}

function buildStageMap(attrs: StageAttribution[]): Record<string, number> {
  return Object.fromEntries(attrs.map(a => [a.stage_id, a.contribution_to_outcome]));
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}

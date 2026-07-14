// @ts-nocheck

import * as db from './db/core.ts';
import { callLLM } from './llm-client.ts';
import { isAnalystPredictionCorrect } from './analyst-prediction-correctness.ts';
import {
  buildLunaReflectionDedupeReason,
  isLunaReflectionDuplicateReason,
  lunaReflectionReasonSimilarity as reflectionReasonSimilarity,
  normalizeLunaMarketKey,
  normalizeLunaReflectionText as normalizeTradeReflectionText,
  resolveLunaAnalystCallAccuracy,
} from './luna-data-contracts.ts';

export { isAnalystPredictionCorrect } from './analyst-prediction-correctness.ts';
export {
  lunaReflectionReasonSimilarity as reflectionReasonSimilarity,
  normalizeLunaReflectionText as normalizeTradeReflectionText,
} from './luna-data-contracts.ts';

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fallbackReflection(payload) {
  const scoredCalls = (payload.analystCalls || [])
    .map((call) => ({ call, accurate: resolveLunaAnalystCallAccuracy(call, payload) }))
    .filter(({ accurate }) => accurate !== null);
  const correct = scoredCalls
    .filter(({ accurate }) => accurate === true)
    .map(({ call }) => call.botName);
  const incorrect = scoredCalls
    .filter(({ accurate }) => accurate === false)
    .map(({ call }) => call.botName);
  const profitable = Number(payload.pnlPct) > 0;
  const result = profitable ? '수익 결과와 일치했습니다' : '손실 결과와 어긋났습니다';
  const calls = [
    correct.length ? `${correct.join(', ')} 판단은 맞았습니다` : '',
    incorrect.length ? `${incorrect.join(', ')} 판단은 틀렸습니다` : '',
  ].filter(Boolean).join(' ').trim();
  return normalizeTradeReflectionText(
    `${calls || `진입 판단은 ${result}`}. 다음에는 ${payload.regime || '현재'} 레짐과 ${payload.strategyProfile || '진입'} 셋업의 일치 여부를 먼저 확인합니다.`,
  );
}

async function findDuplicateReflection(queryFn, payload, reason) {
  const rows = await Promise.resolve(queryFn(
    `SELECT trade_id, sub_score_breakdown->'reflection' AS reflection
       FROM investment.trade_quality_evaluations
      WHERE trade_id <> $1
        AND jsonb_typeof(sub_score_breakdown->'reflection') = 'object'
        AND UPPER(sub_score_breakdown->'reflection'->>'symbol') = UPPER($2)
      ORDER BY evaluated_at DESC
      LIMIT 20`,
    [payload.tradeId, payload.symbol],
  )).catch(() => []);
  for (const row of Array.isArray(rows) ? rows : []) {
    const reflection = parseJsonObject(row.reflection);
    if (!reflection.text || !reflection.reason) continue;
    if (isLunaReflectionDuplicateReason(reason, reflection.reason)) {
      return { tradeId: row.trade_id, reflection };
    }
  }
  return null;
}

export async function generateAndPersistTradeReflection(payload, deps = {}) {
  const queryFn = deps.query || db.query;
  const runFn = deps.run || db.run;
  const llmCaller = deps.callLLM || callLLM;
  const reason = buildLunaReflectionDedupeReason(payload);
  const duplicate = await findDuplicateReflection(queryFn, payload, reason);
  let source = 'deduplicated';
  let text = duplicate ? normalizeTradeReflectionText(duplicate.reflection.text) : '';

  if (!duplicate) {
    try {
      const response = await llmCaller(
        'luna.reflexion_coach',
        '거래 사후 회고 코치다. 맞은 판단, 틀린 판단, 다음에 확인할 항목을 한국어 1~3문장으로만 작성한다.',
        JSON.stringify({
          symbol: payload.symbol,
          side: payload.side,
          pnlPct: payload.pnlPct,
          regime: payload.regime || null,
          setupType: payload.strategyProfile || null,
          analystCalls: payload.analystCalls || [],
        }),
        256,
        {
          market: payload.market,
          symbol: payload.symbol,
          taskType: 'posttrade_reflection',
          timeoutMs: 20_000,
        },
      );
      text = normalizeTradeReflectionText(response);
      source = text ? 'llm' : 'rule_based_fallback';
    } catch {
      source = 'rule_based_fallback';
    }
  }
  if (!text) text = fallbackReflection(payload);

  const reflection = {
    text,
    reason,
    symbol: payload.symbol,
    market: normalizeLunaMarketKey(payload.market),
    side: payload.side,
    regime: payload.regime || null,
    setupType: payload.strategyProfile || null,
    outcome: Number(payload.pnlPct) > 0 ? 'correct' : 'incorrect',
    source,
    ...(duplicate ? { dedupeOfTradeId: duplicate.tradeId } : {}),
  };
  const result = await runFn(
    `UPDATE investment.trade_quality_evaluations
        SET sub_score_breakdown = COALESCE(sub_score_breakdown, '{}'::jsonb)
          || jsonb_build_object('reflection', $2::jsonb),
            evaluated_at = NOW()
      WHERE trade_id = $1`,
    [payload.tradeId, JSON.stringify(reflection)],
  );
  return {
    source,
    reflection,
    persisted: Number(result?.rowCount || 0) > 0,
  };
}

export default {
  generateAndPersistTradeReflection,
  isAnalystPredictionCorrect,
  normalizeTradeReflectionText,
  reflectionReasonSimilarity,
};

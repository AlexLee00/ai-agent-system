// @ts-nocheck
/**
 * shared/feedback-action-mapper.ts — luna_failure_reflexions → feedback_to_action_map 자동 매핑
 *
 * 마스터 비전: "매 거래 → 분석 → 피드백 → 진화!"
 * luna_failure_reflexions(1,115+) 손실 패턴을 분석해 feedback_to_action_map에 실행 가능 액션으로 저장.
 */

import * as db from './db.ts';
import { callLunaLLM } from './luna-hub-llm.ts';

const LOG = '[feedback-action-mapper]';
const MAX_REFLEXIONS_PER_RUN = 50;
const SIMILARITY_THRESHOLD = 0.72;

interface FeedbackActionRow {
  symbol: string;
  market: string;
  reflexionIds: number[];
  patternSummary: string;
  suggestedAction: string;
  actionType: 'avoid_entry' | 'reduce_sizing' | 'adjust_exit' | 'switch_strategy' | 'monitor_only';
  confidence: number;
  createdAt: string;
}

export async function runFeedbackActionMapper({
  market = 'all',
  dryRun = false,
  llmEnabled = true,
  limit = MAX_REFLEXIONS_PER_RUN,
}: {
  market?: string;
  dryRun?: boolean;
  llmEnabled?: boolean;
  limit?: number;
} = {}): Promise<{ mapped: number; skipped: number; errors: number }> {
  console.log(`${LOG} 시작 market=${market} dryRun=${dryRun}`);

  const rows = await fetchUnmappedReflexions({ market, limit });
  if (rows.length === 0) {
    console.log(`${LOG} 미처리 reflexion 없음`);
    return { mapped: 0, skipped: 0, errors: 0 };
  }

  console.log(`${LOG} ${rows.length}개 reflexion 처리 시작`);
  const grouped = groupBySymbol(rows);
  let mapped = 0;
  let skipped = 0;
  let errors = 0;

  for (const [symbolKey, group] of Object.entries(grouped)) {
    try {
      const result = await processSymbolGroup(symbolKey, group, { dryRun, llmEnabled });
      if (result.action) {
        mapped++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`${LOG} 처리 실패 symbol=${symbolKey}:`, err?.message || err);
    }
  }

  console.log(`${LOG} 완료 mapped=${mapped} skipped=${skipped} errors=${errors}`);
  return { mapped, skipped, errors };
}

async function fetchUnmappedReflexions({
  market,
  limit,
}: {
  market: string;
  limit: number;
}) {
  const marketClause = market === 'all'
    ? ''
    : `AND COALESCE(lfr.market, 'crypto') = $2`;
  const params = market === 'all' ? [limit] : [limit, market];

  return db.query(
    `SELECT lfr.id, lfr.symbol, lfr.market, lfr.exchange,
            lfr.reason_code, lfr.lesson, lfr.penalty,
            lfr.pattern_type, lfr.regime, lfr.created_at
       FROM investment.luna_failure_reflexions lfr
       LEFT JOIN investment.feedback_to_action_map fam
         ON fam.symbol = lfr.symbol
         AND fam.market = COALESCE(lfr.market, 'crypto')
         AND fam.reflexion_ids @> ARRAY[lfr.id]::int[]
      WHERE fam.id IS NULL
        ${marketClause}
        AND lfr.penalty > 0
      ORDER BY lfr.penalty DESC, lfr.created_at DESC
      LIMIT $1`,
    params,
  ).catch(() => []);
}

function groupBySymbol(rows: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {};
  for (const row of rows) {
    const key = `${COALESCE(row.market, 'crypto')}:${row.symbol}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

function COALESCE(value: any, fallback: string): string {
  return value != null && String(value).trim() !== '' ? String(value).trim() : fallback;
}

async function processSymbolGroup(
  symbolKey: string,
  group: any[],
  { dryRun, llmEnabled }: { dryRun: boolean; llmEnabled: boolean },
): Promise<{ action: FeedbackActionRow | null }> {
  const [market, symbol] = symbolKey.split(':');
  if (!symbol) return { action: null };

  const avgPenalty = group.reduce((s, r) => s + Number(r.penalty || 0), 0) / group.length;
  const reasonCodes = [...new Set(group.map((r) => String(r.reason_code || '')).filter(Boolean))];
  const patternTypes = [...new Set(group.map((r) => String(r.pattern_type || '')).filter(Boolean))];
  const lessons = group.map((r) => String(r.lesson || '')).filter(Boolean).slice(0, 5);

  // LLM이 없거나 패턴이 명확한 경우 규칙 기반 액션 결정
  const ruleAction = resolveRuleBasedAction({ avgPenalty, reasonCodes, patternTypes, group });

  let patternSummary = `symbol=${symbol} market=${market} count=${group.length} avgPenalty=${avgPenalty.toFixed(4)}`;
  let suggestedAction = ruleAction.action;
  let actionType = ruleAction.type;
  let confidence = ruleAction.confidence;

  if (llmEnabled && group.length >= 3) {
    try {
      const llmResult = await analyzePatternsWithLLM({ symbol, market, lessons, reasonCodes, avgPenalty });
      if (llmResult) {
        patternSummary = llmResult.summary || patternSummary;
        suggestedAction = llmResult.action || suggestedAction;
        actionType = llmResult.type || actionType;
        confidence = Math.max(llmResult.confidence || 0, confidence);
      }
    } catch (err) {
      console.warn(`${LOG} LLM 분석 실패 ${symbol}:`, err?.message);
    }
  }

  const row: FeedbackActionRow = {
    symbol,
    market,
    reflexionIds: group.map((r) => Number(r.id)).filter(Number.isFinite),
    patternSummary,
    suggestedAction,
    actionType,
    confidence,
    createdAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await persistFeedbackAction(row);
  }

  console.log(`${LOG} ${symbol} (${market}) → ${actionType} confidence=${confidence.toFixed(2)}`);
  return { action: row };
}

function resolveRuleBasedAction({ avgPenalty, reasonCodes, patternTypes, group }: {
  avgPenalty: number;
  reasonCodes: string[];
  patternTypes: string[];
  group: any[];
}): { action: string; type: FeedbackActionRow['actionType']; confidence: number } {
  if (avgPenalty >= 0.3) {
    return {
      action: '손실 패턴 강도가 높음 — 신규 진입 회피 또는 sizing 30% 이하로 축소 권고',
      type: 'avoid_entry',
      confidence: Math.min(0.9, 0.5 + avgPenalty),
    };
  }
  if (reasonCodes.includes('stop_loss_threshold') || reasonCodes.includes('bearish_loss_consensus')) {
    return {
      action: 'SL/손절 패턴 반복 — exit 시점 조정 및 trailing stop 강화 권고',
      type: 'adjust_exit',
      confidence: 0.72,
    };
  }
  if (patternTypes.some((t) => t.includes('regime'))) {
    return {
      action: '레짐 의존 손실 — 해당 레짐에서 전략 전환 검토 권고',
      type: 'switch_strategy',
      confidence: 0.65,
    };
  }
  return {
    action: `반복 손실 패턴 감지 (count=${group.length}) — sizing 50% 축소 후 관찰 권고`,
    type: 'reduce_sizing',
    confidence: 0.55,
  };
}

async function analyzePatternsWithLLM({ symbol, market, lessons, reasonCodes, avgPenalty }: {
  symbol: string;
  market: string;
  lessons: string[];
  reasonCodes: string[];
  avgPenalty: number;
}): Promise<{ summary: string; action: string; type: FeedbackActionRow['actionType']; confidence: number } | null> {
  const systemPrompt = '당신은 퀀트 트레이딩 손실 패턴 분석가입니다. 짧고 명확한 JSON으로만 답합니다.';
  const userPrompt = `
심볼: ${symbol} (${market})
평균 페널티: ${avgPenalty.toFixed(4)}
반복 reason_codes: ${reasonCodes.join(', ')}
주요 교훈:
${lessons.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

위 손실 패턴을 분석하고 다음 JSON으로 답하세요:
{
  "summary": "패턴 요약 (2문장 이하)",
  "action": "구체적 실행 권고 (한국어)",
  "type": "avoid_entry|reduce_sizing|adjust_exit|switch_strategy|monitor_only",
  "confidence": 0.0~1.0
}`;

  const text = await callLunaLLM('luna.feedback_action_mapper', systemPrompt, userPrompt, 256).catch(() => null);
  if (!text) return null;

  try {
    const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!parsed.type || !parsed.action) return null;
    const validTypes = ['avoid_entry', 'reduce_sizing', 'adjust_exit', 'switch_strategy', 'monitor_only'];
    return {
      summary: String(parsed.summary || ''),
      action: String(parsed.action || ''),
      type: validTypes.includes(parsed.type) ? parsed.type : 'reduce_sizing',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.5))),
    };
  } catch {
    return null;
  }
}

async function persistFeedbackAction(row: FeedbackActionRow): Promise<void> {
  await db.run(
    `INSERT INTO investment.feedback_to_action_map
       (symbol, market, reflexion_ids, pattern_summary, suggested_action,
        action_type, confidence, created_at, updated_at)
     VALUES ($1, $2, $3::int[], $4, $5, $6, $7, $8, $8)
     ON CONFLICT (symbol, market) DO UPDATE SET
       reflexion_ids    = investment.feedback_to_action_map.reflexion_ids || EXCLUDED.reflexion_ids,
       pattern_summary  = EXCLUDED.pattern_summary,
       suggested_action = EXCLUDED.suggested_action,
       action_type      = EXCLUDED.action_type,
       confidence       = GREATEST(investment.feedback_to_action_map.confidence, EXCLUDED.confidence),
       updated_at       = EXCLUDED.updated_at`,
    [
      row.symbol,
      row.market,
      JSON.stringify(row.reflexionIds),
      row.patternSummary,
      row.suggestedAction,
      row.actionType,
      row.confidence,
      row.createdAt,
    ],
  );
}

export async function getFeedbackActionForSymbol(symbol: string, market = 'crypto'): Promise<FeedbackActionRow | null> {
  const row = await db.get(
    `SELECT symbol, market, pattern_summary, suggested_action, action_type, confidence, updated_at
       FROM investment.feedback_to_action_map
      WHERE symbol = $1 AND market = $2
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 1`,
    [symbol, market],
  ).catch(() => null);
  if (!row) return null;
  return {
    symbol: row.symbol,
    market: row.market,
    reflexionIds: [],
    patternSummary: row.pattern_summary || '',
    suggestedAction: row.suggested_action || '',
    actionType: row.action_type || 'monitor_only',
    confidence: Number(row.confidence || 0),
    createdAt: row.updated_at || '',
  };
}

export default { runFeedbackActionMapper, getFeedbackActionForSymbol };

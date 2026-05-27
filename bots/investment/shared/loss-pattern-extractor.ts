// @ts-nocheck
/**
 * shared/loss-pattern-extractor.ts — 손실 매매 패턴 추출기
 *
 * luna_failure_reflexions + trade_history → 손실 원인 분류 → 회피 가이드 생성
 * 마스터 비전: "매 거래 데이터 = 핵심! 손실 → 왜? 분석!"
 */

import * as db from './db.ts';
import { callLunaLLM } from './luna-hub-llm.ts';

const LOG = '[loss-pattern-extractor]';

export interface LossPattern {
  patternKey: string;
  market: string;
  symbolCount: number;
  tradeCount: number;
  avgLossPct: number;
  totalPenalty: number;
  reasonCodes: string[];
  patternTypes: string[];
  regime: string | null;
  strategyFamily: string | null;
  avoidanceGuide: string;
  confidence: number;
  extractedAt: string;
}

export async function extractLossPatterns({
  market = 'all',
  lookbackDays = 30,
  minTradeCount = 3,
  llmEnabled = true,
}: {
  market?: string;
  lookbackDays?: number;
  minTradeCount?: number;
  llmEnabled?: boolean;
} = {}): Promise<LossPattern[]> {
  console.log(`${LOG} 시작 market=${market} lookbackDays=${lookbackDays}`);

  const reflexions = await fetchRecentLossReflexions({ market, lookbackDays });
  if (reflexions.length === 0) {
    console.log(`${LOG} 손실 reflexion 없음`);
    return [];
  }

  console.log(`${LOG} ${reflexions.length}개 reflexion 분석 시작`);
  const clusters = clusterByPattern(reflexions);
  const patterns: LossPattern[] = [];

  for (const cluster of clusters) {
    if (cluster.rows.length < minTradeCount) continue;
    try {
      const pattern = await buildLossPattern(cluster, { llmEnabled });
      patterns.push(pattern);
    } catch (err) {
      console.error(`${LOG} 클러스터 처리 실패:`, err?.message);
    }
  }

  if (patterns.length > 0) {
    await persistLossPatterns(patterns);
    console.log(`${LOG} ${patterns.length}개 패턴 저장 완료`);
  }

  return patterns;
}

async function fetchRecentLossReflexions({
  market,
  lookbackDays,
}: {
  market: string;
  lookbackDays: number;
}) {
  const marketClause = market === 'all'
    ? ''
    : `AND COALESCE(market, 'crypto') = $2`;
  const params = market === 'all' ? [lookbackDays] : [lookbackDays, market];

  return db.query(
    `SELECT id, symbol, market, exchange, reason_code, lesson,
            penalty, pattern_type, regime, strategy_family, created_at
       FROM investment.luna_failure_reflexions
      WHERE penalty > 0
        AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
        ${marketClause}
      ORDER BY penalty DESC, created_at DESC
      LIMIT 500`,
    params,
  ).catch(() => []);
}

interface PatternCluster {
  key: string;
  reasonCode: string;
  patternType: string;
  regime: string | null;
  strategyFamily: string | null;
  market: string;
  rows: any[];
}

function clusterByPattern(reflexions: any[]): PatternCluster[] {
  const groups = new Map<string, PatternCluster>();

  for (const r of reflexions) {
    const reasonCode = String(r.reason_code || 'unknown');
    const patternType = String(r.pattern_type || 'unknown');
    const regime = r.regime ? String(r.regime) : null;
    const strategyFamily = r.strategy_family ? String(r.strategy_family) : null;
    const market = String(r.market || 'crypto');
    const key = `${market}:${reasonCode}:${patternType}:${regime || 'any'}`;

    if (!groups.has(key)) {
      groups.set(key, { key, reasonCode, patternType, regime, strategyFamily, market, rows: [] });
    }
    groups.get(key)!.rows.push(r);
  }

  return [...groups.values()].sort((a, b) => {
    const totalA = a.rows.reduce((s, r) => s + Number(r.penalty || 0), 0);
    const totalB = b.rows.reduce((s, r) => s + Number(r.penalty || 0), 0);
    return totalB - totalA;
  });
}

async function buildLossPattern(
  cluster: PatternCluster,
  { llmEnabled }: { llmEnabled: boolean },
): Promise<LossPattern> {
  const symbols = [...new Set(cluster.rows.map((r) => String(r.symbol || '')).filter(Boolean))];
  const totalPenalty = cluster.rows.reduce((s, r) => s + Number(r.penalty || 0), 0);
  const avgPenalty = totalPenalty / cluster.rows.length;
  const lessons = cluster.rows.map((r) => String(r.lesson || '')).filter(Boolean).slice(0, 6);
  const reasonCodes = [...new Set(cluster.rows.map((r) => String(r.reason_code || '')).filter(Boolean))];
  const patternTypes = [...new Set(cluster.rows.map((r) => String(r.pattern_type || '')).filter(Boolean))];

  let avoidanceGuide = buildRuleBasedAvoidanceGuide({ cluster, avgPenalty, symbols });
  let confidence = 0.6;

  if (llmEnabled && cluster.rows.length >= 5) {
    try {
      const llmResult = await generateAvoidanceGuideWithLLM({ cluster, lessons, avgPenalty });
      if (llmResult) {
        avoidanceGuide = llmResult.guide;
        confidence = Math.max(confidence, llmResult.confidence);
      }
    } catch (err) {
      console.warn(`${LOG} LLM 회피가이드 실패:`, err?.message);
    }
  }

  return {
    patternKey: cluster.key,
    market: cluster.market,
    symbolCount: symbols.length,
    tradeCount: cluster.rows.length,
    avgLossPct: avgPenalty,
    totalPenalty,
    reasonCodes,
    patternTypes,
    regime: cluster.regime,
    strategyFamily: cluster.strategyFamily,
    avoidanceGuide,
    confidence,
    extractedAt: new Date().toISOString(),
  };
}

function buildRuleBasedAvoidanceGuide({ cluster, avgPenalty, symbols }: {
  cluster: PatternCluster;
  avgPenalty: number;
  symbols: string[];
}): string {
  const parts = [];
  if (avgPenalty >= 0.2) {
    parts.push(`고강도 손실 패턴 (avg penalty ${avgPenalty.toFixed(3)})`);
    parts.push('신규 진입 보류 또는 sizing 20% 이하 권고');
  }
  if (cluster.regime) {
    parts.push(`${cluster.regime} 레짐에서 ${cluster.reasonCode} 패턴 반복`);
  }
  if (symbols.length >= 3) {
    parts.push(`${symbols.slice(0, 3).join(', ')} 등 ${symbols.length}개 종목에서 동일 패턴`);
  }
  parts.push(`원인: ${cluster.reasonCode} | 유형: ${cluster.patternType}`);
  return parts.join(' — ');
}

async function generateAvoidanceGuideWithLLM({ cluster, lessons, avgPenalty }: {
  cluster: PatternCluster;
  lessons: string[];
  avgPenalty: number;
}): Promise<{ guide: string; confidence: number } | null> {
  const systemPrompt = '당신은 퀀트 트레이딩 손실 패턴 분석 전문가입니다. JSON으로만 답합니다.';
  const userPrompt = `
손실 패턴 클러스터:
- 시장: ${cluster.market}
- reason_code: ${cluster.reasonCode}
- pattern_type: ${cluster.patternType}
- 레짐: ${cluster.regime || '알 수 없음'}
- 전략: ${cluster.strategyFamily || '알 수 없음'}
- 거래 수: ${cluster.rows.length}
- 평균 페널티: ${avgPenalty.toFixed(4)}
- 주요 교훈:
${lessons.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

다음 JSON으로 회피 가이드를 작성하세요:
{
  "guide": "구체적 회피/개선 가이드 (한국어, 3문장 이하)",
  "confidence": 0.0~1.0
}`;

  const text = await callLunaLLM('luna.loss_pattern_extractor', systemPrompt, userPrompt, 200).catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!parsed.guide) return null;
    return { guide: String(parsed.guide), confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.6))) };
  } catch {
    return null;
  }
}

async function persistLossPatterns(patterns: LossPattern[]): Promise<void> {
  for (const p of patterns) {
    await db.run(
      `INSERT INTO investment.luna_loss_patterns
         (pattern_key, market, symbol_count, trade_count, avg_loss_pct,
          total_penalty, reason_codes, pattern_types, regime, strategy_family,
          avoidance_guide, confidence, extracted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (pattern_key) DO UPDATE SET
         symbol_count    = EXCLUDED.symbol_count,
         trade_count     = EXCLUDED.trade_count,
         avg_loss_pct    = EXCLUDED.avg_loss_pct,
         total_penalty   = EXCLUDED.total_penalty,
         avoidance_guide = EXCLUDED.avoidance_guide,
         confidence      = EXCLUDED.confidence,
         extracted_at    = EXCLUDED.extracted_at`,
      [
        p.patternKey,
        p.market,
        p.symbolCount,
        p.tradeCount,
        p.avgLossPct,
        p.totalPenalty,
        JSON.stringify(p.reasonCodes),
        JSON.stringify(p.patternTypes),
        p.regime,
        p.strategyFamily,
        p.avoidanceGuide,
        p.confidence,
        p.extractedAt,
      ],
    ).catch(() => null);
  }
}

export async function getTopLossPatterns({
  market = 'all',
  limit = 10,
}: {
  market?: string;
  limit?: number;
} = {}): Promise<LossPattern[]> {
  const marketClause = market === 'all' ? '' : `WHERE market = $2`;
  const params = market === 'all' ? [limit] : [limit, market];
  const rows = await db.query(
    `SELECT pattern_key, market, symbol_count, trade_count, avg_loss_pct,
            total_penalty, reason_codes, pattern_types, regime, strategy_family,
            avoidance_guide, confidence, extracted_at
       FROM investment.luna_loss_patterns
       ${marketClause}
       ORDER BY total_penalty DESC
       LIMIT $1`,
    params,
  ).catch(() => []);
  return rows.map((r: any) => ({
    patternKey: r.pattern_key,
    market: r.market,
    symbolCount: Number(r.symbol_count || 0),
    tradeCount: Number(r.trade_count || 0),
    avgLossPct: Number(r.avg_loss_pct || 0),
    totalPenalty: Number(r.total_penalty || 0),
    reasonCodes: Array.isArray(r.reason_codes) ? r.reason_codes : [],
    patternTypes: Array.isArray(r.pattern_types) ? r.pattern_types : [],
    regime: r.regime || null,
    strategyFamily: r.strategy_family || null,
    avoidanceGuide: r.avoidance_guide || '',
    confidence: Number(r.confidence || 0),
    extractedAt: r.extracted_at || '',
  }));
}

export default { extractLossPatterns, getTopLossPatterns };

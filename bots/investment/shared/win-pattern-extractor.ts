// @ts-nocheck
/**
 * shared/win-pattern-extractor.ts — 수익 매매 패턴 추출기
 *
 * trade_history(수익 거래) → 수익 조건 분류 → 우선순위 가이드 생성
 * 마스터 비전: "어떤 조건에서 수익? → 미래 매매 우선순위!"
 */

import * as db from './db.ts';
import { callLunaLLM } from './luna-hub-llm.ts';

const LOG = '[win-pattern-extractor]';

export interface WinPattern {
  patternKey: string;
  market: string;
  symbolCount: number;
  tradeCount: number;
  avgWinPct: number;
  totalProfit: number;
  reasonCodes: string[];
  patternTypes: string[];
  regime: string | null;
  strategyFamily: string | null;
  priorityGuide: string;
  confidence: number;
  extractedAt: string;
}

export async function extractWinPatterns({
  market = 'all',
  lookbackDays = 30,
  minTradeCount = 3,
  llmEnabled = true,
}: {
  market?: string;
  lookbackDays?: number;
  minTradeCount?: number;
  llmEnabled?: boolean;
} = {}): Promise<WinPattern[]> {
  console.log(`${LOG} 시작 market=${market} lookbackDays=${lookbackDays}`);

  const trades = await fetchRecentWinTrades({ market, lookbackDays });
  if (trades.length === 0) {
    console.log(`${LOG} 수익 거래 없음`);
    return [];
  }

  console.log(`${LOG} ${trades.length}개 수익 거래 분석 시작`);
  const clusters = clusterByPattern(trades);
  const patterns: WinPattern[] = [];

  for (const cluster of clusters) {
    if (cluster.rows.length < minTradeCount) continue;
    try {
      const pattern = await buildWinPattern(cluster, { llmEnabled });
      patterns.push(pattern);
    } catch (err) {
      console.error(`${LOG} 클러스터 처리 실패:`, err?.message);
    }
  }

  if (patterns.length > 0) {
    await persistWinPatterns(patterns);
    console.log(`${LOG} ${patterns.length}개 패턴 저장 완료`);
  }

  return patterns;
}

async function fetchRecentWinTrades({
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
    `SELECT id, symbol, market, exchange,
            entry_reason, exit_reason, pnl_pct, pnl_usd,
            regime, strategy_family, entry_at, exit_at
       FROM investment.trade_history
      WHERE pnl_pct > 0
        AND exit_at IS NOT NULL
        AND exit_at >= NOW() - ($1::int * INTERVAL '1 day')
        ${marketClause}
      ORDER BY pnl_pct DESC, exit_at DESC
      LIMIT 500`,
    params,
  ).catch(() => []);
}

interface WinCluster {
  key: string;
  entryReason: string;
  exitReason: string;
  regime: string | null;
  strategyFamily: string | null;
  market: string;
  rows: any[];
}

function clusterByPattern(trades: any[]): WinCluster[] {
  const groups = new Map<string, WinCluster>();

  for (const t of trades) {
    const entryReason = String(t.entry_reason || 'unknown');
    const exitReason = String(t.exit_reason || 'unknown');
    const regime = t.regime ? String(t.regime) : null;
    const strategyFamily = t.strategy_family ? String(t.strategy_family) : null;
    const market = String(t.market || 'crypto');
    const key = `${market}:${entryReason}:${exitReason}:${regime || 'any'}`;

    if (!groups.has(key)) {
      groups.set(key, { key, entryReason, exitReason, regime, strategyFamily, market, rows: [] });
    }
    groups.get(key)!.rows.push(t);
  }

  return [...groups.values()].sort((a, b) => {
    const totalA = a.rows.reduce((s, t) => s + Number(t.pnl_pct || 0), 0);
    const totalB = b.rows.reduce((s, t) => s + Number(t.pnl_pct || 0), 0);
    return totalB - totalA;
  });
}

async function buildWinPattern(
  cluster: WinCluster,
  { llmEnabled }: { llmEnabled: boolean },
): Promise<WinPattern> {
  const symbols = [...new Set(cluster.rows.map((t) => String(t.symbol || '')).filter(Boolean))];
  const totalProfit = cluster.rows.reduce((s, t) => s + Number(t.pnl_usd || 0), 0);
  const avgWinPct = cluster.rows.reduce((s, t) => s + Number(t.pnl_pct || 0), 0) / cluster.rows.length;
  const reasonCodes = [...new Set(cluster.rows.map((t) => String(t.entry_reason || '')).filter(Boolean))];
  const patternTypes = [...new Set(cluster.rows.map((t) => String(t.exit_reason || '')).filter(Boolean))];

  let priorityGuide = buildRuleBasedPriorityGuide({ cluster, avgWinPct, symbols });
  let confidence = 0.6;

  if (llmEnabled && cluster.rows.length >= 5) {
    try {
      const llmResult = await generatePriorityGuideWithLLM({ cluster, avgWinPct, totalProfit });
      if (llmResult) {
        priorityGuide = llmResult.guide;
        confidence = Math.max(confidence, llmResult.confidence);
      }
    } catch (err) {
      console.warn(`${LOG} LLM 우선순위 가이드 실패:`, err?.message);
    }
  }

  return {
    patternKey: cluster.key,
    market: cluster.market,
    symbolCount: symbols.length,
    tradeCount: cluster.rows.length,
    avgWinPct,
    totalProfit,
    reasonCodes,
    patternTypes,
    regime: cluster.regime,
    strategyFamily: cluster.strategyFamily,
    priorityGuide,
    confidence,
    extractedAt: new Date().toISOString(),
  };
}

function buildRuleBasedPriorityGuide({ cluster, avgWinPct, symbols }: {
  cluster: WinCluster;
  avgWinPct: number;
  symbols: string[];
}): string {
  const parts = [];
  if (avgWinPct >= 0.05) {
    parts.push(`고수익 패턴 (avg win ${(avgWinPct * 100).toFixed(2)}%)`);
    parts.push('동일 조건 재현 시 sizing 우선 확대 권고');
  }
  if (cluster.regime) {
    parts.push(`${cluster.regime} 레짐에서 ${cluster.entryReason} 패턴 반복 수익`);
  }
  if (symbols.length >= 3) {
    parts.push(`${symbols.slice(0, 3).join(', ')} 등 ${symbols.length}개 종목에서 동일 패턴`);
  }
  parts.push(`진입: ${cluster.entryReason} | 청산: ${cluster.exitReason}`);
  return parts.join(' — ');
}

async function generatePriorityGuideWithLLM({ cluster, avgWinPct, totalProfit }: {
  cluster: WinCluster;
  avgWinPct: number;
  totalProfit: number;
}): Promise<{ guide: string; confidence: number } | null> {
  const systemPrompt = '당신은 퀀트 트레이딩 수익 패턴 분석 전문가입니다. JSON으로만 답합니다.';
  const userPrompt = `
수익 패턴 클러스터:
- 시장: ${cluster.market}
- 진입 이유: ${cluster.entryReason}
- 청산 이유: ${cluster.exitReason}
- 레짐: ${cluster.regime || '알 수 없음'}
- 전략: ${cluster.strategyFamily || '알 수 없음'}
- 거래 수: ${cluster.rows.length}
- 평균 수익률: ${(avgWinPct * 100).toFixed(2)}%
- 총 수익: $${totalProfit.toFixed(2)}

다음 JSON으로 우선순위 가이드를 작성하세요:
{
  "guide": "이 패턴을 미래 매매에서 우선 활용하는 구체적 가이드 (한국어, 3문장 이하)",
  "confidence": 0.0~1.0
}`;

  const text = await callLunaLLM('luna.win_pattern_extractor', systemPrompt, userPrompt, 200).catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!parsed.guide) return null;
    return { guide: String(parsed.guide), confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.6))) };
  } catch {
    return null;
  }
}

async function persistWinPatterns(patterns: WinPattern[]): Promise<void> {
  for (const p of patterns) {
    await db.run(
      `INSERT INTO investment.luna_win_patterns
         (pattern_key, market, symbol_count, trade_count, avg_win_pct,
          total_profit, reason_codes, pattern_types, regime, strategy_family,
          priority_guide, confidence, extracted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (pattern_key) DO UPDATE SET
         symbol_count   = EXCLUDED.symbol_count,
         trade_count    = EXCLUDED.trade_count,
         avg_win_pct    = EXCLUDED.avg_win_pct,
         total_profit   = EXCLUDED.total_profit,
         priority_guide = EXCLUDED.priority_guide,
         confidence     = EXCLUDED.confidence,
         extracted_at   = EXCLUDED.extracted_at`,
      [
        p.patternKey,
        p.market,
        p.symbolCount,
        p.tradeCount,
        p.avgWinPct,
        p.totalProfit,
        JSON.stringify(p.reasonCodes),
        JSON.stringify(p.patternTypes),
        p.regime,
        p.strategyFamily,
        p.priorityGuide,
        p.confidence,
        p.extractedAt,
      ],
    ).catch(() => null);
  }
}

export async function getTopWinPatterns({
  market = 'all',
  limit = 10,
}: {
  market?: string;
  limit?: number;
} = {}): Promise<WinPattern[]> {
  const marketClause = market === 'all' ? '' : `WHERE market = $2`;
  const params = market === 'all' ? [limit] : [limit, market];
  const rows = await db.query(
    `SELECT pattern_key, market, symbol_count, trade_count, avg_win_pct,
            total_profit, reason_codes, pattern_types, regime, strategy_family,
            priority_guide, confidence, extracted_at
       FROM investment.luna_win_patterns
       ${marketClause}
       ORDER BY total_profit DESC
       LIMIT $1`,
    params,
  ).catch(() => []);
  return rows.map((r: any) => ({
    patternKey: r.pattern_key,
    market: r.market,
    symbolCount: Number(r.symbol_count || 0),
    tradeCount: Number(r.trade_count || 0),
    avgWinPct: Number(r.avg_win_pct || 0),
    totalProfit: Number(r.total_profit || 0),
    reasonCodes: Array.isArray(r.reason_codes) ? r.reason_codes : [],
    patternTypes: Array.isArray(r.pattern_types) ? r.pattern_types : [],
    regime: r.regime || null,
    strategyFamily: r.strategy_family || null,
    priorityGuide: r.priority_guide || '',
    confidence: Number(r.confidence || 0),
    extractedAt: r.extracted_at || '',
  }));
}

export default { extractWinPatterns, getTopWinPatterns };

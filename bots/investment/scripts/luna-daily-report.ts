#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-daily-report.ts — 루나팀 일일 리포트
 *
 * 집계:
 *   - trade_history 24h PnL (시장별)
 *   - investment_llm_routing_log 24h 비용
 *   - luna_dpo_preference_pairs 7일 평균 score
 *
 * 전송: luna_domestic + luna_overseas + luna_crypto 채널 (telegram sender)
 *
 * 실행:
 *   node scripts/luna-daily-report.ts
 *   node scripts/luna-daily-report.ts --dry-run
 */

import { createRequire } from 'module';
import { formatMarketGateDailyLine } from '../shared/luna-market-deployment-gate.ts';
import { LUNA_REGIME_MARKET_SYMBOL, formatRegimeDailyLine } from '../shared/luna-regime-engine.ts';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { query, closeAll } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender   = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
const { today }        = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst'));

const DRY_RUN = process.argv.includes('--dry-run');

// ─── DB 집계 ──────────────────────────────────────────────────────

async function fetchPnl24h(market: string) {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)              AS trades,
         COALESCE(AVG(pnl_pct), 0) AS avg_pnl,
         COALESCE(SUM(pnl_pct), 0) AS total_pnl
       FROM investment.trade_history
       WHERE market = $1
         AND closed_at > NOW() - INTERVAL '24 hours'`,
      [market]
    );
    return rows[0] ?? { trades: 0, avg_pnl: 0, total_pnl: 0 };
  } catch (e) {
    return { trades: 0, avg_pnl: 0, total_pnl: 0 };
  }
}

async function fetchLlmCost24h() {
  try {
    const { rows } = await query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
       FROM investment_llm_routing_log
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    return parseFloat(rows[0]?.cost ?? 0);
  } catch {
    return 0;
  }
}

async function fetchDpoScore7d() {
  try {
    const { rows } = await query(
      `SELECT COALESCE(AVG(chosen_score), 0) AS avg_score
       FROM luna_dpo_preference_pairs
       WHERE created_at > NOW() - INTERVAL '7 days'`
    );
    return parseFloat(rows[0]?.avg_score ?? 0);
  } catch {
    return 0;
  }
}

function rowsFromQueryResult(result: any) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

async function fetchMarketGateLine() {
  try {
    const result = await query(
      `SELECT DISTINCT ON (market)
         market,
         score,
         deployment,
         signals->>'effectiveDeployment' AS "effectiveDeployment",
         computed_at
       FROM investment.luna_market_gate_history
       ORDER BY market, computed_at DESC`
    );
    return formatMarketGateDailyLine(rowsFromQueryResult(result));
  } catch {
    return '게이트: 데이터 없음';
  }
}

async function fetchRegimeLine() {
  try {
    const result = await query(
      `SELECT DISTINCT ON (market)
         market,
         current_regime AS dominant,
         regime_probabilities,
         confidence,
         source,
         created_at
       FROM investment.hmm_regime_log
       WHERE symbol = $1
       ORDER BY market, created_at DESC`,
      [LUNA_REGIME_MARKET_SYMBOL]
    );
    return formatRegimeDailyLine(rowsFromQueryResult(result));
  } catch {
    return '레짐: 데이터 없음';
  }
}

async function fetchStrategyFamilyLine() {
  try {
    const result = await query(
      `SELECT family, signal_type, COUNT(*)::int AS count
         FROM investment.luna_strategy_signals
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY family, signal_type
        ORDER BY family, signal_type`
    );
    const rows = rowsFromQueryResult(result);
    if (!rows.length) return '전략군: 데이터 없음';
    const total = rows.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
    const turtle = rows
      .filter((row: any) => row.family === 'turtle_breakout')
      .reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
    const testah = rows
      .filter((row: any) => row.family === 'testah_pullback')
      .reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
    return `전략군: 신호 ${total}건(터틀 ${turtle}·테스타 ${testah})`;
  } catch {
    return '전략군: 데이터 없음';
  }
}

// ─── 리포트 빌드 ──────────────────────────────────────────────────

function buildReport(market: string, pnl: any, llmCost: number, dpoScore: number, marketGateLine = '게이트: 데이터 없음', regimeLine = '레짐: 데이터 없음', strategyLine = '전략군: 데이터 없음') {
  const pnlSign = pnl.avg_pnl >= 0 ? '+' : '';
  return `📊 [루나] ${market} 일일 리포트 (${today()})
━━━━━━━━━━━━━━━━━━━
거래 수:  ${pnl.trades}건
평균 PnL: ${pnlSign}${(pnl.avg_pnl * 100).toFixed(2)}%
누적 PnL: ${pnlSign}${(pnl.total_pnl * 100).toFixed(2)}%
${marketGateLine}
${regimeLine}
${strategyLine}
━━━━━━━━━━━━━━━━━━━
LLM 비용(24h): $${llmCost.toFixed(4)}
DPO 점수(7d):  ${dpoScore.toFixed(3)}`;
}

const MARKET_CHANNEL: Record<string, string> = {
  crypto:   'luna',
  domestic: 'luna',
  overseas: 'luna',
};

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`[luna-daily-report] 시작 (dry-run=${DRY_RUN})`);

  const [llmCost, dpoScore, marketGateLine, regimeLine, strategyLine] = await Promise.all([
    fetchLlmCost24h(),
    fetchDpoScore7d(),
    fetchMarketGateLine(),
    fetchRegimeLine(),
    fetchStrategyFamilyLine(),
  ]);

  for (const market of ['crypto', 'domestic', 'overseas']) {
    const pnl    = await fetchPnl24h(market);
    const report = buildReport(market, pnl, llmCost, dpoScore, marketGateLine, regimeLine, strategyLine);

    console.log(`\n${report}`);

    if (!DRY_RUN) {
      try {
        await telegramSender.send(MARKET_CHANNEL[market], report);
        console.log(`[luna-daily-report] ${market} 전송 완료`);
      } catch (e) {
        console.error(`[luna-daily-report] ${market} 전송 실패:`, e?.message ?? e);
      }
    }
  }

  console.log('[luna-daily-report] 완료');
  await closeAll();
}

main().catch((e) => {
  console.error('[luna-daily-report] 오류:', e);
  process.exit(1);
});

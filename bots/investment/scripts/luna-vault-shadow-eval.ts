#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-vault-shadow-eval.ts — S1.3-3 C1 L1 사후 검증 (Outcome Attribution)
 *
 * luna_vault_shadow_adjustments의 각 판정(base/vault 조정 방향)에 대해,
 * 판정 이후 후속 거래의 실제 pnl을 집계하여 base/vault 적중 여부를 채점한다.
 * 결과는 investment.luna_vault_shadow_eval에 기록.
 *
 * 적중 규칙:
 *   penalize/disable → post avg pnl_percent < 0 → 적중 (bad pattern 식별 정확)
 *   boost/enable    → post avg pnl_percent > 0 → 적중 (good pattern 식별 정확)
 *   insufficient_evidence / null → 해당 필드 채점 제외 (null)
 *
 * 매칭 방식 (RESULT §3 확정):
 *   Win 패턴 (4-segment: market:family:exitReason:regime):
 *     trade_journal.market + strategy_family + exit_reason + market_regime → full match
 *   Loss 패턴 (5-segment: market:reasonCode:patternType:regime:strategyFamily):
 *     trade_journal.market + strategy_family + market_regime → partial match
 *     (reasonCode/patternType은 LLM 사후 분석 결과, trade_journal에 직접 컬럼 없음)
 *
 * 평가 윈도우: shadow created_at 이후 14일
 *
 * 실행: node bots/investment/scripts/luna-vault-shadow-eval.ts [--dry-run]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const { pool, query } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

const EVAL_WINDOW_DAYS = 14;
const WINDOW_MS = EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const ACTIONABLE = new Set(['penalize', 'disable', 'boost', 'enable']);
const DRY_RUN = process.argv.includes('--dry-run');

// ─── 패턴 키 파싱 ───────────────────────────────────────────────────────

type ParsedKey = {
  patternType: 'win' | 'loss';
  matchStrategy: 'full' | 'partial';
  market: string;
  strategyFamily: string;
  exitReason: string | null;  // win only
  regime: string;
};

function parsePatternKey(key: string): ParsedKey {
  const parts = key.split(':');
  if (parts.length === 4) {
    // Win: market:strategyFamily:exitReason:regime
    return {
      patternType: 'win',
      matchStrategy: 'full',
      market: parts[0],
      strategyFamily: parts[1],
      exitReason: parts[2],
      regime: parts[3],
    };
  }
  // Loss: market:reasonCode:patternType:regime:strategyFamily (5-segment)
  return {
    patternType: 'loss',
    matchStrategy: 'partial',
    market: parts[0],
    strategyFamily: parts.length >= 5 ? (parts[4] ?? 'any') : 'any',
    exitReason: null,
    regime: parts.length >= 4 ? (parts[3] ?? 'any') : 'any',
  };
}

// ─── 후속 거래 집계 ─────────────────────────────────────────────────────

async function fetchPostTrades(parsed: ParsedKey, windowStart: number, windowEnd: number) {
  if (parsed.patternType === 'win') {
    // 4-dim full match: market + strategy_family + exit_reason + market_regime
    const { rows } = await query(
      `SELECT
         AVG(pnl_percent) AS avg_pnl,
         COUNT(*)::int    AS trade_count
       FROM investment.trade_journal
       WHERE market = $1
         AND ($2 = 'any' OR strategy_family = $2)
         AND ($3 = 'any' OR exit_reason = $3)
         AND ($4 = 'any' OR market_regime = $4)
         AND exit_time IS NOT NULL
         AND pnl_percent IS NOT NULL
         AND exit_time > $5
         AND exit_time <= $6`,
      [parsed.market, parsed.strategyFamily, parsed.exitReason, parsed.regime, windowStart, windowEnd],
    );
    return {
      avgPnl: parseFloat(rows[0]?.avg_pnl ?? 'NaN'),
      count: parseInt(rows[0]?.trade_count ?? 0, 10),
    };
  } else {
    // 3-dim partial match: market + strategy_family + market_regime
    const { rows } = await query(
      `SELECT
         AVG(pnl_percent) AS avg_pnl,
         COUNT(*)::int    AS trade_count
       FROM investment.trade_journal
       WHERE market = $1
         AND ($2 = 'any' OR strategy_family = $2)
         AND ($3 = 'any' OR market_regime = $3)
         AND exit_time IS NOT NULL
         AND pnl_percent IS NOT NULL
         AND exit_time > $4
         AND exit_time <= $5`,
      [parsed.market, parsed.strategyFamily, parsed.regime, windowStart, windowEnd],
    );
    return {
      avgPnl: parseFloat(rows[0]?.avg_pnl ?? 'NaN'),
      count: parseInt(rows[0]?.trade_count ?? 0, 10),
    };
  }
}

// ─── 적중 판정 ──────────────────────────────────────────────────────────

function determineCorrect(adjType: string | null, avgPnl: number): boolean | null {
  if (!adjType || !ACTIONABLE.has(adjType)) return null;
  if (!Number.isFinite(avgPnl)) return null; // 후속 거래 없음
  if (adjType === 'penalize' || adjType === 'disable') return avgPnl < 0;
  return avgPnl > 0; // boost | enable
}

// ─── 메인 ───────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('[vault-shadow-eval] DRY-RUN 모드 — DB write 없음');

  // shadow 판정 로드 (base가 actionable인 것만 처리)
  const { rows: shadows } = await query(
    `SELECT id, pattern_key, market, regime, base_adjustment_type, vault_shadow_type, created_at
     FROM investment.luna_vault_shadow_adjustments
     WHERE base_adjustment_type = ANY($1)
     ORDER BY created_at ASC`,
    [['penalize', 'disable', 'boost', 'enable']],
  );

  console.log(`[vault-shadow-eval] 평가 대상: ${shadows.length}건 (eval window: ${EVAL_WINDOW_DAYS}일)`);

  let processed = 0;
  let errored = 0;
  const allResults: { baseCorrect: boolean | null; vaultCorrect: boolean | null; postCount: number }[] = [];

  for (const shadow of shadows) {
    const windowStart = new Date(shadow.created_at).getTime();
    const windowEnd = windowStart + WINDOW_MS;
    const parsed = parsePatternKey(shadow.pattern_key);

    let avgPnl: number;
    let postCount: number;

    try {
      const r = await fetchPostTrades(parsed, windowStart, windowEnd);
      avgPnl = r.avgPnl;
      postCount = r.count;
    } catch (e) {
      console.error(`  [ERROR] shadow ${shadow.id} 거래 조회 실패:`, e?.message ?? e);
      errored++;
      continue;
    }

    const baseCorrect = determineCorrect(shadow.base_adjustment_type, avgPnl);
    const vaultCorrect = determineCorrect(shadow.vault_shadow_type, avgPnl);

    const avgPnlDisplay = Number.isFinite(avgPnl) ? avgPnl.toFixed(2) + '%' : 'N/A';
    console.log(
      `  id=${shadow.id} | ${shadow.pattern_key}` +
      ` | ${parsed.patternType}/${parsed.matchStrategy}` +
      ` | postTrades=${postCount} avgPnl=${avgPnlDisplay}` +
      ` | base(${shadow.base_adjustment_type})=${baseCorrect ?? '?'}` +
      ` vault(${shadow.vault_shadow_type ?? 'null'})=${vaultCorrect ?? '?'}`,
    );

    if (!DRY_RUN) {
      const meta = JSON.stringify({
        patternType: parsed.patternType,
        matchStrategy: parsed.matchStrategy,
        evalWindowDays: EVAL_WINDOW_DAYS,
      });
      await query(
        `INSERT INTO investment.luna_vault_shadow_eval
           (shadow_id, pattern_key, market, regime,
            eval_window_start, eval_window_end,
            post_trade_count, post_avg_pnl,
            base_adjustment_type, vault_shadow_type,
            base_correct, vault_correct,
            evaluated_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13::jsonb)
         ON CONFLICT (shadow_id, eval_window_start, eval_window_end) DO UPDATE SET
           post_trade_count     = EXCLUDED.post_trade_count,
           post_avg_pnl         = EXCLUDED.post_avg_pnl,
           base_correct         = EXCLUDED.base_correct,
           vault_correct        = EXCLUDED.vault_correct,
           evaluated_at         = EXCLUDED.evaluated_at,
           metadata             = EXCLUDED.metadata`,
        [
          shadow.id,
          shadow.pattern_key,
          shadow.market,
          shadow.regime,
          windowStart,
          windowEnd,
          postCount,
          Number.isFinite(avgPnl) ? avgPnl : null,
          shadow.base_adjustment_type,
          shadow.vault_shadow_type ?? null,
          baseCorrect,
          vaultCorrect,
          meta,
        ],
      );
    }

    allResults.push({ baseCorrect, vaultCorrect, postCount });
    processed++;
  }

  // 집계 리포트
  const withData = allResults.filter(r => r.postCount > 0);
  const baseScored = allResults.filter(r => r.baseCorrect !== null);
  const vaultScored = allResults.filter(r => r.vaultCorrect !== null);
  const baseHits = baseScored.filter(r => r.baseCorrect === true).length;
  const vaultHits = vaultScored.filter(r => r.vaultCorrect === true).length;
  const baseHitRate = baseScored.length > 0 ? baseHits / baseScored.length : null;
  const vaultHitRate = vaultScored.length > 0 ? vaultHits / vaultScored.length : null;
  const lift = baseHitRate !== null && vaultHitRate !== null ? vaultHitRate - baseHitRate : null;

  const matchRate = allResults.length > 0 ? ((withData.length / allResults.length) * 100).toFixed(1) : '0.0';

  console.log('\n─── L1 사후 검증 집계 ──────────────────────────────────');
  console.log(`처리: ${processed}건 | 에러: ${errored}건 | DRY-RUN: ${DRY_RUN}`);
  console.log(`매핑률(후속 거래 있는 판정): ${withData.length}/${allResults.length} = ${matchRate}%`);
  console.log(`base  채점: ${baseScored.length}건 / 적중: ${baseHits} / 적중률: ${baseHitRate !== null ? (baseHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`vault 채점: ${vaultScored.length}건 / 적중: ${vaultHits} / 적중률: ${vaultHitRate !== null ? (vaultHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`lift (vault − base): ${lift !== null ? (lift >= 0 ? '+' : '') + (lift * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log('────────────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error('[vault-shadow-eval] 치명적 오류:', e?.message ?? e);
    process.exit(1);
  })
  .finally(() => pool?.end?.());

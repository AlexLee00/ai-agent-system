#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/analyze-rr.js — 네메시스 Phase 3: R/R 최적화 분석
 *
 * trade_journal + trade_review 데이터를 분석하여 최적 R/R 비율을 도출한다.
 *
 * 기능:
 *   1. 전체 매매 현황 (승률, 평균 승/패, 실현 R/R)
 *   2. 심볼별 분석 (3건 이상)
 *   3. TP/SL 시뮬레이션 (8가지 R/R 조합 백테스트)
 *      - max_favorable / max_adverse (trade_review) 기반
 *   4. trade_review 봇 정확도 분석
 *   5. RAG rag_trades에 분석 결과 저장
 *
 * 실행: node scripts/analyze-rr.js [--days=90]
 */

import { createRequire } from 'module';
import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import * as rag from '../shared/rag-client.ts';
import { runVectorBtBacktest } from '../shared/vectorbt-runner.ts';

const _require = createRequire(import.meta.url);
const kst      = _require('../../../packages/core/lib/kst');

const args    = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS    = daysArg ? parseInt(daysArg.split('=')[1]) : 90;
const SYMBOL   = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';
const SHOULD_VALIDATE_BACKTEST = args.includes('--validate-backtest');
const VALIDATE_BACKTEST_ONLY = args.includes('--validate-backtest-only');

const RR_SCENARIOS = [
  { tp: 1.0, sl: 0.5,  label: 'TP 1.0% / SL 0.5%  (R/R 2:1)' },
  { tp: 1.5, sl: 0.75, label: 'TP 1.5% / SL 0.75% (R/R 2:1)' },
  { tp: 2.0, sl: 1.0,  label: 'TP 2.0% / SL 1.0%  (R/R 2:1)' },
  { tp: 3.0, sl: 1.0,  label: 'TP 3.0% / SL 1.0%  (R/R 3:1)' },
  { tp: 6.0, sl: 3.0,  label: 'TP 6.0% / SL 3.0%  (현재 고정 R/R 2:1)' },
  { tp: 1.5, sl: 1.0,  label: 'TP 1.5% / SL 1.0%  (R/R 1.5:1)' },
  { tp: 2.0, sl: 0.7,  label: 'TP 2.0% / SL 0.7%  (R/R 2.86:1)' },
  { tp: 1.0, sl: 1.0,  label: 'TP 1.0% / SL 1.0%  (R/R 1:1)' },
];

async function ensureVectorBtBacktestSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS vectorbt_backtest_runs (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      days INTEGER NOT NULL,
      tp_pct DOUBLE PRECISION,
      sl_pct DOUBLE PRECISION,
      label TEXT,
      status TEXT DEFAULT 'ok',
      sharpe DOUBLE PRECISION,
      total_return DOUBLE PRECISION,
      max_drawdown DOUBLE PRECISION,
      win_rate DOUBLE PRECISION,
      total_trades INTEGER,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function persistVectorBtBacktestRuns(symbol, days, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensureVectorBtBacktestSchema();
  for (const row of rows) {
    await db.run(`
      INSERT INTO vectorbt_backtest_runs (
        symbol, days, tp_pct, sl_pct, label, status,
        sharpe, total_return, max_drawdown, win_rate, total_trades, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
    `, [
      symbol,
      days,
      row.tp ?? null,
      row.sl ?? null,
      row.label || null,
      row.status || (row.error ? 'error' : 'ok'),
      row.sharpe ?? null,
      row.totalReturn ?? null,
      row.maxDrawdown ?? null,
      row.winRate ?? null,
      row.totalTrades ?? null,
      JSON.stringify({
        install: row.install || null,
        missing: row.missing || null,
        error: row.error || null,
        rawStatus: row.rawStatus || null,
      }),
    ]);
  }
  return rows.length;
}

async function validateRRWithBacktest(symbol, days = 90, scenarios = RR_SCENARIOS) {
  console.log(`7. VectorBT 백테스트 검증 (${symbol}, ${days}일)`);

  const results = [];
  for (const scenario of scenarios) {
    try {
      const btResult = runVectorBtBacktest(symbol, days, {
        tpPct: scenario.tp / 100,
        slPct: scenario.sl / 100,
      });
      if (btResult?.status === 'dependency_missing') {
        console.log(`   ⚠️ 의존성 부족: ${btResult.missing?.join(', ') || 'unknown'}`);
        console.log(`   설치: ${btResult.install}`);
        const payload = {
          status: 'dependency_missing',
          details: btResult,
          persisted: 0,
        };
        try {
          await db.initSchema();
          payload.persisted = await persistVectorBtBacktestRuns(symbol, days, [{
            tp: null,
            sl: null,
            label: 'dependency_missing',
            status: 'dependency_missing',
            missing: btResult.missing || [],
            install: btResult.install || null,
            rawStatus: btResult.status || null,
          }]);
        } catch (error) {
          console.log(`   ⚠️ 백테스트 저장 생략: ${error.message}`);
        }
        return payload;
      }
      results.push({
        ...scenario,
        status: btResult?.status || 'ok',
        sharpe: btResult?.sharpe_ratio ?? null,
        totalReturn: btResult?.total_return ?? null,
        maxDrawdown: btResult?.max_drawdown ?? null,
        winRate: btResult?.win_rate ?? null,
        totalTrades: btResult?.total_trades ?? null,
      });
      console.log(
        `   - ${scenario.label}: ` +
        `샤프=${Number(btResult?.sharpe_ratio || 0).toFixed(2)} ` +
        `수익=${Number(btResult?.total_return || 0).toFixed(1)}% ` +
        `MDD=${Number(btResult?.max_drawdown || 0).toFixed(1)}%`,
      );
    } catch (error) {
      console.log(`   ⚠️ ${scenario.label}: 검증 실패 (${error.message})`);
      results.push({ ...scenario, status: 'error', error: error.message });
    }
  }

  let persisted = 0;
  try {
    await db.initSchema();
    persisted = await persistVectorBtBacktestRuns(symbol, days, results);
    console.log(`   💾 VectorBT 결과 저장: ${persisted}건`);
  } catch (error) {
    console.log(`   ⚠️ VectorBT 결과 저장 생략: ${error.message}`);
  }

  return { status: 'ok', results, persisted };
}

async function analyzeRR() {
  console.log(`=== 네메시스 R/R 최적화 분석 (최근 ${DAYS}일) ===\n`);

  if (VALIDATE_BACKTEST_ONLY) {
    await validateRRWithBacktest(SYMBOL, DAYS);
    process.exit(0);
  }

  try {
    await journalDb.initJournalSchema();
  } catch (error) {
    if (SHOULD_VALIDATE_BACKTEST) {
      console.log(`⚠️ DB 초기화 실패 — 백테스트 검증만 계속 진행: ${error.message}`);
      console.log('');
      await validateRRWithBacktest(SYMBOL, DAYS);
      process.exit(0);
    }
    throw error;
  }

  const sinceMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  // ── 1. 전체 매매 현황 ─────────────────────────────────────────────────
  const summary = await db.get(`
    SELECT
      COUNT(*)                                                    AS total_trades,
      COUNT(CASE WHEN pnl_percent > 0 THEN 1 END)                AS wins,
      COUNT(CASE WHEN pnl_percent <= 0 THEN 1 END)               AS losses,
      ROUND(AVG(pnl_percent)::numeric, 4)                         AS avg_pnl,
      ROUND(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END)::numeric, 4) AS avg_win,
      ROUND(AVG(CASE WHEN pnl_percent <= 0 THEN pnl_percent END)::numeric, 4) AS avg_loss,
      ROUND(MAX(pnl_percent)::numeric, 4)                         AS best,
      ROUND(MIN(pnl_percent)::numeric, 4)                         AS worst
    FROM trade_journal
    WHERE status = 'closed' AND exit_time IS NOT NULL AND created_at >= ?
  `, [sinceMs]);

  const total = parseInt(summary?.total_trades || 0);

  if (total === 0) {
    console.log('⬜ 종료된 매매 없음 — 충분한 매매 기록이 쌓인 후 재실행하세요.');
    console.log('   (최소 10건 이상 권장)');
    if (SHOULD_VALIDATE_BACKTEST) {
      console.log('');
      await validateRRWithBacktest(SYMBOL, DAYS);
    }
    process.exit(0);
  }

  const wins      = parseInt(summary.wins || 0);
  const losses    = parseInt(summary.losses || 0);
  const winRate   = (wins / total * 100).toFixed(1);
  const avgWin    = parseFloat(summary.avg_win  || 0);
  const avgLoss   = parseFloat(summary.avg_loss || 0);
  const currentRR = avgLoss !== 0
    ? (Math.abs(avgWin) / Math.abs(avgLoss)).toFixed(2)
    : 'N/A';

  console.log('1. 전체 매매 현황');
  console.log(`   총 매매: ${total}건 (승: ${wins} / 패: ${losses})`);
  console.log(`   승률: ${winRate}%`);
  console.log(`   평균 수익률: ${summary.avg_pnl}%`);
  console.log(`   평균 승: +${avgWin.toFixed(4)}% | 평균 패: ${avgLoss.toFixed(4)}%`);
  console.log(`   최고: +${summary.best}% | 최저: ${summary.worst}%`);
  console.log(`   실현 R/R: ${currentRR}`);
  console.log('');

  // ── 2. 심볼별 분석 ────────────────────────────────────────────────────
  const bySymbol = await db.query(`
    SELECT
      symbol,
      COUNT(*)                                                     AS trades,
      ROUND(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END)::numeric, 4) AS avg_win,
      ROUND(AVG(CASE WHEN pnl_percent <= 0 THEN pnl_percent END)::numeric, 4) AS avg_loss,
      ROUND((COUNT(CASE WHEN pnl_percent > 0 THEN 1 END) * 100.0 / COUNT(*))::numeric, 1) AS win_rate
    FROM trade_journal
    WHERE status = 'closed' AND exit_time IS NOT NULL AND created_at >= ?
    GROUP BY symbol
    HAVING COUNT(*) >= 3
    ORDER BY trades DESC
  `, [sinceMs]);

  if (bySymbol.length > 0) {
    console.log('2. 심볼별 분석 (3건 이상)');
    bySymbol.forEach(r => {
      const rr = r.avg_win && r.avg_loss
        ? (Math.abs(parseFloat(r.avg_win)) / Math.abs(parseFloat(r.avg_loss))).toFixed(2)
        : 'N/A';
      const flag = parseFloat(rr) >= 2 ? '✅' : parseFloat(rr) >= 1 ? '🟡' : '🔴';
      console.log(`   ${flag} ${r.symbol}: ${r.trades}건 | 승률 ${r.win_rate}% | 평균승 +${r.avg_win}% | 평균패 ${r.avg_loss}% | R/R ${rr}`);
    });
    console.log('');
  }

  // ── 3. TP/SL 시뮬레이션 (trade_review max_favorable/max_adverse 기반) ──
  const reviewedTrades = await db.query(`
    SELECT
      j.trade_id,
      j.symbol,
      j.direction,
      j.entry_price,
      j.pnl_percent,
      r.max_favorable,
      r.max_adverse
    FROM trade_journal j
    INNER JOIN trade_review r ON j.trade_id = r.trade_id
    WHERE j.status = 'closed'
      AND j.exit_time IS NOT NULL
      AND r.max_favorable IS NOT NULL
      AND r.max_adverse IS NOT NULL
      AND j.created_at >= ?
    ORDER BY j.entry_time
  `, [sinceMs]);

  if (reviewedTrades.length < 5) {
    console.log(`3. TP/SL 시뮬레이션: 데이터 부족 (${reviewedTrades.length}건 — max_favorable/max_adverse 포함 최소 5건 필요)`);
    console.log('   → trade_review에 데이터가 쌓이면 시뮬레이션 가능합니다.');
    console.log('');
  } else {
    console.log(`3. TP/SL 시뮬레이션 (${reviewedTrades.length}건 리뷰 기반)`);

    let bestExpectancy = -Infinity;
    let bestScenario   = null;

    for (const sc of RR_SCENARIOS) {
      let wins2 = 0, losses2 = 0, neither = 0, totalPnl = 0;

      for (const t of reviewedTrades) {
        // max_favorable: 롱 기준 최대 수익 가능 % / max_adverse: 최대 손실 가능 %
        const mf = parseFloat(t.max_favorable || 0);  // % 단위
        const ma = parseFloat(t.max_adverse   || 0);  // % 단위 (음수)

        const tpHit = mf >= sc.tp;
        const slHit = ma <= -sc.sl;

        if (tpHit && !slHit) {
          wins2++;
          totalPnl += sc.tp;
        } else if (slHit && !tpHit) {
          losses2++;
          totalPnl -= sc.sl;
        } else if (tpHit && slHit) {
          // 둘 다 도달 — 보수적으로 SL 처리
          losses2++;
          totalPnl -= sc.sl;
        } else {
          neither++;
          totalPnl += parseFloat(t.pnl_percent || 0);
        }
      }

      const n            = wins2 + losses2 + neither;
      const simWR        = n > 0 ? (wins2 / n * 100).toFixed(1) : '—';
      const expectancy   = n > 0 ? (totalPnl / n).toFixed(3) : '—';
      const expVal       = parseFloat(expectancy);
      const marker       = expVal > 0 ? '✅' : expVal > -0.1 ? '🟡' : '❌';

      console.log(`   ${marker} ${sc.label}`);
      console.log(`      승: ${wins2} / 패: ${losses2} / 미도달: ${neither} | 승률: ${simWR}% | 기대값: ${expectancy}% | 총PnL: ${totalPnl.toFixed(2)}%`);

      if (expVal > bestExpectancy) {
        bestExpectancy = expVal;
        bestScenario   = { ...sc, expectancy: expVal, winRate: simWR };
      }
    }

    if (bestScenario) {
      console.log('');
      console.log(`   ✨ 최적 R/R: TP ${bestScenario.tp}% / SL ${bestScenario.sl}%`);
      console.log(`      기대값: ${bestScenario.expectancy}% | 승률: ${bestScenario.winRate}%`);
    }
    console.log('');
  }

  // ── 4. 봇 정확도 분석 ────────────────────────────────────────────────
  const accuracy = await db.get(`
    SELECT
      COUNT(*)                                                               AS reviews,
      ROUND((AVG(CASE WHEN COALESCE((analyst_accuracy->>'aria')::boolean, aria_accurate) THEN 1.0 ELSE 0.0 END) * 100)::numeric, 1) AS aria_acc,
      ROUND((AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, sophia_accurate) THEN 1.0 ELSE 0.0 END) * 100)::numeric, 1) AS sophia_acc,
      ROUND((AVG(CASE WHEN COALESCE((analyst_accuracy->>'oracle')::boolean, oracle_accurate) THEN 1.0 ELSE 0.0 END) * 100)::numeric, 1) AS oracle_acc,
      ROUND((AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, hermes_accurate) THEN 1.0 ELSE 0.0 END) * 100)::numeric, 1) AS hermes_acc
    FROM trade_review
    WHERE reviewed_at >= ?
  `, [sinceMs]);

  if (accuracy && parseInt(accuracy.reviews || 0) > 0) {
    console.log('4. 봇 정확도 (trade_review 기준)');
    console.log(`   리뷰 건수: ${accuracy.reviews}건`);
    console.log(`   아리아(기술): ${accuracy.aria_acc}% | 소피아(감성): ${accuracy.sophia_acc}%`);
    console.log(`   오라클(종합): ${accuracy.oracle_acc}% | 헤르메스(거시): ${accuracy.hermes_acc}%`);
    console.log('');
  }

  // ── 5. 권장 사항 ─────────────────────────────────────────────────────
  console.log('5. 권장 사항');
  console.log('   - 기대값(expectancy) > 0 인 조합 중 승률·총PnL 종합 고려');
  console.log('   - 현재 고정 TP 6% / SL 3% (R/R 2:1) 대비 시뮬레이션 결과 비교');
  console.log('   - 마스터 승인 후 nemesis.js의 FIXED_TP_PCT / FIXED_SL_PCT 변경');
  console.log('   - 데이터가 20건+ 쌓이면 analyze-rr.js 재실행하여 재검토 권장');
  console.log('');

  // ── 6. 켈리 기준 포지션 사이징 (전체 실적 기반) ────────────────────
  if (total >= 10 && currentRR !== 'N/A') {
    const { calcKellyPosition } = await import('../team/budget.ts');
    const winRateFrac = wins / total;
    const rrVal       = parseFloat(currentRR);
    if (rrVal > 0) {
      const fullKelly = calcKellyPosition(winRateFrac, rrVal, 'full');
      const halfKelly = calcKellyPosition(winRateFrac, rrVal, 'half');
      const kellyRec  = Math.floor(halfKelly * 10000); // $10,000 포트폴리오 기준
      console.log('6. 켈리 기준 포지션 사이징');
      console.log(`   승률: ${winRate}% | R/R: ${currentRR}`);
      console.log(`   Full Kelly: ${(fullKelly * 100).toFixed(1)}% | Half Kelly (권장): ${(halfKelly * 100).toFixed(1)}%`);
      console.log(`   → $10,000 포트폴리오 기준 권장 포지션: $${kellyRec} (Half Kelly)`);
      if (halfKelly <= 0.01) {
        console.log('   ⚠️ 켈리 음수/최소 — 현재 R/R로는 최소 포지션($10) 권장');
      }
      console.log('');
    }
  }

  // ── 7. RAG 저장 (분석 결과 영구 기록) ────────────────────────────────
  try {
    const ragSummary =
      `[R/R 분석 ${kst.today()}] ` +
      `총 ${total}건 | 승률 ${winRate}% | 실현 R/R ${currentRR} | ` +
      `평균승 +${avgWin.toFixed(3)}% 평균패 ${avgLoss.toFixed(3)}%`;
    await rag.store('trades', ragSummary, {
      type:        'rr_analysis',
      total_trades: total,
      win_rate:    parseFloat(winRate),
      current_rr:  parseFloat(currentRR) || null,
      days:        DAYS,
      event_type:  'rr_analysis_rag',
    }, 'nemesis');
    console.log('✅ [RAG] R/R 분석 결과 rag_trades 저장 완료');
  } catch (e) {
    console.warn('⚠️ [RAG] 저장 실패 (무시):', e.message);
  }

  if (SHOULD_VALIDATE_BACKTEST) {
    console.log('');
    await validateRRWithBacktest(SYMBOL, DAYS);
  }

  process.exit(0);
}

analyzeRR().catch(e => {
  console.error('❌ 분석 실패:', e?.message || String(e));
  process.exit(1);
});

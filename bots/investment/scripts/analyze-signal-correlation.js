#!/usr/bin/env node
/**
 * scripts/analyze-signal-correlation.js — 분석 봇 신호 조합별 승률 분석
 *
 * signals.analyst_signals (루나가 기록한 4인 패턴) + trade_journal.pnl_percent를
 * signal_id로 JOIN하여 조합별 승률/기대값을 도출한다.
 *
 * 실행: node scripts/analyze-signal-correlation.js [--days=90]
 */

import { createRequire } from 'module';
import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';

const _require = createRequire(import.meta.url);
const rag      = _require('../../../packages/core/lib/rag-safe');
const kst      = _require('../../../packages/core/lib/kst');

const args    = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS    = daysArg ? parseInt(daysArg.split('=')[1]) : 90;

async function analyzeCorrelation() {
  console.log(`=== 분석 봇 신호 상관관계 분석 (최근 ${DAYS}일) ===\n`);

  await journalDb.initJournalSchema();

  const sinceMs = Date.now() - DAYS * 86_400_000;

  // ── 1. analyst_signals가 기록된 종료 매매 조회 ────────────────────
  // trade_journal.created_at: BIGINT(ms) / signals.created_at: TIMESTAMP
  const trades = await db.query(`
    SELECT
      s.analyst_signals,
      j.pnl_percent,
      j.symbol,
      j.direction
    FROM investment.trade_journal j
    JOIN investment.signals       s ON j.signal_id = s.id
    WHERE j.status  IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
      AND j.exit_time IS NOT NULL
      AND s.analyst_signals IS NOT NULL
      AND j.created_at >= $1
    ORDER BY j.created_at DESC
  `, [sinceMs]);

  if (!trades || trades.length === 0) {
    console.log('⬜ analyst_signals 데이터 없음');
    console.log('   → 루나가 신호 저장 시 analyst_signals를 기록합니다.');
    console.log('   → 최소 10건 이상 쌓이면 유의미한 분석이 가능합니다.');
    process.exit(0);
  }

  console.log(`1. 데이터: ${trades.length}건\n`);

  // ── 2. 패턴별 그룹화 ──────────────────────────────────────────────
  const patternMap = {};
  for (const t of trades) {
    const pattern = t.analyst_signals;
    if (!patternMap[pattern]) patternMap[pattern] = { wins: 0, losses: 0, totalPnl: 0 };
    const pnl = parseFloat(t.pnl_percent || 0);
    if (pnl > 0) patternMap[pattern].wins++;
    else         patternMap[pattern].losses++;
    patternMap[pattern].totalPnl += pnl;
  }

  const sorted = Object.entries(patternMap)
    .map(([pattern, data]) => {
      const total      = data.wins + data.losses;
      const winRate    = (data.wins / total * 100).toFixed(1);
      const expectancy = (data.totalPnl / total).toFixed(3);
      return { pattern, ...data, total, winRate, expectancy };
    })
    .sort((a, b) => parseFloat(b.expectancy) - parseFloat(a.expectancy));

  console.log('2. 신호 조합별 성과\n');
  console.log('   패턴'.padEnd(25), '건수'.padStart(4), '승률'.padStart(8), '기대값'.padStart(8), '총PnL'.padStart(10));
  console.log('   ' + '─'.repeat(62));
  for (const s of sorted) {
    const marker = parseFloat(s.expectancy) > 0 ? '✅' : '❌';
    console.log(
      `   ${marker} ${s.pattern.padEnd(22)} ${String(s.total).padStart(4)}` +
      `  ${s.winRate.padStart(6)}%  ${s.expectancy.padStart(6)}%  ${s.totalPnl.toFixed(2).padStart(9)}%`
    );
  }

  // ── 3. 합의도별 성과 (A/O/H/S 패턴 파싱) ─────────────────────────
  console.log('\n3. 합의도별 성과\n');

  const consensusMap = { '4/4': [0,0,0], '3/4': [0,0,0], '2/4': [0,0,0] };
  for (const t of trades) {
    const parts = (t.analyst_signals || '').split('|');
    const bullish = parts.filter(p => p.endsWith(':B')).length;
    const bearish = parts.filter(p => p.endsWith(':S')).length;
    const maxAgreement = Math.max(bullish, bearish);
    const pnl = parseFloat(t.pnl_percent || 0);
    const key = maxAgreement === 4 ? '4/4' : maxAgreement === 3 ? '3/4' : '2/4';
    if (pnl > 0) consensusMap[key][0]++;
    else         consensusMap[key][1]++;
    consensusMap[key][2] += pnl;
  }
  for (const [consensus, [w, l, pnl]] of Object.entries(consensusMap)) {
    const total = w + l;
    if (total === 0) continue;
    const wr  = (w / total * 100).toFixed(1);
    const exp = (pnl / total).toFixed(3);
    const marker = parseFloat(exp) > 0 ? '✅' : '❌';
    console.log(`   ${marker} ${consensus} 합의: ${total}건 | 승률 ${wr}% | 기대값 ${exp}%`);
  }

  // ── 4. 봇별 개별 정확도 (A/O/H/S) ─────────────────────────────────
  console.log('\n4. 봇별 예측 정확도\n');

  const botStats = { A: [0,0], O: [0,0], H: [0,0], S: [0,0] }; // [correct, total]
  for (const t of trades) {
    const parts = (t.analyst_signals || '').split('|');
    const pnl   = parseFloat(t.pnl_percent || 0);
    const actual = pnl > 0 ? 'B' : 'S'; // 실제 결과 방향
    for (const part of parts) {
      const [bot, sig] = part.split(':');
      if (sig === 'N') continue;
      botStats[bot][1]++; // total
      if (sig === actual) botStats[bot][0]++; // correct
    }
  }
  const botLabels = { A: '아리아(TA)', O: '오라클(온체인)', H: '헤르메스(뉴스)', S: '소피아(감성)' };
  for (const [bot, [correct, total]] of Object.entries(botStats)) {
    if (total === 0) { console.log(`   ${botLabels[bot]}: 데이터 없음`); continue; }
    const acc    = (correct / total * 100).toFixed(1);
    const marker = parseFloat(acc) >= 55 ? '✅' : parseFloat(acc) >= 45 ? '🟡' : '❌';
    console.log(`   ${marker} ${botLabels[bot]}: ${acc}% (${correct}/${total}건 일치)`);
  }

  // ── 5. 권장 사항 ─────────────────────────────────────────────────
  console.log('\n5. 권장 사항');
  if (sorted.length > 0 && parseFloat(sorted[0].expectancy) > 0) {
    console.log(`   최고 조합: ${sorted[0].pattern} (기대값 ${sorted[0].expectancy}%, ${sorted[0].total}건)`);
  }
  const worst = sorted.at(-1);
  if (worst && parseFloat(worst.expectancy) < -0.1) {
    console.log(`   최악 조합: ${worst.pattern} → 진입 자제 권장`);
  }
  console.log('   → 4/4 완전 합의 시 최고 신뢰도로 진입');
  console.log('   → 2/4 분열 신호 시 HOLD 또는 포지션 50% 축소 권장');
  console.log('   → analyze-rr.js와 함께 주간 리뷰에서 참조');
  console.log('');

  // ── 6. RAG 저장 ──────────────────────────────────────────────────
  try {
    await rag.initSchema();
    const topPattern = sorted.length > 0 ? sorted[0] : null;
    const ragSummary =
      `[신호 상관관계 분석 ${kst.today()}] ` +
      `${trades.length}건 | ` +
      `최고 조합: ${topPattern?.pattern || 'N/A'} (기대값 ${topPattern?.expectancy || 'N/A'}%)`;
    await rag.store('trades', ragSummary, {
      type:             'signal_correlation',
      total_trades:     trades.length,
      best_pattern:     topPattern?.pattern    || null,
      best_expectancy:  topPattern ? parseFloat(topPattern.expectancy) : null,
      days:             DAYS,
    }, 'luna');
    console.log('✅ [RAG] 상관관계 분석 결과 저장');
  } catch (e) {
    console.warn('⚠️ [RAG] 저장 실패 (무시):', e.message);
  }

  process.exit(0);
}

analyzeCorrelation().catch(e => {
  console.error('❌ 분석 실패:', e.message);
  process.exit(1);
});

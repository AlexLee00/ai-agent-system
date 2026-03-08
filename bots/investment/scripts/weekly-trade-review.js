#!/usr/bin/env node
/**
 * scripts/weekly-trade-review.js — 루나팀 주간 매매 자기반성
 *
 * 기능:
 *   - 최근 7일 trade_journal 조회 (종료 거래)
 *   - LLM(Groq Scout) 자동 분석 → 잘한 점 / 개선점 / 다음 주 전략
 *   - RAG 저장 (rag_trades 컬렉션 — 향후 luna.js가 과거 피드백 참조)
 *   - 텔레그램 리포트 전송 (publishToMainBot)
 *
 * 실행:
 *   node scripts/weekly-trade-review.js
 *   node scripts/weekly-trade-review.js --days=14   (기간 변경)
 *   node scripts/weekly-trade-review.js --dry-run   (텔레그램 미전송)
 *
 * launchd: 매주 일요일 18:00 KST 실행 (ai.investment.weekly-review)
 */

import { createRequire } from 'module';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import * as db from '../shared/db.js';

const require = createRequire(import.meta.url);
const pgPool  = require('../../../packages/core/lib/pg-pool');

// ─── 설정 ────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS   = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
const DRY_RUN = args.includes('--dry-run');

// ─── DB 조회 ─────────────────────────────────────────────────────────

/**
 * 최근 N일 종료 거래 조회 (PostgreSQL trade_journal)
 * @param {number} days
 * @returns {Promise<Array>}
 */
async function fetchRecentTrades(days) {
  const since = Date.now() - days * 86_400_000;
  const { rows } = await pgPool.query(`
    SELECT
      symbol, exchange, direction, is_paper,
      entry_time, entry_price, entry_size, entry_value,
      exit_time, exit_price, exit_value, exit_reason,
      pnl_amount, pnl_percent, pnl_net, fee_total,
      hold_duration, status
    FROM investment.trade_journal
    WHERE exit_time >= $1
      AND status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
    ORDER BY exit_time DESC
    LIMIT 200
  `, [since]);
  return rows;
}

/**
 * 최근 N일 신호 수 집계 (DuckDB signals)
 */
async function fetchSignalStats(days) {
  try {
    const since = Date.now() - days * 86_400_000;
    const rows  = await db.query(
      `SELECT action, COUNT(*) AS cnt FROM investment.signals
       WHERE created_at >= ? GROUP BY action`,
      [since]
    );
    return rows.reduce((m, r) => ({ ...m, [r.action]: Number(r.cnt) }), {});
  } catch {
    return {};
  }
}

// ─── 분석 요약 생성 ───────────────────────────────────────────────────

function buildTradeSummary(trades, signalStats) {
  if (trades.length === 0) return '해당 기간 종료 거래 없음';

  const closed   = trades.filter(t => !t.is_paper);
  const paper    = trades.filter(t => t.is_paper);
  const wins     = trades.filter(t => (t.pnl_net ?? 0) > 0).length;
  const losses   = trades.filter(t => (t.pnl_net ?? 0) <= 0).length;
  const winRate  = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0.0';
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
  const avgHold  = trades.reduce((s, t) => s + (t.hold_duration ?? 0), 0) / (trades.length || 1);
  const avgHoldH = (avgHold / 3_600_000).toFixed(1);

  // 심볼별 집계
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, cnt: 0, wins: 0 };
    bySymbol[t.symbol].pnl  += t.pnl_net ?? 0;
    bySymbol[t.symbol].cnt  += 1;
    if ((t.pnl_net ?? 0) > 0) bySymbol[t.symbol].wins += 1;
  }

  // 종료 사유 집계
  const byReason = {};
  for (const t of trades) {
    const r = t.exit_reason || 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
  }

  const lines = [
    `=== 최근 ${DAYS}일 매매 요약 ===`,
    `총 거래: ${trades.length}건 (실투자 ${closed.length}건 / 모의 ${paper.length}건)`,
    `승률: ${winRate}% (${wins}승 ${losses}패)`,
    `총 손익(net): $${totalPnl.toFixed(2)}`,
    `평균 보유시간: ${avgHoldH}시간`,
    ``,
    `심볼별 성과:`,
    ...Object.entries(bySymbol)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .map(([sym, v]) => `  ${sym}: $${v.pnl.toFixed(2)} (${v.cnt}건, 승률 ${((v.wins/v.cnt)*100).toFixed(0)}%)`),
    ``,
    `종료 사유:`,
    ...Object.entries(byReason).map(([r, n]) => `  ${r}: ${n}건`),
  ];

  if (Object.keys(signalStats).length > 0) {
    lines.push(``, `신호 생성 (전체):`,
      ...Object.entries(signalStats).map(([a, n]) => `  ${a}: ${n}건`)
    );
  }

  return lines.join('\n');
}

// ─── LLM 자기반성 ────────────────────────────────────────────────────

const REVIEW_SYSTEM = `당신은 루나팀 수석 퀀트 애널리스트입니다.
지난 주 자동매매 실적을 냉정하게 분석하여 개선 방안을 제시하세요.
데이터 기반으로만 판단하며, 억지 낙관론·비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{
  "overall_grade": "A|B|C|D",
  "highlights": ["잘한 점 1", "잘한 점 2"],
  "issues": ["문제점 1", "문제점 2"],
  "improvements": ["개선 방안 1", "개선 방안 2"],
  "next_week_strategy": "다음 주 전략 요약 (80자 이내, 한국어)",
  "risk_alert": "주의할 리스크 (있으면 기술, 없으면 null)"
}`.trim();

async function runLLMReview(tradeSummary) {
  const userMsg = `${tradeSummary}\n\n위 실적을 분석하고 개선 방안을 제시하세요.`;
  const raw     = await callLLM('hermes', REVIEW_SYSTEM, userMsg, 512);
  return parseJSON(raw);
}

// ─── RAG 저장 ─────────────────────────────────────────────────────────

async function storeReviewToRAG(summary, review, trades) {
  try {
    const rag     = require('../../../packages/core/lib/rag');
    const content = [
      `주간 리뷰 (${DAYS}일): 등급=${review.overall_grade}`,
      `개선점: ${(review.issues || []).join(' / ')}`,
      `전략: ${review.next_week_strategy || ''}`,
    ].join(' | ');
    await rag.store('trades', content, {
      type:       'weekly_review',
      grade:      review.overall_grade,
      trade_cnt:  trades.length,
      period_days: DAYS,
      ts:         Date.now(),
    }, 'luna');
    console.log('  ✅ [RAG] 주간 리뷰 저장 완료');
  } catch (e) {
    console.warn('  ⚠️ [RAG] 저장 실패 (무시):', e.message);
  }
}

// ─── 텔레그램 포맷 ───────────────────────────────────────────────────

function buildTelegramMessage(trades, review) {
  const gradeEmoji = { A: '🏆', B: '✅', C: '⚠️', D: '❌' }[review.overall_grade] || '📊';
  const pnl = trades.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
  const wins = trades.filter(t => (t.pnl_net ?? 0) > 0).length;
  const wr   = trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0';

  const lines = [
    `${gradeEmoji} 루나팀 주간 리뷰 (최근 ${DAYS}일)`,
    ``,
    `📊 실적: ${trades.length}건 | 승률 ${wr}% | 손익 $${pnl.toFixed(2)}`,
    ``,
  ];

  if (review.highlights?.length) {
    lines.push(`✨ 잘한 점`);
    review.highlights.forEach(h => lines.push(`  • ${h}`));
    lines.push('');
  }
  if (review.issues?.length) {
    lines.push(`🔍 문제점`);
    review.issues.forEach(i => lines.push(`  • ${i}`));
    lines.push('');
  }
  if (review.improvements?.length) {
    lines.push(`💡 개선 방안`);
    review.improvements.forEach(i => lines.push(`  • ${i}`));
    lines.push('');
  }
  if (review.next_week_strategy) {
    lines.push(`📅 다음 주 전략: ${review.next_week_strategy}`);
  }
  if (review.risk_alert) {
    lines.push(`⚠️ 리스크 주의: ${review.risk_alert}`);
  }

  return lines.join('\n');
}

// ─── 메인 ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📋 [주간 리뷰] 최근 ${DAYS}일 매매 분석 시작...`);

  await db.initSchema();

  const [trades, signalStats] = await Promise.all([
    fetchRecentTrades(DAYS),
    fetchSignalStats(DAYS),
  ]);

  console.log(`  📊 종료 거래 ${trades.length}건 조회`);

  if (trades.length === 0) {
    console.log('  ℹ️ 분석할 거래 없음 — 종료');
    process.exit(0);
  }

  const summary = buildTradeSummary(trades, signalStats);
  console.log('\n' + summary);

  console.log('\n  🤖 LLM 자기반성 분석 중...');
  const review = await runLLMReview(summary);

  if (!review) {
    console.error('  ❌ LLM 응답 파싱 실패');
    process.exit(1);
  }

  console.log(`  → 등급: ${review.overall_grade}`);
  console.log(`  → 전략: ${review.next_week_strategy}`);

  await storeReviewToRAG(summary, review, trades);

  if (!DRY_RUN) {
    const msg = buildTelegramMessage(trades, review);
    publishToMainBot({ from_bot: 'luna', event_type: 'weekly_review', alert_level: 1, message: msg });
    console.log('  ✅ 텔레그램 발송 완료');
  } else {
    console.log('\n--- 텔레그램 미리보기 (dry-run) ---');
    console.log(buildTelegramMessage(trades, review));
  }

  console.log('\n✅ [주간 리뷰] 완료');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ [주간 리뷰] 오류:', e.message);
  process.exit(1);
});

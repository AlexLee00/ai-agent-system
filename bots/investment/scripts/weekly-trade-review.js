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
import { validateTradeReview } from './validate-trade-review.js';

const require = createRequire(import.meta.url);
const pgPool  = require('../../../packages/core/lib/pg-pool');

function getMarketBucket(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function getMarketLabel(bucket) {
  return bucket === 'domestic' ? '국내장' : bucket === 'overseas' ? '해외장' : '암호화폐';
}

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
  const rows = await pgPool.query('investment', `
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

async function fetchRecentTradeReviews(days) {
  const since = Date.now() - days * 86_400_000;
  return pgPool.query('investment', `
    SELECT
      j.trade_id,
      j.exchange,
      j.is_paper,
      j.pnl_percent,
      r.max_favorable,
      r.max_adverse,
      r.signal_accuracy,
      r.execution_speed,
      r.aria_accurate,
      r.sophia_accurate,
      r.oracle_accurate,
      r.hermes_accurate
    FROM trade_journal j
    LEFT JOIN trade_review r ON r.trade_id = j.trade_id
    WHERE j.exit_time >= $1
      AND j.status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
    ORDER BY j.exit_time DESC
    LIMIT 200
  `, [since]);
}

/**
 * 최근 N일 신호 수 집계 (DuckDB signals)
 */
async function fetchSignalStats(days) {
  try {
    const since = Date.now() - days * 86_400_000;
    const rows  = await db.query(
      `SELECT exchange, action, COUNT(*) AS cnt FROM investment.signals
       WHERE created_at >= ? GROUP BY exchange, action`,
      [since]
    );
    return rows;
  } catch {
    return [];
  }
}

// ─── 분석 요약 생성 ───────────────────────────────────────────────────

function buildTradeSummary(trades, signalStats, rrSection = null) {
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

  const marketBuckets = ['crypto', 'domestic', 'overseas'];
  const byMarket = Object.fromEntries(marketBuckets.map(bucket => [bucket, trades.filter(t => getMarketBucket(t.exchange) === bucket)]));
  lines.push('', '시장별 거래 요약:');
  for (const bucket of marketBuckets) {
    const rows = byMarket[bucket];
    if (rows.length === 0) {
      lines.push(`  ${getMarketLabel(bucket)}: 거래 없음`);
      continue;
    }
    const pnl = rows.reduce((sum, row) => sum + (row.pnl_net ?? 0), 0);
    const winsInMarket = rows.filter(row => (row.pnl_net ?? 0) > 0).length;
    const wrInMarket = ((winsInMarket / rows.length) * 100).toFixed(1);
    lines.push(`  ${getMarketLabel(bucket)}: ${rows.length}건 | 승률 ${wrInMarket}% | 손익 $${pnl.toFixed(2)}`);
  }

  if (signalStats.length > 0) {
    lines.push(``, `신호 생성 (시장별):`);
    for (const bucket of marketBuckets) {
      const rows = signalStats.filter(row => getMarketBucket(row.exchange) === bucket);
      if (rows.length === 0) {
        lines.push(`  ${getMarketLabel(bucket)}: 기록 없음`);
        continue;
      }
      const text = rows
        .map(row => `${row.action}: ${Number(row.cnt)}건`)
        .join(' / ');
      lines.push(`  ${getMarketLabel(bucket)}: ${text}`);
    }
  }

  if (rrSection?.text) {
    lines.push(``, rrSection.text);
  }

  return lines.join('\n');
}

function buildReviewSection(reviewRows) {
  if (reviewRows.length === 0) return '';

  const groups = [
    { label: '실거래', rows: reviewRows.filter(row => !row.is_paper) },
    { label: '모의거래', rows: reviewRows.filter(row => row.is_paper) },
  ].filter(group => group.rows.length > 0);

  const lines = ['=== trade_review 요약 ==='];
  for (const group of groups) {
    const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const pnl = avg(group.rows.map(row => Number(row.pnl_percent)).filter(v => !Number.isNaN(v)));
    const mf = avg(group.rows.map(row => Number(row.max_favorable)).filter(v => !Number.isNaN(v)));
    const ma = avg(group.rows.map(row => Number(row.max_adverse)).filter(v => !Number.isNaN(v)));
    const signalGood = group.rows.filter(row => row.signal_accuracy === 'good').length;
    const fastExec = group.rows.filter(row => row.execution_speed === 'fast').length;
    const analystCols = ['aria_accurate', 'sophia_accurate', 'oracle_accurate', 'hermes_accurate'];
    const analystAcc = analystCols.map(col => {
      const vals = group.rows.map(row => row[col]).filter(v => v !== null && v !== undefined);
      return vals.length ? vals.filter(Boolean).length / vals.length : null;
    }).filter(v => v != null);
    const analystAvg = analystAcc.length ? analystAcc.reduce((sum, value) => sum + value, 0) / analystAcc.length : null;

    lines.push(`${group.label}: ${group.rows.length}건`);
    if (pnl != null) lines.push(`  평균 실현수익률: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
    if (mf != null || ma != null) lines.push(`  평균 MFE/MAE: ${mf != null ? `+${mf.toFixed(2)}%` : '-'} / ${ma != null ? `${ma.toFixed(2)}%` : '-'}`);
    lines.push(`  신호 적중: ${signalGood}/${group.rows.length} | 실행 fast: ${fastExec}/${group.rows.length}`);
    if (analystAvg != null) lines.push(`  분석팀 평균 정확도: ${(analystAvg * 100).toFixed(0)}%`);
  }
  return lines.join('\n');
}

// ─── R/R 분석 섹션 ───────────────────────────────────────────────────

/**
 * 주간 R/R 분석 섹션 생성
 * pnl_net / entry_value 기반으로 실현 R/R 계산
 * @param {Array} trades
 * @returns {{ text: string, winRate: number, currentRR: number|null }}
 */
function buildRRSection(trades) {
  if (trades.length === 0) return { text: '', winRate: 0, currentRR: null };

  const pnlList = trades
    .map(t => t.entry_value > 0 ? (t.pnl_net / t.entry_value) * 100 : null)
    .filter(p => p !== null);

  if (pnlList.length === 0) return { text: '', winRate: 0, currentRR: null };

  const wins   = pnlList.filter(p => p > 0);
  const losses = pnlList.filter(p => p <= 0);
  const winRate  = (wins.length / pnlList.length * 100).toFixed(1);
  const avgWin   = wins.length   > 0 ? wins.reduce((s, p)   => s + p, 0) / wins.length   : 0;
  const avgLoss  = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const currentRR = avgLoss !== 0
    ? (Math.abs(avgWin) / Math.abs(avgLoss)).toFixed(2)
    : null;

  let rrStatus = '';
  if (currentRR) {
    const v = parseFloat(currentRR);
    if (v >= 2)      rrStatus = '✅ R/R 목표(2:1) 달성';
    else if (v >= 1) rrStatus = '🟡 R/R 보통 — 개선 여지 있음';
    else             rrStatus = '🔴 R/R 경고 — 손절 대비 수익 부족';
  }

  // 켈리 포지션 인라인 계산 (순환 의존 방지)
  let kellyLine = '';
  if (currentRR !== null && wins.length > 0) {
    const p    = wins.length / pnlList.length;
    const b    = parseFloat(currentRR);
    if (b > 0) {
      const kelly     = (p * b - (1 - p)) / b;
      const halfKelly = kelly > 0 ? Math.min(kelly / 2, 0.05) : 0.01;
      kellyLine = `Half Kelly 권장 포지션: ${(halfKelly * 100).toFixed(1)}%`;
    }
  }

  const lines = [
    `=== R/R 분석 (실현값) ===`,
    `승률: ${winRate}% | 평균 승: +${avgWin.toFixed(3)}% | 평균 패: ${avgLoss.toFixed(3)}%`,
    `실현 R/R: ${currentRR ?? 'N/A'} (기준: 고정 TP 6% / SL 3% = 2:1)`,
  ];
  if (rrStatus)   lines.push(`→ ${rrStatus}`);
  if (kellyLine)  lines.push(`켈리: ${kellyLine}`);
  lines.push(`(상세 시뮬레이션: node scripts/analyze-rr.js)`);

  return { text: lines.join('\n'), winRate: parseFloat(winRate), currentRR: currentRR ? parseFloat(currentRR) : null };
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

async function runLLMReview(tradeSummary, reviewSection = '') {
  const userMsg = `${tradeSummary}${reviewSection ? `\n\n${reviewSection}` : ''}\n\n위 실적을 분석하고 개선 방안을 제시하세요.`;
  const raw     = await callLLM('hermes', REVIEW_SYSTEM, userMsg, 512);
  return parseJSON(raw);
}

// ─── RAG 저장 ─────────────────────────────────────────────────────────

async function storeReviewToRAG(summary, review, trades, rrSection = null) {
  try {
    const rag     = require('../../../packages/core/lib/rag-safe');
    const rrStr   = rrSection?.currentRR != null ? ` | R/R ${rrSection.currentRR} 승률 ${rrSection.winRate}%` : '';
    const content = [
      `주간 리뷰 (${DAYS}일): 등급=${review.overall_grade}${rrStr}`,
      `개선점: ${(review.issues || []).join(' / ')}`,
      `전략: ${review.next_week_strategy || ''}`,
    ].join(' | ');
    await rag.store('trades', content, {
      type:        'weekly_review',
      grade:       review.overall_grade,
      trade_cnt:   trades.length,
      period_days: DAYS,
      rr_ratio:    rrSection?.currentRR ?? null,
      win_rate:    rrSection?.winRate   ?? null,
      ts:          Date.now(),
    }, 'luna');
    console.log('  ✅ [RAG] 주간 리뷰 저장 완료');
  } catch (e) {
    console.warn('  ⚠️ [RAG] 저장 실패 (무시):', e.message);
  }
}

// ─── 텔레그램 포맷 ───────────────────────────────────────────────────

function buildTelegramMessage(trades, review, rrSection = null) {
  const gradeEmoji = { A: '🏆', B: '✅', C: '⚠️', D: '❌' }[review.overall_grade] || '📊';
  const pnl = trades.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
  const wins = trades.filter(t => (t.pnl_net ?? 0) > 0).length;
  const wr   = trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0';

  const lines = [
    `${gradeEmoji} 루나팀 주간 리뷰 (최근 ${DAYS}일)`,
    ``,
    `📊 실적: ${trades.length}건 | 승률 ${wr}% | 손익 $${pnl.toFixed(2)}`,
  ];

  if (rrSection?.currentRR != null) {
    const rrEmoji = rrSection.currentRR >= 2 ? '✅' : rrSection.currentRR >= 1 ? '🟡' : '🔴';
    lines.push(`${rrEmoji} R/R: ${rrSection.currentRR} (기준 2:1)`);
  }
  lines.push('');

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
  const validation = await validateTradeReview({ days: DAYS, fix: true });
  if (validation.findings > 0) {
    console.log(`  🩺 trade_review 정합성 보정: ${validation.findings}건 점검, ${validation.fixed}건 처리`);
  }

  const [trades, signalStats, reviewRows] = await Promise.all([
    fetchRecentTrades(DAYS),
    fetchSignalStats(DAYS),
    fetchRecentTradeReviews(DAYS),
  ]);

  console.log(`  📊 종료 거래 ${trades.length}건 조회`);

  if (trades.length === 0) {
    console.log('  ℹ️ 분석할 거래 없음 — 종료');
    process.exit(0);
  }

  const rrSection = buildRRSection(trades);
  if (rrSection.text) console.log('\n' + rrSection.text);
  const reviewSection = buildReviewSection(reviewRows);
  if (reviewSection) console.log('\n' + reviewSection);

  const summary = buildTradeSummary(trades, signalStats, rrSection) + (reviewSection ? `\n\n${reviewSection}` : '');
  console.log('\n' + summary);

  console.log('\n  🤖 LLM 자기반성 분석 중...');
  const review = await runLLMReview(summary, reviewSection);

  if (!review) {
    console.error('  ❌ LLM 응답 파싱 실패');
    process.exit(1);
  }

  console.log(`  → 등급: ${review.overall_grade}`);
  console.log(`  → 전략: ${review.next_week_strategy}`);

  await storeReviewToRAG(summary, review, trades, rrSection);

  if (!DRY_RUN) {
    const msg = buildTelegramMessage(trades, review, rrSection);
    publishToMainBot({ from_bot: 'luna', event_type: 'weekly_review', alert_level: 1, message: msg });
    console.log('  ✅ 텔레그램 발송 완료');
  } else {
    console.log('\n--- 텔레그램 미리보기 (dry-run) ---');
    console.log(buildTelegramMessage(trades, review, rrSection));
  }

  console.log('\n✅ [주간 리뷰] 완료');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ [주간 리뷰] 오류:', e?.message || String(e));
  process.exit(1);
});

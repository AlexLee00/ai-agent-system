#!/usr/bin/env node
'use strict';

/**
 * scripts/performance-report.js — 루나팀 드라이런 성과 리포트
 *
 * 사용법:
 *   node scripts/performance-report.js             # 일간 리포트 (오늘)
 *   node scripts/performance-report.js --mode=weekly  # 주간 리포트 (최근 7일)
 *   node scripts/performance-report.js --telegram      # 텔레그램 발송
 *   node scripts/performance-report.js --date=2026-03-01  # 특정 날짜
 */

const db       = require('../lib/db');
const { loadSecrets } = require('../lib/secrets');
const https    = require('https');

const args     = process.argv.slice(2);
const MODE     = args.find(a => a.startsWith('--mode='))?.split('=')[1] || 'daily';
const TELEGRAM = args.includes('--telegram');
const DATE_ARG = args.find(a => a.startsWith('--date='))?.split('=')[1];

// ─── 기간 계산 ──────────────────────────────────────────────────────

function getPeriod() {
  const base = DATE_ARG ? new Date(DATE_ARG) : new Date();
  base.setHours(0, 0, 0, 0);

  if (MODE === 'weekly') {
    const from = new Date(base);
    from.setDate(from.getDate() - 6);
    return { from, to: base, label: `최근 7일 (${fmt(from)} ~ ${fmt(base)})` };
  }
  return { from: base, to: base, label: fmt(base) };
}

function fmt(d) {
  // KST 기준 날짜 문자열 (YYYY-MM-DD)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function fmtKST(d) {
  return new Date(d).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── DB 쿼리 ────────────────────────────────────────────────────────

async function queryTrades(from, to) {
  return db.query(`
    SELECT * FROM trades
    WHERE executed_at::DATE >= ? AND executed_at::DATE <= ?
    ORDER BY executed_at ASC
  `, [fmt(from), fmt(to)]);
}

async function querySignals(from, to) {
  return db.query(`
    SELECT action, status, COUNT(*) as cnt
    FROM signals
    WHERE created_at::DATE >= ? AND created_at::DATE <= ?
    GROUP BY action, status
  `, [fmt(from), fmt(to)]);
}

async function queryAnalysisCount(from, to) {
  const rows = await db.query(`
    SELECT COUNT(*) as cnt FROM analysis
    WHERE created_at::DATE >= ? AND created_at::DATE <= ?
  `, [fmt(from), fmt(to)]);
  return rows[0]?.cnt ?? 0;
}

// ─── 지표 계산 ──────────────────────────────────────────────────────

function calcPnL(trades) {
  let realizedPnL = 0;
  let buyTotal    = 0;
  let sellTotal   = 0;

  for (const t of trades) {
    if (t.side === 'buy')  buyTotal  += (t.total_usdt || 0);
    if (t.side === 'sell') sellTotal += (t.total_usdt || 0);
  }
  realizedPnL = sellTotal - buyTotal;
  return { realizedPnL, buyTotal, sellTotal };
}

function calcWinRate(trades) {
  // 심볼별 buy→sell 매칭으로 승률 계산
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { buys: [], sells: [] };
    if (t.side === 'buy')  bySymbol[t.symbol].buys.push(t);
    if (t.side === 'sell') bySymbol[t.symbol].sells.push(t);
  }

  let wins = 0, losses = 0;
  for (const [, { buys, sells }] of Object.entries(bySymbol)) {
    const avgBuy = buys.length
      ? buys.reduce((s, t) => s + (t.price || 0), 0) / buys.length
      : null;
    for (const sell of sells) {
      if (avgBuy === null) continue;
      if ((sell.price || 0) > avgBuy) wins++;
      else losses++;
    }
  }

  const total = wins + losses;
  return { wins, losses, total, rate: total > 0 ? (wins / total * 100).toFixed(1) : 'N/A' };
}

function signalSummary(rows) {
  const result = { BUY: 0, SELL: 0, HOLD: 0, executed: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    const action = r.action?.toUpperCase();
    if (action in result) result[action] += Number(r.cnt);
    if (r.status === 'executed') result.executed += Number(r.cnt);
    if (r.status === 'failed')   result.failed   += Number(r.cnt);
    if (r.status === 'pending')  result.pending  += Number(r.cnt);
  }
  return result;
}

// ─── 리포트 포맷 ────────────────────────────────────────────────────

function formatReport({ period, trades, positions, pnl, winRate, signals, analysisCount, dryRun }) {
  const dryTag = dryRun ? ' [드라이런]' : '';
  const lines  = [];

  lines.push(`📊 루나팀 성과 리포트${dryTag}`);
  lines.push(`📅 ${period.label}`);
  lines.push('');

  // 거래 내역
  lines.push('[ 거래 내역 ]');
  if (trades.length === 0) {
    lines.push('  거래 없음');
  } else {
    for (const t of trades) {
      const side  = t.side === 'buy' ? '🟢 BUY ' : '🔴 SELL';
      const price = `$${Number(t.price || 0).toLocaleString()}`;
      const total = `$${Number(t.total_usdt || 0).toFixed(2)}`;
      lines.push(`  ${side}  ${t.symbol}  ${Number(t.amount||0).toFixed(5)} @ ${price}  ${total}  (${fmtKST(t.executed_at)})`);
    }
  }
  lines.push('');

  // 실현 손익
  const pnlSign  = pnl.realizedPnL >= 0 ? '+' : '';
  const pnlEmoji = pnl.realizedPnL >= 0 ? '📈' : '📉';
  lines.push('[ 실현 손익 ]');
  lines.push(`  ${pnlEmoji} ${pnlSign}$${pnl.realizedPnL.toFixed(2)}`);
  lines.push(`  매수 합계: $${pnl.buyTotal.toFixed(2)}  |  매도 합계: $${pnl.sellTotal.toFixed(2)}`);
  lines.push('');

  // 승률
  lines.push('[ 승률 ]');
  if (winRate.total === 0) {
    lines.push('  매도 완료 거래 없음 (open 포지션만 존재)');
  } else {
    lines.push(`  ${winRate.wins}승 ${winRate.losses}패  (${winRate.rate}%)`);
  }
  lines.push('');

  // 신호 통계
  const totalSig = signals.BUY + signals.SELL + signals.HOLD;
  lines.push('[ 신호 통계 ]');
  lines.push(`  분석 실행: ${analysisCount}회  |  신호 생성: ${totalSig}건`);
  lines.push(`  BUY ${signals.BUY}  SELL ${signals.SELL}  HOLD ${signals.HOLD}`);
  lines.push(`  실행: ${signals.executed}건  |  실패: ${signals.failed}건  |  대기: ${signals.pending}건`);
  lines.push('');

  // 현재 포지션
  lines.push('[ 현재 포지션 ]');
  if (positions.length === 0) {
    lines.push('  포지션 없음');
  } else {
    for (const p of positions) {
      const pnlSign  = (p.unrealized_pnl || 0) >= 0 ? '+' : '';
      const pnlEmoji = (p.unrealized_pnl || 0) >= 0 ? '📈' : '📉';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(5)} @ $${Number(p.avg_price).toLocaleString()}  ${pnlEmoji} ${pnlSign}$${Number(p.unrealized_pnl || 0).toFixed(2)}`);
    }
  }
  lines.push('');
  lines.push(`⏱️ 생성: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

  return lines.join('\n');
}

// ─── 텔레그램 발송 ──────────────────────────────────────────────────

function sendTelegram(text) {
  const secrets = loadSecrets();
  const token   = secrets.telegram_bot_token;
  const chatId  = secrets.telegram_chat_id;
  if (!token || !chatId) return Promise.resolve();

  const body = Buffer.from(JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }));
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  const period       = getPeriod();
  const [trades, sigRows, positions, analysisCount] = await Promise.all([
    queryTrades(period.from, period.to),
    querySignals(period.from, period.to),
    db.getAllPositions(),
    queryAnalysisCount(period.from, period.to),
  ]);

  const pnl     = calcPnL(trades);
  const winRate = calcWinRate(trades);
  const signals = signalSummary(sigRows);

  const secrets = loadSecrets();
  const report  = formatReport({
    period,
    trades,
    positions,
    pnl,
    winRate,
    signals,
    analysisCount,
    dryRun: secrets.dry_run !== false,
  });

  console.log(report);

  if (TELEGRAM) {
    await sendTelegram(report);
    console.log('\n✅ 텔레그램 발송 완료');
  }
}

main()
  .then(() => { db.close(); process.exit(0); })
  .catch(e => { console.error('❌', e.message); db.close(); process.exit(1); });

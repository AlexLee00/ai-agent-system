#!/usr/bin/env node
/**
 * scripts/trading-journal.js — 루나팀 자동매매 일지
 *
 * 기능:
 *   - DuckDB trades/signals/positions 기반 매수·매도 내역 출력
 *   - 날짜별·심볼별 손익(P&L) 계산
 *   - 미결 포지션 현황
 *   - 토큰/비용 사용 이력 (token_usage, SQLite)
 *
 * 실행:
 *   npm run journal               콘솔 출력 (기본: 오늘)
 *   npm run journal -- --days=7   최근 7일
 *   npm run journal -- --all      전체 이력
 *   npm run journal -- --telegram 텔레그램 전송
 */

import * as db from '../shared/db.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pgPool  = require('../../../packages/core/lib/pg-pool');
const kst     = require('../../../packages/core/lib/kst');

// ─── 날짜 유틸 ──────────────────────────────────────────────────────

function toKST(utcStr) {
  return new Date(new Date(utcStr).getTime() + 9 * 3600 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

function kstDateRange(days) {
  const today = kst.today();
  if (days <= 0) return { from: '2000-01-01', to: today, label: '전체 이력' };
  const from  = kst.daysAgoStr(days - 1);
  const label = days === 1 ? `오늘 (${today})` : `최근 ${days}일 (${from} ~ ${today})`;
  return { from, to: today, label };
}

// ─── 거래 내역 조회 ─────────────────────────────────────────────────

async function fetchTrades(fromDate, toDate) {
  return db.query(`
    SELECT
      t.id,
      t.symbol,
      t.side,
      t.amount,
      t.price,
      t.total_usdt,
      t.paper,
      t.exchange,
      t.executed_at,
      s.confidence,
      s.reasoning
    FROM trades t
    LEFT JOIN signals s ON t.signal_id = s.id
    WHERE CAST(t.executed_at AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    ORDER BY t.executed_at DESC
  `);
}

// ─── 포지션 조회 ────────────────────────────────────────────────────

async function fetchPositions() {
  return db.query(`
    SELECT symbol, amount, avg_price, unrealized_pnl, exchange, updated_at
    FROM positions
    WHERE amount > 0
    ORDER BY exchange, symbol
  `);
}

// ─── 심볼별 P&L 계산 (FIFO) ─────────────────────────────────────────

function calcPnl(trades) {
  // symbol → [{ amount, price }] 매수 큐
  const buyQueues = {};
  const pnlMap    = {};   // symbol → { realizedPnl, totalBuy, totalSell, buyCount, sellCount }

  // 오래된 순서로 처리 (FIFO 매칭용)
  const sorted = [...trades].sort((a, b) =>
    new Date(a.executed_at) - new Date(b.executed_at)
  );

  for (const t of sorted) {
    const sym = t.symbol;
    if (!buyQueues[sym])  buyQueues[sym]  = [];
    if (!pnlMap[sym])     pnlMap[sym]     = { realizedPnl: 0, totalBuy: 0, totalSell: 0, buyCount: 0, sellCount: 0 };

    const info = pnlMap[sym];

    if (t.side === 'buy' || t.side === 'BUY') {
      buyQueues[sym].push({ amount: t.amount, price: t.price });
      info.totalBuy  += t.total_usdt;
      info.buyCount  += 1;
    } else {
      // SELL — FIFO 매칭
      let remainSell = t.amount;
      let sellCost   = 0;
      while (remainSell > 0 && buyQueues[sym].length > 0) {
        const buyEntry = buyQueues[sym][0];
        const matched  = Math.min(remainSell, buyEntry.amount);
        sellCost      += matched * buyEntry.price;
        buyEntry.amount -= matched;
        remainSell      -= matched;
        if (buyEntry.amount < 1e-10) buyQueues[sym].shift();
      }
      const realized = t.total_usdt - sellCost;
      info.realizedPnl += realized;
      info.totalSell   += t.total_usdt;
      info.sellCount   += 1;
    }
  }

  return pnlMap;
}

// ─── 토큰 사용 이력 (PostgreSQL claude 스키마) ──────────────────────

async function fetchTokenUsage(fromDate, toDate) {
  try {
    return await pgPool.query('claude', `
      SELECT
        bot_name,
        model,
        provider,
        is_free,
        task_type,
        SUM(tokens_in)  AS total_in,
        SUM(tokens_out) AS total_out,
        SUM(tokens_in + tokens_out) AS total_tokens,
        AVG(duration_ms) AS avg_ms,
        SUM(cost_usd)   AS total_cost,
        COUNT(*)        AS call_count
      FROM token_usage
      WHERE team = 'investment' AND date_kst BETWEEN $1 AND $2
      GROUP BY bot_name, model, task_type
      ORDER BY total_tokens DESC
    `, [fromDate, toDate]);
  } catch { return []; }
}

// ─── 포맷 ───────────────────────────────────────────────────────────

function formatTrades(trades, pnlMap) {
  if (trades.length === 0) return '  거래 없음';

  const lines = [];
  let lastDate = '';

  for (const t of trades) {
    const kst  = toKST(t.executed_at);
    const date = kst.slice(0, 10);
    if (date !== lastDate) {
      lines.push(`\n  📅 ${date}`);
      lastDate = date;
    }
    const side   = (t.side === 'buy' || t.side === 'BUY') ? '🟢 매수' : '🔴 매도';
    const paper  = t.paper ? '[모의]' : '[실거래]';
    const conf   = t.confidence != null ? ` 신뢰도 ${(t.confidence * 100).toFixed(0)}%` : '';
    const sym    = t.symbol.padEnd(10);
    const price  = t.price >= 100 ? t.price.toLocaleString() : t.price.toFixed(4);
    const amt    = t.amount < 1 ? t.amount.toFixed(6) : t.amount.toFixed(2);
    const isKis  = t.exchange === 'kis';
    const total  = isKis
      ? `₩${Math.round(t.total_usdt).toLocaleString()}`
      : `$${t.total_usdt.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
    lines.push(`  ${side} ${sym} ${amt} @ ${price} = ${total} ${paper}${conf}`);
  }
  return lines.join('\n');
}

function formatPnl(pnlMap, positions) {
  const lines = [];
  const symbols = Object.keys(pnlMap);
  if (symbols.length === 0 && positions.length === 0) return '  데이터 없음';

  let totalRealized = 0;
  let totalUnrealized = 0;

  for (const sym of symbols) {
    const p     = pnlMap[sym];
    const isKis = /^\d{6}$/.test(sym); // 6자리 숫자 = KIS 종목코드
    const fmt   = (v) => isKis
      ? `₩${Math.round(v).toLocaleString()}`
      : `$${v.toFixed(4)}`;
    totalRealized += p.realizedPnl;
    const pnlStr = p.realizedPnl >= 0 ? `+${fmt(p.realizedPnl)}` : `-${fmt(Math.abs(p.realizedPnl))}`;
    const tag    = p.realizedPnl >= 0 ? '📈' : '📉';
    lines.push(`  ${tag} ${sym.padEnd(12)} 매수${p.buyCount}회/${fmt(p.totalBuy)} | 매도${p.sellCount}회/${fmt(p.totalSell)} | 실현손익: ${pnlStr}`);
  }

  // 미결 포지션
  if (positions.length > 0) {
    lines.push('');
    lines.push('  📊 미결 포지션:');
    for (const pos of positions) {
      totalUnrealized += (pos.unrealized_pnl || 0);
      const upnl = (pos.unrealized_pnl || 0) >= 0
        ? `+$${(pos.unrealized_pnl || 0).toFixed(4)}`
        : `-$${Math.abs(pos.unrealized_pnl || 0).toFixed(4)}`;
      const amt   = pos.amount < 1 ? pos.amount.toFixed(6) : pos.amount.toFixed(2);
      lines.push(`  • ${pos.symbol.padEnd(12)} ${amt}개 @ $${pos.avg_price.toFixed(2)} | 미실현: ${upnl} [${pos.exchange}]`);
    }
  }

  // 총계
  const totalStr = (totalRealized + totalUnrealized) >= 0
    ? `+$${(totalRealized + totalUnrealized).toFixed(4)}`
    : `-$${Math.abs(totalRealized + totalUnrealized).toFixed(4)}`;
  lines.push('');
  lines.push(`  💰 실현: ${totalRealized >= 0 ? '+' : ''}$${totalRealized.toFixed(4)} | 미실현: ${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toFixed(4)} | 합계: ${totalStr}`);

  return lines.join('\n');
}

function formatTokenUsage(usageRows) {
  if (usageRows.length === 0) return '  기록 없음';
  const lines = [];
  let totalCost = 0, totalTokens = 0;
  for (const r of usageRows) {
    totalCost   += r.total_cost || 0;
    totalTokens += r.total_tokens || 0;
    const tag    = r.is_free ? '무료' : `$${(r.total_cost || 0).toFixed(4)}`;
    const avgMs  = r.avg_ms != null && r.avg_ms > 0 ? `${r.avg_ms.toFixed(0)}ms` : '-';
    lines.push(`  • ${r.bot_name} [${r.model.split('/').pop()}] ${r.total_tokens.toLocaleString()}tok | 호출${r.call_count}회 | avg${avgMs} | ${tag}`);
  }
  lines.push(`\n  합계: ${totalTokens.toLocaleString()}토큰 | 비용: $${totalCost.toFixed(4)}`);
  return lines.join('\n');
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  await db.initSchema();

  const args    = process.argv.slice(2);
  const sendTg  = args.includes('--telegram');
  const allTime = args.includes('--all');
  const daysArg = args.find(a => a.startsWith('--days='));
  const days    = allTime ? 0 : daysArg ? parseInt(daysArg.split('=')[1]) : 1;

  const { from, to, label } = kstDateRange(days);

  const [trades, positions] = await Promise.all([
    fetchTrades(from, to),
    fetchPositions(),
  ]);

  const pnlMap    = calcPnl(trades);
  const tokenRows = await fetchTokenUsage(from, to);

  // ─── 출력 조립 ───
  const lines = [
    `📓 루나팀 자동매매 일지`,
    `기간: ${label}`,
    ``,
    `━━ 거래 내역 (${trades.length}건) ━━`,
    formatTrades(trades, pnlMap),
    ``,
    `━━ 손익 요약 ━━`,
    formatPnl(pnlMap, positions),
    ``,
    `━━ LLM 토큰 사용 ━━`,
    formatTokenUsage(tokenRows),
  ];

  const report = lines.join('\n');

  console.log(report);

  if (sendTg) {
    // 텔레그램 4096자 제한 — 필요 시 분할
    const chunks = [];
    const MAX    = 3800;
    for (let i = 0; i < report.length; i += MAX) {
      chunks.push(report.slice(i, i + MAX));
    }
    for (const chunk of chunks) {
      await publishToMainBot({
        from_bot:    'luna',
        event_type:  'daily_report',
        alert_level: 1,
        message:     chunk,
      });
    }
    console.log('\n✅ 텔레그램 전송 완료');
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('❌ 거래 일지 오류:', e.message);
  process.exit(1);
});

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

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMarketBucket(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function getMarketLabel(bucket) {
  return bucket === 'domestic' ? '국내장' : bucket === 'overseas' ? '해외장' : '암호화폐';
}

// ─── 날짜 유틸 ──────────────────────────────────────────────────────

function toKST(utcStr) {
  return new Date(utcStr)
    .toLocaleString('sv-SE', { timeZone: kst.TZ })
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

async function fetchClosedTradeReviews(fromDate, toDate) {
  return db.query(`
    SELECT
      j.trade_id,
      j.symbol,
      j.exchange,
      j.is_paper,
      j.pnl_net,
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
    WHERE j.status = 'closed'
      AND j.exit_time IS NOT NULL
      AND CAST(to_timestamp(j.exit_time / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE)
          BETWEEN '${fromDate}' AND '${toDate}'
    ORDER BY j.exit_time DESC
  `);
}

async function fetchSignalFunnel(fromDate, toDate) {
  const [signalRows, blockRows, blockCodeRows, analysisRows] = await Promise.all([
    db.query(`
      SELECT
        exchange,
        action,
        status,
        COUNT(*) AS cnt
      FROM signals
      WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
      GROUP BY exchange, action, status
      ORDER BY exchange, action, status
    `).catch(() => []),
    db.query(`
      SELECT
        exchange,
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COALESCE(NULLIF(block_reason, ''), 'none') AS reason,
        COUNT(*) AS cnt
      FROM signals
      WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
        AND status IN ('failed', 'rejected', 'expired')
      GROUP BY exchange, 2, 3
      ORDER BY exchange, cnt DESC
      LIMIT 12
    `).catch(() => []),
    db.query(`
      SELECT
        exchange,
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COUNT(*) AS cnt
      FROM signals
      WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
        AND status IN ('failed', 'rejected', 'expired')
      GROUP BY exchange, 2
      ORDER BY exchange, cnt DESC
      LIMIT 12
    `).catch(() => []),
    db.query(`
      SELECT
        exchange,
        analyst,
        signal,
        COUNT(*) AS cnt
      FROM analysis
      WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
      GROUP BY exchange, analyst, signal
      ORDER BY exchange, analyst, signal
    `).catch(() => []),
  ]);

  return { signalRows, blockRows, blockCodeRows, analysisRows };
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
    const tokenUsageRows = await pgPool.query('claude', `
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
      WHERE team = 'investment' AND date_kst::date BETWEEN $1::date AND $2::date
      GROUP BY bot_name, model, provider, is_free, task_type
      ORDER BY total_tokens DESC
    `, [fromDate, toDate]);

    const llmLogRows = await pgPool.query('reservation', `
      SELECT
        bot AS bot_name,
        model,
        provider,
        false AS is_free,
        request_type AS task_type,
        SUM(input_tokens) AS total_in,
        SUM(output_tokens) AS total_out,
        SUM(input_tokens + output_tokens) AS total_tokens,
        AVG(latency_ms) AS avg_ms,
        0 AS total_cost,
        COUNT(*) AS call_count
      FROM llm_usage_log
      WHERE team = 'luna'
        AND DATE(created_at AT TIME ZONE 'Asia/Seoul') BETWEEN $1::date AND $2::date
      GROUP BY bot, model, provider, request_type
      ORDER BY total_tokens DESC
    `, [fromDate, toDate]).catch(() => []);

    const merged = new Map();
    const rows = [...tokenUsageRows, ...llmLogRows];
    for (const row of rows) {
      const key = [row.bot_name || 'unknown', row.model || 'unknown', row.provider || 'unknown', row.task_type || 'general'].join('|');
      const existing = merged.get(key) || {
        bot_name: row.bot_name || 'unknown',
        model: row.model || 'unknown',
        provider: row.provider || 'unknown',
        is_free: row.is_free === true,
        task_type: row.task_type || 'general',
        total_in: 0,
        total_out: 0,
        total_tokens: 0,
        avg_ms_weighted: 0,
        total_cost: 0,
        call_count: 0,
      };
      const callCount = toNumber(row.call_count);
      const avgMs = toNumber(row.avg_ms);
      existing.is_free = existing.is_free || row.is_free === true;
      existing.total_in += toNumber(row.total_in);
      existing.total_out += toNumber(row.total_out);
      existing.total_tokens += toNumber(row.total_tokens);
      existing.total_cost += toNumber(row.total_cost);
      existing.call_count += callCount;
      existing.avg_ms_weighted += avgMs * callCount;
      merged.set(key, existing);
    }

    return [...merged.values()]
      .map(row => ({
        bot_name: row.bot_name,
        model: row.model,
        provider: row.provider,
        is_free: row.is_free,
        task_type: row.task_type,
        total_in: row.total_in,
        total_out: row.total_out,
        total_tokens: row.total_tokens,
        avg_ms: row.call_count > 0 ? row.avg_ms_weighted / row.call_count : 0,
        total_cost: row.total_cost,
        call_count: row.call_count,
      }))
      .sort((a, b) => toNumber(b.total_tokens) - toNumber(a.total_tokens));
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
    const paper  = t.paper ? '[PAPER]' : '[LIVE]';
    const confValue = toNumber(t.confidence, null);
    const conf   = confValue != null ? ` 신뢰도 ${(confValue * 100).toFixed(0)}%` : '';
    const sym    = t.symbol.padEnd(10);
    const priceValue = toNumber(t.price);
    const amountValue = toNumber(t.amount);
    const totalValue = toNumber(t.total_usdt);
    const price  = priceValue >= 100 ? priceValue.toLocaleString() : priceValue.toFixed(4);
    const amt    = amountValue < 1 ? amountValue.toFixed(6) : amountValue.toFixed(2);
    const isKis  = t.exchange === 'kis';
    const total  = isKis
      ? `₩${Math.round(totalValue).toLocaleString()}`
      : `$${totalValue.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
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
      const unrealized = toNumber(pos.unrealized_pnl);
      const amount = toNumber(pos.amount);
      const avgPrice = toNumber(pos.avg_price);
      totalUnrealized += unrealized;
      const upnl = unrealized >= 0
        ? `+$${unrealized.toFixed(4)}`
        : `-$${Math.abs(unrealized).toFixed(4)}`;
      const amt   = amount < 1 ? amount.toFixed(6) : amount.toFixed(2);
      lines.push(`  • ${pos.symbol.padEnd(12)} ${amt}개 @ $${avgPrice.toFixed(2)} | 미실현: ${upnl} [${pos.exchange}]`);
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

function formatTradeReviewStats(reviewRows) {
  if (reviewRows.length === 0) return '  종료 거래 리뷰 없음';

  const groups = [
    { key: 'live', label: 'LIVE', rows: reviewRows.filter(row => !row.is_paper) },
    { key: 'paper', label: 'PAPER', rows: reviewRows.filter(row => row.is_paper) },
  ];

  const lines = [];
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const mf = avg(group.rows.map(row => Number(row.max_favorable)).filter(v => !Number.isNaN(v)));
    const ma = avg(group.rows.map(row => Number(row.max_adverse)).filter(v => !Number.isNaN(v)));
    const pnl = avg(group.rows.map(row => Number(row.pnl_percent)).filter(v => !Number.isNaN(v)));
    const speedFast = group.rows.filter(row => row.execution_speed === 'fast').length;
    const goodSignals = group.rows.filter(row => row.signal_accuracy === 'good').length;
    const analystCols = ['aria_accurate', 'sophia_accurate', 'oracle_accurate', 'hermes_accurate'];
    const analystAcc = analystCols.map(col => {
      const values = group.rows.map(row => row[col]).filter(v => v !== null && v !== undefined);
      if (values.length === 0) return null;
      return values.filter(Boolean).length / values.length;
    }).filter(v => v != null);
    const analystAvg = analystAcc.length ? (analystAcc.reduce((sum, value) => sum + value, 0) / analystAcc.length) : null;

    lines.push(`  ■ ${group.label}: ${group.rows.length}건`);
    if (pnl != null) lines.push(`    평균 실현수익률: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
    if (mf != null || ma != null) lines.push(`    평균 MFE/MAE: ${mf != null ? `+${mf.toFixed(2)}%` : '-'} / ${ma != null ? `${ma.toFixed(2)}%` : '-'}`);
    lines.push(`    신호 적중: ${goodSignals}/${group.rows.length} | 실행 fast: ${speedFast}/${group.rows.length}`);
    if (analystAvg != null) lines.push(`    분석팀 평균 정확도: ${(analystAvg * 100).toFixed(0)}%`);
  }
  return lines.join('\n');
}

function formatTokenUsage(usageRows) {
  if (usageRows.length === 0) return '  기록 없음';
  const lines = [];
  let totalCost = 0, totalTokens = 0;
  for (const r of usageRows) {
    const totalCostValue = toNumber(r.total_cost);
    const totalTokensValue = toNumber(r.total_tokens);
    const avgMsValue = toNumber(r.avg_ms, null);
    const callCount = toNumber(r.call_count);
    const modelName = String(r.model || 'unknown').split('/').pop();
    totalCost   += totalCostValue;
    totalTokens += totalTokensValue;
    const tag    = r.is_free ? '무료' : `$${totalCostValue.toFixed(4)}`;
    const avgMs  = avgMsValue != null && avgMsValue > 0 ? `${avgMsValue.toFixed(0)}ms` : '-';
    lines.push(`  • ${r.bot_name} [${modelName}] ${totalTokensValue.toLocaleString()}tok | 호출${callCount}회 | avg${avgMs} | ${tag}`);
  }
  lines.push(`\n  합계: ${totalTokens.toLocaleString()}토큰 | 비용: $${totalCost.toFixed(4)}`);
  return lines.join('\n');
}

function buildCostEfficiencyNote(trades, usageRows) {
  const totalCost = usageRows.reduce((sum, row) => sum + toNumber(row.total_cost), 0);
  if (trades.length === 0 && totalCost >= 1) {
    return `  ⚠️ 거래 없음 대비 분석 비용이 $${totalCost.toFixed(4)} 발생했습니다. no-trade high-cost 경로를 점검하세요.`;
  }
  if (trades.length > 0 && totalCost >= 1) {
    const costPerTrade = totalCost / trades.length;
    if (costPerTrade >= 0.25) {
      return `  ⚠️ 거래 1건당 분석 비용이 $${costPerTrade.toFixed(4)}로 높습니다. 실행 효율을 함께 점검하세요.`;
    }
  }
  return '';
}

function formatSignalFunnel({ signalRows, blockRows, blockCodeRows, analysisRows }) {
  if (!signalRows.length && !blockRows.length && !blockCodeRows.length && !analysisRows.length) return '  기록 없음';

  const lines = [];
  const buckets = ['crypto', 'domestic', 'overseas'];

  for (const market of buckets) {
    const marketSignalRows = signalRows.filter(row => getMarketBucket(row.exchange) === market);
    const marketBlockRows = blockRows.filter(row => getMarketBucket(row.exchange) === market);
    const marketBlockCodeRows = blockCodeRows.filter(row => getMarketBucket(row.exchange) === market);
    const marketAnalysisRows = analysisRows.filter(row => getMarketBucket(row.exchange) === market);

    lines.push(`  ■ ${getMarketLabel(market)}`);

    if (!marketSignalRows.length && !marketBlockRows.length && !marketBlockCodeRows.length && !marketAnalysisRows.length) {
      lines.push('    기록 없음');
      lines.push('');
      continue;
    }

    const byAction = new Map();
    for (const row of marketSignalRows) {
      const action = row.action || 'UNKNOWN';
      const bucket = byAction.get(action) || { total: 0, statuses: new Map() };
      const count = Number(row.cnt || 0);
      bucket.total += count;
      bucket.statuses.set(row.status || 'unknown', count);
      byAction.set(action, bucket);
    }

    if (byAction.size > 0) {
      lines.push('    저장된 신호');
      for (const [action, bucket] of byAction) {
        const statusText = [...bucket.statuses.entries()]
          .map(([status, count]) => `${status} ${count}건`)
          .join(' / ');
        lines.push(`      ${action}: 총 ${bucket.total}건 (${statusText})`);
      }
    }

    if (marketAnalysisRows.length > 0) {
      const byAnalyst = new Map();
      for (const row of marketAnalysisRows) {
        const analyst = row.analyst || 'unknown';
        const bucket = byAnalyst.get(analyst) || { total: 0, signals: new Map() };
        const count = Number(row.cnt || 0);
        bucket.total += count;
        bucket.signals.set(row.signal || 'UNKNOWN', count);
        byAnalyst.set(analyst, bucket);
      }

      lines.push('    분석가 판단 분포');
      for (const [analyst, bucket] of byAnalyst) {
        const signalText = [...bucket.signals.entries()]
          .map(([signal, count]) => `${signal} ${count}`)
          .join(' / ');
        lines.push(`      ${analyst}: 총 ${bucket.total}건 (${signalText})`);
      }
    }

    if (marketBlockCodeRows.length > 0) {
      lines.push('    실패 코드 요약');
      for (const row of marketBlockCodeRows) {
        lines.push(`      ${row.block_code}: ${Number(row.cnt || 0)}건`);
      }
    }

    if (marketBlockRows.length > 0) {
      lines.push('    주요 차단/실패 사유');
      for (const row of marketBlockRows) {
        const code = row.block_code && row.block_code !== 'legacy_unclassified'
          ? ` [${row.block_code}]`
          : '';
        lines.push(`      ${row.reason}${code}: ${Number(row.cnt || 0)}건`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
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

  const [trades, positions, reviewRows] = await Promise.all([
    fetchTrades(from, to),
    fetchPositions(),
    fetchClosedTradeReviews(from, to),
  ]);

  const pnlMap    = calcPnl(trades);
  const tokenRows = await fetchTokenUsage(from, to);
  const funnel    = await fetchSignalFunnel(from, to);

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
    `━━ 청산 리뷰 요약 ━━`,
    formatTradeReviewStats(reviewRows),
    ``,
    `━━ 신호 퍼널 / 판단 품질 ━━`,
    formatSignalFunnel(funnel),
    ``,
    `━━ LLM 토큰 사용 ━━`,
    formatTokenUsage(tokenRows),
  ];

  const report = lines.join('\n');
  const costEfficiencyNote = buildCostEfficiencyNote(trades, tokenRows);
  const finalReport = costEfficiencyNote ? `${report}\n\n${costEfficiencyNote}` : report;

  console.log(finalReport);

  if (sendTg) {
    // 텔레그램 4096자 제한 — 필요 시 분할
    const chunks = [];
    const MAX    = 3800;
    for (let i = 0; i < finalReport.length; i += MAX) {
      chunks.push(finalReport.slice(i, i + MAX));
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
  console.error('❌ 거래 일지 오류:', e?.stack || e?.message || e);
  process.exit(1);
});

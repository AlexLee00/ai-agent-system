'use strict';

/**
 * src/reporter.js — 루나 성과 리포트 봇 (LU-022/024)
 *
 * 일간(매일 22:00) / 주간(월요일 09:00) / 월간(1일 09:00) 성과 리포트
 * 드라이런 + 실거래 모두 추적
 *
 * 실행: node src/reporter.js --type=daily|weekly|monthly [--send]
 */

const ccxt   = require('ccxt');
const db     = require('../lib/db');
const { loadSecrets } = require('../lib/secrets');
const { sendTelegram } = require('../lib/telegram');

// ─── 날짜 유틸 ─────────────────────────────────────────────────────

function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

function toKSTString(date, includeTime = false) {
  const kst = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  const base = kst.toISOString().slice(0, 10);
  if (!includeTime) return base;
  return kst.toISOString().replace('T', ' ').slice(0, 16);
}

function getDateRange(type) {
  const now  = kstNow();
  const today = toKSTString(now);

  if (type === 'daily') {
    return { from: `${today} 00:00:00`, to: `${today} 23:59:59`, label: today };
  }

  if (type === 'weekly') {
    const dow    = now.getUTCDay(); // 0=Sun
    const offset = dow === 0 ? 6 : dow - 1;
    const monday = new Date(now.getTime() - offset * 86400000);
    const from   = toKSTString(monday);
    return { from: `${from} 00:00:00`, to: `${today} 23:59:59`, label: `${from} ~ ${today}` };
  }

  if (type === 'monthly') {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return { from: `${y}-${m}-01 00:00:00`, to: `${today} 23:59:59`, label: `${y}-${m}` };
  }

  throw new Error(`알 수 없는 리포트 타입: ${type}`);
}

// ─── 현재가 조회 ────────────────────────────────────────────────────

async function fetchCurrentPrices(symbols) {
  if (!symbols.length) return {};
  const s  = loadSecrets();
  const ex = new ccxt.binance({ apiKey: s.binance_api_key, secret: s.binance_api_secret });
  const prices = {};
  for (const sym of symbols) {
    try {
      const t = await ex.fetchTicker(sym);
      prices[sym] = t.last;
    } catch (e) {
      console.warn(`  ⚠️ ${sym} 현재가 조회 실패: ${e.message}`);
    }
  }
  return prices;
}

// ─── 비용/수익 계산 헬퍼 ───────────────────────────────────────────

function tradeCost(t) {
  return t.total_usdt ?? (t.amount * t.price) ?? 0;
}

// ─── 실현 P&L 계산 ─────────────────────────────────────────────────

function calcRealizedPnl(trades) {
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { buyAmt: 0, buyUsdt: 0, sellUsdt: 0, sellAmt: 0 };
    const cost = tradeCost(t);
    if (t.side.toUpperCase() === 'BUY') {
      bySymbol[t.symbol].buyUsdt += cost;
      bySymbol[t.symbol].buyAmt  += t.amount || 0;
    } else {
      bySymbol[t.symbol].sellUsdt += cost;
      bySymbol[t.symbol].sellAmt  += t.amount || 0;
    }
  }

  let pnl = 0;
  for (const sym of Object.values(bySymbol)) {
    if (sym.buyAmt > 0 && sym.sellAmt > 0) {
      const avgBuy = sym.buyUsdt / sym.buyAmt;
      pnl += sym.sellUsdt - (sym.sellAmt * avgBuy);
    }
  }
  return pnl;
}

// ─── 리포트 빌더 ────────────────────────────────────────────────────

async function buildReport(type) {
  const { from, to, label } = getDateRange(type);
  const titleMap = { daily: '일간', weekly: '주간', monthly: '월간' };
  const title    = titleMap[type];

  // 기간 내 거래
  const periodTrades = await db.query(
    `SELECT * FROM trades
     WHERE executed_at >= ? AND executed_at <= ?
     ORDER BY executed_at ASC`,
    [from, to]
  );

  // 전체 실거래 누적 (P&L 기준선)
  const allReal = await db.query(
    `SELECT * FROM trades WHERE dry_run = false ORDER BY executed_at ASC`
  );

  // 포지션
  const positions = await db.getAllPositions();

  // 현재가 (바이낸스 포지션만)
  const cryptoSyms = [...new Set([
    ...positions.filter(p => p.exchange === 'binance').map(p => p.symbol),
    ...allReal.filter(t => t.exchange === 'binance').map(t => t.symbol),
  ])];
  const prices = await fetchCurrentPrices(cryptoSyms);

  // ─ 기간 통계 ─
  const realPeriod = periodTrades.filter(t => !t.dry_run);
  const dryPeriod  = periodTrades.filter(t =>  t.dry_run);
  const buyCnt  = periodTrades.filter(t => t.side.toUpperCase() === 'BUY').length;
  const sellCnt = periodTrades.filter(t => t.side.toUpperCase() === 'SELL').length;

  // ─ 누적 실현 P&L ─
  const realizedPnl = calcRealizedPnl(allReal);

  // ─ 미실현 P&L ─
  let unrealizedPnl = 0;
  const posLines = [];
  for (const pos of positions.filter(p => p.exchange === 'binance' && p.amount > 0)) {
    const cur = prices[pos.symbol];
    if (!cur) {
      posLines.push(`  ${pos.symbol}: ${pos.amount.toFixed(5)} (현재가 조회 불가)`);
      continue;
    }
    const pnl    = (cur - pos.avg_price) * pos.amount;
    const pnlPct = ((cur - pos.avg_price) / pos.avg_price * 100);
    unrealizedPnl += pnl;
    const sign = pnl >= 0 ? '+' : '';
    posLines.push(
      `  ${pos.symbol}: ${pos.amount.toFixed(5)} @ $${pos.avg_price.toFixed(2)} → $${cur.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%  ${sign}$${pnl.toFixed(2)})`
    );
  }

  // ─ 누적 매수/매도 총액 ─
  const totalBuyUsdt  = allReal.filter(t => t.side.toUpperCase() === 'BUY' ).reduce((s, t) => s + tradeCost(t), 0);
  const totalSellUsdt = allReal.filter(t => t.side.toUpperCase() === 'SELL').reduce((s, t) => s + tradeCost(t), 0);
  const totalPnl      = realizedPnl + unrealizedPnl;

  // ─ 메시지 구성 ─
  const L = [];

  L.push(`📊 루나 ${title} 리포트 — ${label}`);
  L.push('');

  // 거래 내역
  if (periodTrades.length === 0) {
    L.push('💱 기간 내 거래 없음');
  } else {
    L.push(`💱 거래 ${periodTrades.length}건  (매수 ${buyCnt} / 매도 ${sellCnt})`);
    const show = periodTrades.slice(-10); // 최신 10건
    for (const t of show) {
      const icon    = t.side.toUpperCase() === 'BUY' ? '🟢' : '🔴';
      const dryTag  = t.dry_run ? 'DRY' : '실';
      const cost    = tradeCost(t);
      const unit    = t.exchange === 'kis' ? '₩' : '$';
      const timeStr = toKSTString(t.executed_at, true).slice(5); // MM-DD HH:mm
      L.push(`  ${icon} [${dryTag}] ${t.side.toUpperCase()} ${t.symbol}  ${(t.amount || 0).toFixed(4)} @ ${unit}${(t.price || 0).toLocaleString()}  (${timeStr})`);
    }
    if (periodTrades.length > 10) L.push(`  … 외 ${periodTrades.length - 10}건`);
  }

  L.push('');

  // 포지션
  if (posLines.length === 0) {
    L.push('📈 보유 포지션 없음');
  } else {
    L.push('📈 포지션 현황');
    posLines.forEach(l => L.push(l));
  }

  L.push('');

  // 누적 성과
  L.push('💰 누적 성과 (실거래 기준)');
  L.push(`  총 매수: $${totalBuyUsdt.toFixed(2)}`);
  L.push(`  총 매도: $${totalSellUsdt.toFixed(2)}`);
  L.push(`  실현 손익: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`);
  L.push(`  미실현 손익: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`);
  L.push(`  📌 총 손익: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);

  if (dryPeriod.length > 0) {
    L.push('');
    L.push(`🧪 드라이런 ${dryPeriod.length}건 (시뮬레이션)`);
  }

  return L.join('\n');
}

// ─── 메인 ──────────────────────────────────────────────────────────

async function runReport(type = 'daily', send = false) {
  console.log(`\n📊 [리포터] ${type} 리포트 생성 중...`);
  await db.initSchema();

  const message = await buildReport(type);
  console.log('\n' + '─'.repeat(50));
  console.log(message);
  console.log('─'.repeat(50));

  if (send) {
    await sendTelegram(message);
    console.log('\n📱 텔레그램 전송 완료');
  }

  return message;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const type = args.find(a => a.startsWith('--type='))?.split('=')[1] || 'daily';
  const send = args.includes('--send');

  runReport(type, send)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 리포터 오류:', e.message); process.exit(1); });
}

module.exports = { runReport };

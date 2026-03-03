/**
 * team/reporter.js — 루나팀 투자 리포트 (일일 성과 요약)
 *
 * 역할: DB + 바이낸스 실시간 가격으로 성과 리포트 생성
 * 실행: node team/reporter.js [--telegram] [--days=N]
 *
 * 출력 항목:
 *   - 운영 모드 현황
 *   - 바이낸스 실잔고 (USDT + 코인)
 *   - 모의 포지션 현황 + 미실현 수익률
 *   - 신호 통계 (정확도)
 *   - 이번달 신호 일별 추이
 *   - LLM 비용
 */

import ccxt            from 'ccxt';
import { fileURLToPath } from 'url';
import * as db          from '../shared/db.js';
import { loadSecrets, isPaperMode } from '../shared/secrets.js';
import { sendTelegram } from '../shared/report.js';
import { tracker }      from '../shared/cost-tracker.js';

// ─── 바이낸스 현재가 일괄 조회 ──────────────────────────────────────

async function fetchPrices(symbols) {
  const prices = {};
  try {
    const s = loadSecrets();
    const ex = new ccxt.binance({ enableRateLimit: true });
    for (const sym of symbols) {
      try {
        const ticker = await ex.fetchTicker(sym);
        prices[sym] = ticker.last;
      } catch { prices[sym] = null; }
    }
  } catch { /* 가격 조회 실패 시 null */ }
  return prices;
}

// ─── 바이낸스 실잔고 조회 ───────────────────────────────────────────

async function fetchBinanceBalance() {
  try {
    const s  = loadSecrets();
    const ex = new ccxt.binance({
      apiKey: s.binance_api_key,
      secret: s.binance_api_secret,
      enableRateLimit: true,
    });
    const bal = await ex.fetchBalance();
    const nonZero = Object.entries(bal.total || {})
      .filter(([, v]) => v > 0)
      .map(([coin, total]) => ({ coin, free: bal.free?.[coin] || 0, total }));
    return nonZero;
  } catch (e) {
    console.warn(`  ⚠️ 바이낸스 잔고 조회 실패: ${e.message}`);
    return [];
  }
}

// ─── 날짜 헬퍼 ──────────────────────────────────────────────────────

function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstStr(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' KST';
}

// ─── 리포트 생성 ─────────────────────────────────────────────────────

export async function generateReport({ days = 30, telegram = false } = {}) {
  await db.initSchema();

  const now   = kstNow();
  const today = now.toISOString().slice(0, 10);

  // ── 1. 신호 통계 ───────────────────────────────────────────────────
  const sigStats = await db.query(`
    SELECT
      status,
      COUNT(*)::INTEGER  AS cnt,
      ROUND(AVG(confidence) * 100, 1) AS avg_conf
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY status
    ORDER BY cnt DESC
  `);

  const sigTotal    = sigStats.reduce((s, r) => s + r.cnt, 0);
  const sigExec     = sigStats.find(r => r.status === 'executed')?.cnt  || 0;
  const sigApproved = sigStats.find(r => r.status === 'approved')?.cnt  || 0;
  const sigFailed   = sigStats.find(r => r.status === 'failed')?.cnt    || 0;
  const sigHold     = sigStats.find(r => r.status === 'hold')?.cnt      || 0;

  // ── 2. 심볼별 신호 분포 ────────────────────────────────────────────
  const symStats = await db.query(`
    SELECT
      symbol,
      action,
      COUNT(*)::INTEGER AS cnt
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY symbol, action
    ORDER BY symbol, action
  `);

  // ── 3. 포지션 + 현재가 ─────────────────────────────────────────────
  const positions = await db.getAllPositions();
  const posPrices = positions.length > 0
    ? await fetchPrices(positions.map(p => p.symbol))
    : {};

  let totalUnrealizedPnl  = 0;
  let totalCostBasis      = 0;
  const posLines = [];

  for (const p of positions) {
    const currentPrice = posPrices[p.symbol];
    const costBasis    = p.amount * p.avg_price;
    totalCostBasis    += costBasis;

    if (currentPrice) {
      const value     = p.amount * currentPrice;
      const pnl       = value - costBasis;
      const pnlPct    = (pnl / costBasis * 100);
      totalUnrealizedPnl += pnl;
      const pnlSign   = pnl >= 0 ? '+' : '';
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(6)}개\n` +
        `    매수가 $${p.avg_price.toLocaleString()} → 현재가 $${currentPrice.toLocaleString()}\n` +
        `    평가금액 $${value.toFixed(2)} | 수익 ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)`
      );
    } else {
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(6)}개 @ $${p.avg_price.toLocaleString()} (현재가 조회 실패)`
      );
    }
  }

  // ── 4. 바이낸스 실잔고 ─────────────────────────────────────────────
  const balances = await fetchBinanceBalance();
  const usdtBal  = balances.find(b => b.coin === 'USDT');
  const totalBalUsd = balances.reduce((s, b) => {
    if (b.coin === 'USDT') return s + b.total;
    // 간단 추정 (정확한 계산은 각 코인 현재가 필요)
    return s;
  }, 0);

  // ── 5. LLM 비용 ────────────────────────────────────────────────────
  const cost = tracker.getToday();

  // ── 6. 거래 내역 요약 ──────────────────────────────────────────────
  const trades = await db.query(`
    SELECT
      symbol, side, amount, price, total_usdt, paper, executed_at
    FROM trades
    WHERE executed_at > now() - INTERVAL '${days} days'
    ORDER BY executed_at DESC
  `);

  const pnl = await db.getTodayPnl();

  // ─── 리포트 조립 ──────────────────────────────────────────────────
  const paperMode = isPaperMode();
  const modeTag   = paperMode ? '📄 PAPER' : '🔴 LIVE';

  const lines = [
    `📊 *루나팀 투자 리포트*`,
    `기준: ${kstStr(now)} | 최근 ${days}일`,
    ``,
    `━━━ 운영 모드 ━━━`,
    `  암호화폐: 🔴 LIVE (PAPER_MODE=false)`,
    `  국내주식:  📄 PAPER (모의투자)`,
    `  미국주식:  📄 PAPER (모의투자)`,
    ``,
  ];

  // 바이낸스 잔고
  lines.push(`━━━ 바이낸스 실잔고 ━━━`);
  if (balances.length === 0) {
    lines.push(`  조회 실패`);
  } else {
    for (const b of balances) {
      lines.push(`  ${b.coin}: ${b.total.toFixed(6)} (가용 ${b.free.toFixed(6)})`);
    }
    lines.push(`  USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`);
  }
  lines.push(``);

  // 모의 포지션
  lines.push(`━━━ 모의 포지션 현황 ━━━`);
  if (posLines.length === 0) {
    lines.push(`  포지션 없음`);
  } else {
    lines.push(...posLines);
    const pnlSign = totalUnrealizedPnl >= 0 ? '+' : '';
    const roiPct  = totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis * 100) : 0;
    lines.push(`  ─`);
    lines.push(`  총 매수원가: $${totalCostBasis.toFixed(2)}`);
    lines.push(`  미실현 PnL: ${pnlSign}$${totalUnrealizedPnl.toFixed(2)} (${pnlSign}${roiPct.toFixed(2)}%)`);
  }
  lines.push(``);

  // 신호 통계
  lines.push(`━━━ 신호 통계 (최근 ${days}일) ━━━`);
  lines.push(`  총 신호: ${sigTotal}개`);
  lines.push(`  실행(모의): ${sigExec}개 | 승인대기: ${sigApproved}개 | 잔고부족실패: ${sigFailed}개`);
  if (sigTotal > 0) {
    const execRate = ((sigExec / sigTotal) * 100).toFixed(1);
    lines.push(`  실행률: ${execRate}%`);
  }

  if (symStats.length > 0) {
    lines.push(`  심볼별:`);
    const grouped = {};
    for (const r of symStats) {
      if (!grouped[r.symbol]) grouped[r.symbol] = {};
      grouped[r.symbol][r.action] = r.cnt;
    }
    for (const [sym, actions] of Object.entries(grouped)) {
      const parts = Object.entries(actions).map(([a, c]) => `${a} ${c}`).join(' / ');
      lines.push(`    ${sym}: ${parts}`);
    }
  }
  lines.push(``);

  // 거래 내역
  lines.push(`━━━ 최근 거래 내역 ━━━`);
  if (trades.length === 0) {
    lines.push(`  거래 없음`);
  } else {
    for (const t of trades) {
      const dt    = new Date(t.executed_at);
      const dtStr = dt.toISOString().slice(5, 16).replace('T', ' ');
      const paper = t.paper ? '📄' : '🔴';
      lines.push(`  ${paper} ${dtStr} | ${t.symbol} ${t.side.toUpperCase()} ${t.amount?.toFixed(6)}개 @ $${t.price?.toLocaleString()} (≈$${t.total_usdt?.toFixed(0)})`);
    }
  }
  lines.push(``);

  // LLM 비용
  lines.push(`━━━ LLM 비용 ━━━`);
  lines.push(`  오늘: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`);
  lines.push(`  이번달: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`);
  lines.push(`  (Groq 무료 — 실비용 $0)`);

  const report = lines.join('\n');
  console.log('\n' + report);

  if (telegram) {
    await sendTelegram(report).catch(e => console.warn('  ⚠️ 텔레그램 발송 실패:', e.message));
    console.log('\n📱 텔레그램 발송 완료');
  }

  return report;
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args     = process.argv.slice(2);
  const telegram = args.includes('--telegram');
  const daysArg  = args.find(a => a.startsWith('--days='));
  const days     = daysArg ? parseInt(daysArg.split('=')[1]) : 30;

  await generateReport({ days, telegram });
  process.exit(0);
}

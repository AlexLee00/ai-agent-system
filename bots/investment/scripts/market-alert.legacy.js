/**
 * scripts/market-alert.js — 장 시작/종료 텔레그램 알림 + 장마감 매매일지 보고
 *
 * 사용:
 *   node scripts/market-alert.js --market=domestic --event=open
 *   node scripts/market-alert.js --market=domestic --event=close
 *   node scripts/market-alert.js --market=overseas  --event=open
 *   node scripts/market-alert.js --market=overseas  --event=close
 *   node scripts/market-alert.js --market=crypto    --event=daily
 *
 * launchd:
 *   ai.investment.market-alert-domestic-open   — KST 09:00
 *   ai.investment.market-alert-domestic-close  — KST 15:30
 *   ai.investment.market-alert-overseas-open   — KST 23:30
 *   ai.investment.market-alert-overseas-close  — KST 06:00
 *   ai.investment.market-alert-crypto-daily    — KST 09:00
 *   ⚠️ launchd는 로컬 시간(KST) 기준 — UTC 변환 불필요
 */

import * as db from '../shared/db.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { loadPreScreened } from './pre-market-screen.js';
import { getInvestmentProfile } from './investment-profile.js';
import { getKisMarketStatus, getKisOverseasMarketStatus } from '../shared/secrets.js';
import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');

// ── 인수 파싱 ──────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const market = args.find(a => a.startsWith('--market='))?.split('=')[1];
const event  = args.find(a => a.startsWith('--event='))?.split('=')[1];

const MARKET_LABEL = {
  domestic: '🇰🇷 국내장',
  overseas: '🇺🇸 해외장',
  crypto:   '🪙 암호화폐',
};

const DIVIDER = '──────────';

const EXCHANGE_MAP = {
  domestic: 'kis',
  overseas: 'kis_overseas',
  crypto:   'binance',
};

function formatSignedPercent(value, digits = 2) {
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`;
}

function aggregatePositionsBySymbol(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim();
    if (!symbol) continue;
    const amount = Number(row.amount || 0);
    const avgPrice = Number(row.avg_price || 0);
    const unrealized = Number(row.unrealized_pnl || 0);
    const costBasis = amount * avgPrice;
    const entry = grouped.get(symbol) || {
      symbol,
      amount: 0,
      costBasis: 0,
      unrealizedPnl: 0,
      tradeModes: new Set(),
    };
    entry.amount += amount;
    entry.costBasis += costBasis;
    entry.unrealizedPnl += unrealized;
    entry.tradeModes.add(String(row.trade_mode || 'normal'));
    grouped.set(symbol, entry);
  }

  return [...grouped.values()].map((entry) => ({
    symbol: entry.symbol,
    amount: entry.amount,
    unrealized_pnl: entry.unrealizedPnl,
    pnl_pct: entry.costBasis > 0 ? (entry.unrealizedPnl / entry.costBasis) * 100 : null,
    trade_modes: [...entry.tradeModes],
  }));
}

async function getMarketAlertStatus(market) {
  if (market === 'domestic') return getKisMarketStatus();
  if (market === 'overseas') return getKisOverseasMarketStatus();
  return { open: true, reason: '24/7 market' };
}

function shouldSkipMarketAlert(status) {
  if (!status || status.open) return false;
  const reason = String(status.reason || '');
  return /주말|휴장|holiday|Weekend/i.test(reason);
}

// KST 기준 오늘 날짜
const todayKST = () => kst.today();

// ── 메인 ──────────────────────────────────────────────────────────────

async function main() {
  const label = MARKET_LABEL[market];
  if (!label) {
    console.error('--market=domestic|overseas|crypto 필수');
    process.exit(1);
  }

  if (market !== 'crypto') {
    const status = await getMarketAlertStatus(market);
    if (shouldSkipMarketAlert(status)) {
      console.log(`[market-alert] ${label} 알림 스킵 — ${status.reason}`);
      process.exit(0);
    }
  }

  if (market === 'crypto' && event === 'daily') {
    await sendCryptoDailyReport(label);
  } else if (event === 'open') {
    await sendOpenAlert(market, label);
  } else if (event === 'close') {
    await sendCloseReport(market, label);
  } else {
    console.error('--event=open|close (또는 crypto: daily) 필수');
    process.exit(1);
  }

  process.exit(0);
}

// ── 장 시작 알림 ───────────────────────────────────────────────────────

async function sendOpenAlert(market, label) {
  const profile    = await getInvestmentProfile(market);
  const exchange   = EXCHANGE_MAP[market];
  const prescreened = loadPreScreened(market);
  const symbols    = prescreened?.symbols || [];

  // 현재 보유 포지션 (해당 거래소)
  const allPositions = await db.getAllPositions();
  const positions    = allPositions.filter(p => p.exchange === exchange && p.amount > 0);
  const aggregatedPositions = aggregatePositionsBySymbol(positions);

  const lines = [
    `📈 ${label} 장 시작!`,
    `시각: ${kst.toKST(new Date())}`,
    '',
    `[투자 성향]`,
    `  모드: ${profile.mode}`,
    `  리스크 레벨: ${profile.riskLevel}`,
    `  최대 포지션: ${profile.maxPositions}개`,
    `  트레이드당 리스크: ${profile.riskPerTrade.toFixed(0)}%`,
    `  MIN_CONF: ${profile.minConfidence}`,
    '',
  ];

  if (symbols.length > 0) {
    lines.push(`[장전 스크리닝 종목] ${symbols.join(', ')}`);
  } else {
    lines.push(`[장전 스크리닝] 종목 없음 (실시간 스크리닝 대기)`);
  }

  if (prescreened?.research?.updatedAt) {
    const updatedAt = kst.toKST(new Date(prescreened.research.updatedAt));
    lines.push(`[장외 연구] ${updatedAt} 갱신 / ${prescreened.research.symbolCount || symbols.length}개 종목`);
  }

  if (aggregatedPositions.length > 0) {
    lines.push('');
    lines.push(`[보유 포지션] ${aggregatedPositions.length}개 (심볼 합산)`);
    for (const p of aggregatedPositions) {
      const pnl = p.pnl_pct != null ? ` (${formatSignedPercent(p.pnl_pct)})` : '';
      const modes = p.trade_modes.length > 1 ? ` [${p.trade_modes.join('+')}]` : '';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(4)}주${pnl}${modes}`);
    }
  } else {
    lines.push(`[보유 포지션] 없음`);
  }

  await publishToMainBot({
    from_bot:    'luna',
    event_type:  'market_open',
    alert_level: 1,
    message:     lines.join('\n'),
    payload:     { market, exchange, symbols, positionCount: aggregatedPositions.length },
  });

  console.log(`[market-alert] ${label} 장 시작 알림 발송 완료`);
}

// ── 장 종료 + 매매일지 보고 ────────────────────────────────────────────

async function sendCloseReport(market, label) {
  const profile  = await getInvestmentProfile(market);
  const exchange = EXCHANGE_MAP[market];
  const today    = todayKST();

  // 오늘 매매 내역 (executed_at KST 기준)
  const trades = await db.query(`
    SELECT symbol, side, amount, price, total_usdt, paper, executed_at
    FROM trades
    WHERE exchange = $1
      AND DATE(executed_at + INTERVAL '9 hours') = $2
    ORDER BY executed_at
  `, [exchange, today]);

  // 오늘 신호 내역
  const signals = await db.query(`
    SELECT symbol, action, confidence
    FROM signals
    WHERE exchange = $1
      AND DATE(created_at + INTERVAL '9 hours') = $2
    ORDER BY created_at
  `, [exchange, today]);

  // 현재 보유 포지션
  const allPositions = await db.getAllPositions();
  const positions    = allPositions.filter(p => p.exchange === exchange && p.amount > 0);
  const aggregatedPositions = aggregatePositionsBySymbol(positions);
  const summarizeSymbols = (items = [], limit = 5) => {
    const values = items.filter(Boolean);
    if (values.length <= limit) return values.join(', ');
    return `${values.slice(0, limit).join(', ')} 외 ${values.length - limit}개`;
  };
  const summarizeTrades = (rows = [], limit = 3) => {
    if (rows.length === 0) return ['거래 없음'];
    const mapped = rows.slice(0, limit).map((t) => {
      const time = kst.toKST(new Date(t.executed_at)).split(' ').pop();
      return `${time} ${t.symbol} ${t.side}`;
    });
    if (rows.length > limit) mapped.push(`외 ${rows.length - limit}건`);
    return mapped;
  };
  const summarizePositions = (rows = [], limit = 3) => {
    if (rows.length === 0) return ['없음'];
    const mapped = rows.slice(0, limit).map((p) => {
      const pnl = p.pnl_pct != null
        ? ` ${formatSignedPercent(p.pnl_pct, 1)}`
        : '';
      return `${p.symbol} ${Number(p.amount).toFixed(4)}주${pnl}`;
    });
    if (rows.length > limit) mapped.push(`외 ${rows.length - limit}개`);
    return mapped;
  };

  const lines = [
    `📊 ${label} 장 마감 — 매매일지`,
    `날짜: ${today}`,
    `시각: ${kst.toKST(new Date())}`,
    '',
    DIVIDER,
    `[투자 성향]`,
    `  ${profile.mode} · ${profile.riskLevel} · MIN_CONF ${profile.minConfidence}`,
    `  손절 ${profile.stopLossPct}% · 최대 $${profile.maxOrderUsdt} · 듀얼 ${profile.dualModel ? 'ON' : 'OFF'}`,
    DIVIDER,
  ];

  // 매매 내역
  lines.push('');
  lines.push(`[매매 내역] ${trades.length > 0 ? `${trades.length}건` : '거래 없음'}`);
  for (const line of summarizeTrades(trades)) lines.push(`  ${line}`);

  // 신호 요약
  if (signals.length > 0) {
    const buyCount  = signals.filter(s => ['BUY', 'STRONG_BUY'].includes(s.action)).length;
    const sellCount = signals.filter(s => ['SELL', 'STRONG_SELL'].includes(s.action)).length;
    const holdCount = signals.filter(s => s.action === 'HOLD').length;
    const signalSymbols = summarizeSymbols([...new Set(signals.map((s) => s.symbol))]);
    lines.push('');
    lines.push(`[신호 요약] 총 ${signals.length}건 — BUY ${buyCount} / SELL ${sellCount} / HOLD ${holdCount}`);
    lines.push(`  심볼: ${signalSymbols}`);
  }

  // 보유 포지션 현황
  lines.push('');
  lines.push(`[보유 포지션] ${aggregatedPositions.length > 0 ? `${aggregatedPositions.length}개 (심볼 합산)` : '없음'}`);
  for (const line of summarizePositions(aggregatedPositions)) lines.push(`  ${line}`);

  lines.push('');
  lines.push(DIVIDER);
  lines.push(`${label} 장 마감. 수고하셨습니다! 🙏`);

  await publishToMainBot({
    from_bot:    'luna',
    event_type:  'market_close_report',
    alert_level: trades.length > 0 ? 2 : 1,
    message:     lines.join('\n'),
    payload:     { market, exchange, tradeCount: trades.length, positionCount: aggregatedPositions.length, date: today },
  });

  console.log(`[market-alert] ${label} 장 마감 매매일지 발송 완료 (거래 ${trades.length}건)`);
}

// ── 암호화폐 일일 보고 ─────────────────────────────────────────────────

async function sendCryptoDailyReport(label) {
  const profile = await getInvestmentProfile('crypto');
  const today   = todayKST();

  const trades = await db.query(`
    SELECT symbol, side, amount, price, total_usdt, paper, executed_at
    FROM trades
    WHERE exchange = 'binance'
      AND DATE(executed_at + INTERVAL '9 hours') = $1
    ORDER BY executed_at
  `, [today]);

  const allPositions = await db.getAllPositions();
  const positions    = allPositions.filter(p => p.exchange === 'binance' && p.amount > 0);
  const aggregatedPositions = aggregatePositionsBySymbol(positions);

  const lines = [
    `${label} 일일 보고`,
    `날짜: ${today}`,
    `시각: ${kst.toKST(new Date())}`,
    '',
    `[투자 성향]`,
    `  모드: ${profile.mode}`,
    `  리스크 레벨: ${profile.riskLevel}`,
    `  MIN_CONF: ${profile.minConfidence}`,
    `  손절: ${profile.stopLossPct}%`,
    '',
  ];

  if (trades.length > 0) {
    lines.push(`[24시간 매매] ${trades.length}건`);
    for (const t of trades) {
      const time  = kst.toKST(new Date(t.executed_at));
      const paper = t.paper ? ' [PAPER]' : '';
      lines.push(`  ${time} ${t.symbol} ${t.side} ${Number(t.amount).toFixed(6)} @${Number(t.price).toFixed(2)}${paper}`);
    }
  } else {
    lines.push(`[24시간 매매] 거래 없음`);
  }

  if (aggregatedPositions.length > 0) {
    lines.push('');
    lines.push(`[보유 포지션] ${aggregatedPositions.length}개 (심볼 합산)`);
    for (const p of aggregatedPositions) {
      const pnl = p.pnl_pct != null ? ` (${formatSignedPercent(p.pnl_pct)})` : '';
      const modes = p.trade_modes.length > 1 ? ` [${p.trade_modes.join('+')}]` : '';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(6)}${pnl}${modes}`);
    }
  } else {
    lines.push('');
    lines.push(`[보유 포지션] 없음`);
  }

  await publishToMainBot({
    from_bot:    'luna',
    event_type:  'crypto_daily_report',
    alert_level: 1,
    message:     lines.join('\n'),
    payload:     { market: 'crypto', tradeCount: trades.length, positionCount: aggregatedPositions.length, date: today },
  });

  console.log(`[market-alert] 암호화폐 일일 보고 발송 완료 (거래 ${trades.length}건)`);
}

// ── 실행 ──────────────────────────────────────────────────────────────

main().catch(e => {
  console.error('[market-alert] 오류:', e.message);
  process.exit(1);
});

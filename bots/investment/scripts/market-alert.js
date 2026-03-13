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

const EXCHANGE_MAP = {
  domestic: 'kis',
  overseas: 'kis_overseas',
  crypto:   'binance',
};

// KST 기준 오늘 날짜
const todayKST = () => kst.today();

// ── 메인 ──────────────────────────────────────────────────────────────

async function main() {
  const label = MARKET_LABEL[market];
  if (!label) {
    console.error('--market=domestic|overseas|crypto 필수');
    process.exit(1);
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

  if (positions.length > 0) {
    lines.push('');
    lines.push(`[보유 포지션] ${positions.length}개`);
    for (const p of positions) {
      const pnl = p.unrealized_pnl != null
        ? ` (${p.unrealized_pnl >= 0 ? '+' : ''}${Number(p.unrealized_pnl).toFixed(2)}%)`
        : '';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(4)}주${pnl}`);
    }
  } else {
    lines.push(`[보유 포지션] 없음`);
  }

  await publishToMainBot({
    from_bot:    'luna',
    event_type:  'market_open',
    alert_level: 1,
    message:     lines.join('\n'),
    payload:     { market, exchange, symbols, positionCount: positions.length },
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

  const lines = [
    `📊 ${label} 장 마감 — 매매일지`,
    `날짜: ${today}`,
    `시각: ${kst.toKST(new Date())}`,
    '',
    `━━━━━━━━━━━━━━━━━━━━━`,
    `[투자 성향]`,
    `  모드: ${profile.mode}`,
    `  리스크 레벨: ${profile.riskLevel}`,
    `  MIN_CONF: ${profile.minConfidence}`,
    `  손절: ${profile.stopLossPct}%`,
    `  최대 주문: $${profile.maxOrderUsdt}`,
    `  듀얼 모델: ${profile.dualModel ? 'ON' : 'OFF'}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
  ];

  // 매매 내역
  if (trades.length > 0) {
    lines.push('');
    lines.push(`[매매 내역] ${trades.length}건`);
    for (const t of trades) {
      const time   = kst.toKST(new Date(t.executed_at));
      const paper  = t.paper ? ' [PAPER]' : '';
      const total  = t.total_usdt ? ` ($${Number(t.total_usdt).toFixed(0)})` : '';
      lines.push(`  ${time} ${t.symbol} ${t.side} ${Number(t.amount).toFixed(4)}주 @${Number(t.price).toFixed(2)}${total}${paper}`);
    }
  } else {
    lines.push('');
    lines.push(`[매매 내역] 거래 없음`);
  }

  // 신호 요약
  if (signals.length > 0) {
    const buyCount  = signals.filter(s => ['BUY', 'STRONG_BUY'].includes(s.action)).length;
    const sellCount = signals.filter(s => ['SELL', 'STRONG_SELL'].includes(s.action)).length;
    const holdCount = signals.filter(s => s.action === 'HOLD').length;
    lines.push('');
    lines.push(`[신호 요약] 총 ${signals.length}건 — BUY ${buyCount} / SELL ${sellCount} / HOLD ${holdCount}`);
  }

  // 보유 포지션 현황
  if (positions.length > 0) {
    lines.push('');
    lines.push(`[보유 포지션] ${positions.length}개 (익일 이월)`);
    for (const p of positions) {
      const pnl = p.unrealized_pnl != null
        ? ` (${p.unrealized_pnl >= 0 ? '+' : ''}${Number(p.unrealized_pnl).toFixed(2)}%)`
        : '';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(4)}주${pnl}`);
    }
  } else {
    lines.push('');
    lines.push(`[보유 포지션] 없음`);
  }

  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`${label} 장 마감. 수고하셨습니다! 🙏`);

  await publishToMainBot({
    from_bot:    'luna',
    event_type:  'market_close_report',
    alert_level: trades.length > 0 ? 2 : 1,
    message:     lines.join('\n'),
    payload:     { market, exchange, tradeCount: trades.length, positionCount: positions.length, date: today },
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

  if (positions.length > 0) {
    lines.push('');
    lines.push(`[보유 포지션] ${positions.length}개`);
    for (const p of positions) {
      const pnl = p.unrealized_pnl != null
        ? ` (${p.unrealized_pnl >= 0 ? '+' : ''}${Number(p.unrealized_pnl).toFixed(2)}%)`
        : '';
      lines.push(`  ${p.symbol}: ${Number(p.amount).toFixed(6)}${pnl}`);
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
    payload:     { market: 'crypto', tradeCount: trades.length, positionCount: positions.length, date: today },
  });

  console.log(`[market-alert] 암호화폐 일일 보고 발송 완료 (거래 ${trades.length}건)`);
}

// ── 실행 ──────────────────────────────────────────────────────────────

main().catch(e => {
  console.error('[market-alert] 오류:', e.message);
  process.exit(1);
});

/**
 * shared/report.js — 루나팀 알림 리포터 (Phase 3-A ESM)
 *
 * 모든 알림은 telegram-sender.js 경유로 💰 루나 Forum Topic에 직접 발송.
 * CRITICAL(오류) 알림은 🚨 긴급 + 💰 루나 이중 발송.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sender  = require('../../../packages/core/lib/telegram-sender');

// ─── 기본 발송 ───────────────────────────────────────────────────────

export function sendTelegram(message) {
  return sender.send('luna', message);
}

// ─── 신호 포매터 ─────────────────────────────────────────────────────

export function notifySignal({ symbol, action, amountUsdt, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sender.send('luna', msg);
}

export function notifyTrade({ symbol, side, amount, price, totalUsdt, paper, tpPrice, slPrice, tpslSource, capitalInfo }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = side === 'buy' ? '✅ 매수' : '✅ 매도';
  const lines = [
    `${tag}${emoji} 체결 — ${symbol}`,
    `수량: ${amount?.toFixed(6)} / 가격: $${price?.toLocaleString()}`,
    `총액: $${totalUsdt?.toFixed(2)}`,
  ];
  if (tpPrice && slPrice && price) {
    const isDynamic = tpslSource && tpslSource !== 'fixed' && tpslSource !== 'fixed_fallback';
    const dynTag    = isDynamic ? '[동적 TP/SL]' : '[고정 TP/SL]';
    const tpPct     = ((tpPrice / price - 1) * 100).toFixed(1);
    const slPct     = ((slPrice / price - 1) * 100).toFixed(1);
    lines.push(`${dynTag} TP: $${tpPrice?.toLocaleString()} (+${tpPct}%) | SL: $${slPrice?.toLocaleString()} (${slPct}%)`);
  }
  if (capitalInfo) {
    lines.push('───────────────');
    if (capitalInfo.balance    != null) lines.push(`💰 가용 잔고: $${parseFloat(capitalInfo.balance).toFixed(2)}`);
    if (capitalInfo.openPositions != null) lines.push(`📊 동시 포지션: ${capitalInfo.openPositions}/${capitalInfo.maxPositions}`);
    if (capitalInfo.dailyPnL   != null) lines.push(`🛡️ 일간 PnL: ${capitalInfo.dailyPnL >= 0 ? '+' : ''}${capitalInfo.dailyPnL.toFixed(2)} USDT`);
  }
  return sender.send('luna', lines.join('\n'));
}

export function notifyKisSignal({ symbol, action, amountKrw, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [국내주식] ${action} 신호 — ${symbol}`,
    `금액: ${amountKrw?.toLocaleString()}원`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sender.send('luna', msg);
}

export function notifyKisOverseasSignal({ symbol, action, amountUsdt, confidence, reasoning, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [미국주식] ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${reasoning.slice(0, 150)}` : '',
  ].filter(Boolean).join('\n');
  return sender.send('luna', msg);
}

export function notifyRiskRejection({ symbol, action, reason }) {
  const msg = `🚫 [리스크 거부] ${action} ${symbol}\n사유: ${reason}`;
  return sender.send('luna', msg);
}

export function notifyTradeSkip({ symbol, action, reason, balance, openPositions, maxPositions }) {
  const lines = [
    `⚠️ 매매 스킵 — ${symbol} ${action}`,
    `사유: ${reason}`,
  ];
  if (balance !== undefined) lines.push(`💰 가용 잔고: $${parseFloat(balance).toFixed(2)}`);
  if (openPositions !== undefined) lines.push(`📊 동시 포지션: ${openPositions}/${maxPositions}`);
  return sender.send('luna', lines.join('\n'));
}

export function notifyCircuitBreaker({ reason, type, dailyPnL, weeklyPnL }) {
  const lines = [
    '🚨 서킷 브레이커 발동!',
    `사유: ${reason}`,
  ];
  if (type === 'daily_loss' && dailyPnL !== undefined)  lines.push(`일간 PnL: ${dailyPnL.toFixed(2)} USDT`);
  if (type === 'weekly_loss' && weeklyPnL !== undefined) lines.push(`주간 PnL: ${weeklyPnL.toFixed(2)} USDT`);
  lines.push('매매 중지 → 마스터 확인 필요');
  lines.push('재개: /resume_trading');
  return sender.sendCritical('luna', lines.join('\n'));
}

export function notifyError(context, error) {
  const msg = `❌ [오류] ${context}\n${error?.message || error}`;
  return sender.sendCritical('luna', msg);  // 🚨 긴급 + 💰 루나 이중 발송
}

// ─── 매매일지 알림 ───────────────────────────────────────────────────

/**
 * 실시간 진입 알림 (trade_journal 기록 후 호출)
 * 실투자 🔴 / 모의투자 🔵 구분 표시
 */
export function notifyJournalEntry({
  tradeId, symbol, direction = 'long', market = 'crypto',
  entryPrice, entryValue, isPaper,
  confidence, reasoning,
  tpPrice, slPrice, tpSlSet,
  signalToExecMs,
}) {
  const tag      = isPaper ? '🔵모의투자' : '🔴실투자';
  const emoji    = direction === 'long' ? '🟢 진입' : '🔴 진입(Short)';
  const currency = market === 'domestic' ? '₩' : '$';
  const fmtPrice = (v) => v != null ? `${currency}${Number(v).toLocaleString()}` : '-';

  const lines = [
    `${emoji}: ${symbol} Long ${tag}`,
    `가격: ${fmtPrice(entryPrice)} | 금액: ${fmtPrice(entryValue)}`,
  ];
  if (reasoning)  lines.push(`근거: ${String(reasoning).slice(0, 100)}`);
  if (confidence) lines.push(`확신도: ${(confidence * 100).toFixed(0)}%`);
  if (tpPrice && slPrice && entryPrice) {
    const tpPct = ((tpPrice / entryPrice - 1) * 100).toFixed(1);
    const slPct = ((slPrice / entryPrice - 1) * 100).toFixed(1);
    lines.push(`목표: ${fmtPrice(tpPrice)} (+${tpPct}%) | 손절: ${fmtPrice(slPrice)} (${slPct}%)`);
  }
  if (tpSlSet !== undefined) lines.push(`TP/SL 거래소 설정: ${tpSlSet ? '✅ 완료' : '⚠️ 미설정'}`);
  if (signalToExecMs)        lines.push(`실행 속도: ${(signalToExecMs / 1000).toFixed(1)}초`);

  return sender.send('luna', lines.join('\n'));
}

/**
 * 일간 매매일지 리포트 텔레그램 발송
 * @param {string} date  'YYYY-MM-DD'
 * @param {Array}  records  getDailyPerformance() 결과 (호출자가 조회해서 전달)
 */
export function notifyDailyJournal(date, records = []) {
  const lines = [
    `📊 루나팀 일간 매매일지 (${date})`,
    '═'.repeat(31),
    '',
  ];

  const marketLabel = { crypto: '암호화폐', domestic: '국내장', overseas: '국외장', all: '전체' };
  const marketTag   = { crypto: '실투자 🔴', domestic: '모의투자 🔵', overseas: '모의투자 🔵' };

  const mainRecords = records.filter(r => r.market !== 'all');

  if (mainRecords.length === 0) {
    lines.push('거래 없음');
  } else {
    for (const r of mainRecords) {
      const label    = marketLabel[r.market] || r.market;
      const tag      = marketTag[r.market]   || '';
      const currency = r.market === 'domestic' ? '₩' : '$';
      const winRate  = r.win_rate != null ? `${(r.win_rate * 100).toFixed(1)}%` : '-';
      const pnlSign  = (r.pnl_net || 0) >= 0 ? '+' : '';
      lines.push(`■ ${label} (${tag})`);
      lines.push(`  거래: ${r.total_trades}건 (승 ${r.winning_trades} / 패 ${r.losing_trades})`);
      lines.push(`  승률: ${winRate}`);
      lines.push(`  순손익: ${pnlSign}${currency}${Math.abs(r.pnl_net || 0).toFixed(2)}`);
      lines.push('');
    }
  }

  // 분석팀 성적표 (all 레코드 우선, 없으면 첫 번째)
  const allRec = records.find(r => r.market === 'all') || records[0];
  if (allRec && allRec.aria_accuracy != null) {
    const acc   = (v) => v != null ? `${(v * 100).toFixed(0)}%` : '-';
    const trend = (v) => v == null ? '━' : v >= 0.7 ? '▲' : v >= 0.5 ? '━' : '▼';
    lines.push('■ 분석팀 성적표');
    lines.push(`  아리아:   ${acc(allRec.aria_accuracy)} ${trend(allRec.aria_accuracy)}`);
    lines.push(`  소피아:   ${acc(allRec.sophia_accuracy)} ${trend(allRec.sophia_accuracy)}`);
    lines.push(`  오라클:   ${acc(allRec.oracle_accuracy)} ${trend(allRec.oracle_accuracy)}`);
    lines.push(`  헤르메스: ${acc(allRec.hermes_accuracy)} ${trend(allRec.hermes_accuracy)}`);
  }

  return sender.send('luna', lines.join('\n'));
}

export function notifyCycleSummary({ cycle, symbols, results, paperMode, durationMs }) {
  const tag   = paperMode ? '[PAPER] ' : '';
  const lines = [
    `${tag}🔄 ${cycle} 사이클 완료`,
    `심볼: ${symbols.join(', ')}`,
    `소요: ${(durationMs / 1000).toFixed(1)}s`,
  ];
  if (results.length > 0) {
    lines.push('');
    lines.push('신호:');
    results.forEach(r => {
      const emoji = r.action === 'BUY' ? '🟢' : r.action === 'SELL' ? '🔴' : '⚪';
      lines.push(`  ${emoji} ${r.symbol}: ${r.action} (${((r.confidence || 0) * 100).toFixed(0)}%)`);
    });
  } else {
    lines.push('신호: HOLD (모든 심볼)');
  }
  return sender.send('luna', lines.join('\n'));
}

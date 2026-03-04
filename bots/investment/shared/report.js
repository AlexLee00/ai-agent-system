/**
 * shared/report.js — 루나팀 알림 리포터 (Phase 3-A ESM)
 *
 * 모든 알림은 제이(mainbot) 큐를 통해 발송됩니다.
 */

import { publishToMainBot } from './mainbot-client.js';

// ─── 기본 발송 ───────────────────────────────────────────────────────

export function sendTelegram(message) {
  publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 2, message });
  return Promise.resolve(true);
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
  publishToMainBot({ from_bot: 'luna', event_type: 'trade', alert_level: 2, message: msg });
  return Promise.resolve(true);
}

export function notifyTrade({ symbol, side, amount, price, totalUsdt, paper }) {
  const tag   = paper ? '[PAPER] ' : '';
  const emoji = side === 'buy' ? '✅ 매수' : '✅ 매도';
  const msg   = [
    `${tag}${emoji} 체결 — ${symbol}`,
    `수량: ${amount?.toFixed(6)} / 가격: $${price?.toLocaleString()}`,
    `총액: $${totalUsdt?.toFixed(2)}`,
  ].join('\n');
  publishToMainBot({ from_bot: 'luna', event_type: 'trade', alert_level: 2, message: msg });
  return Promise.resolve(true);
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
  publishToMainBot({ from_bot: 'luna', event_type: 'trade', alert_level: 2, message: msg });
  return Promise.resolve(true);
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
  publishToMainBot({ from_bot: 'luna', event_type: 'trade', alert_level: 2, message: msg });
  return Promise.resolve(true);
}

export function notifyRiskRejection({ symbol, action, reason }) {
  const msg = `🚫 [리스크 거부] ${action} ${symbol}\n사유: ${reason}`;
  publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 2, message: msg });
  return Promise.resolve(true);
}

export function notifyError(context, error) {
  const msg = `❌ [오류] ${context}\n${error?.message || error}`;
  publishToMainBot({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: msg });
  return Promise.resolve(true);
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
  publishToMainBot({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: lines.join('\n') });
  return Promise.resolve(true);
}

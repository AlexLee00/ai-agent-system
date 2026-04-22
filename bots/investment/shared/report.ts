// @ts-nocheck
/**
 * shared/report.js — 루나팀 알림 리포터 (Phase 3-A ESM)
 *
 * 모든 알림은 OpenClaw webhook 경유를 우선 사용한다.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import { formatExecutionTag, getMarketExecutionModeInfo } from './secrets.ts';
const { createEventReporter } = require('../../../packages/core/lib/telegram/reporter');

const DIVIDER = '──────────';
const SMALL_DIVIDER = '──────────';
const LOCAL_LLM_HEALTH_HISTORY_FILE = '/tmp/investment-local-llm-health-history.jsonl';

function compactReasoning(reasoning, maxLength = 90) {
  const text = String(reasoning || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function loadRecentLocalLlmStatus() {
  try {
    if (!fs.existsSync(LOCAL_LLM_HEALTH_HISTORY_FILE)) return null;
    const rows = String(fs.readFileSync(LOCAL_LLM_HEALTH_HISTORY_FILE, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!rows.length) return null;

    const latest = rows[rows.length - 1] || null;
    let transitionCount = 0;
    for (let i = 1; i < rows.length; i += 1) {
      if (Boolean(rows[i - 1]?.probeOk) !== Boolean(rows[i]?.probeOk)) transitionCount += 1;
    }

    const okCount = rows.filter((row) => row?.probeOk).length;
    const failCount = rows.filter((row) => row && !row.probeOk).length;
    let status = 'stable';
    if (rows.length < 2) status = 'warming_up';
    else if (failCount > 0 && transitionCount >= 2) status = 'flapping';
    else if (latest && !latest.probeOk) status = 'degraded';

    return {
      status,
      latest,
      transitionCount,
      okCount,
      failCount,
    };
  } catch {
    return null;
  }
}

function formatLocalStandbyLine() {
  return 'Local chat: Groq 우선 / local chat 비활성화';
}

const publishLunaMessage = createEventReporter({
  fromBot: 'luna',
  team: 'investment',
  topicTeam: 'luna',
  defaultEventType: 'report',
  defaultAlertLevel: 1,
  defaultCooldownMs: 5 * 60_000,
  quietHours: {
    timezone: 'KST',
    startHour: 23,
    endHour: 8,
    maxAlertLevel: 1,
  },
  includeQueue: false,
  includeTelegram: false,
  includeN8n: true,
});

// ─── 기본 발송 ───────────────────────────────────────────────────────

export function sendTelegram(message) {
  return publishLunaMessage({ message, eventType: 'report', alertLevel: 1 });
}

// ─── 신호 포매터 ─────────────────────────────────────────────────────

export function notifySignal({ symbol, action, amountUsdt, confidence, reasoning, paper, exchange = 'binance', tradeMode = null }) {
  const tag   = formatExecutionTag({ paper, exchange, tradeMode });
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${compactReasoning(reasoning)}` : '',
  ].filter(Boolean).join('\n');
  return publishLunaMessage({ message: msg, eventType: 'signal', alertLevel: 1 });
}

/** @param {any} input */
export function notifyTrade({ symbol, side, amount, price, totalUsdt, paper, exchange = 'binance', tradeMode = null, tpPrice, slPrice, tpslSource, capitalInfo, memo }) {
  const tag   = formatExecutionTag({ paper, exchange, tradeMode });
  const emoji = side === 'buy'       ? '✅ 매수'
              : side === 'sell'      ? '✅ 매도'
              : side === 'absorb'    ? '🔄 BTC 흡수'
              : side === 'liquidate' ? '💱 미추적 청산'
              : '✅ 체결';
  const lines = [
    `${tag}${emoji} 체결 — ${symbol}`,
    `수량: ${amount?.toFixed(6)} / 가격: $${price?.toLocaleString()}`,
    `총액: $${totalUsdt?.toFixed(2)}`,
  ];
  if (tpPrice && slPrice && price) {
    const isDynamic = tpslSource && tpslSource !== 'fixed' && tpslSource !== 'fixed_fallback';
    const dynTag    = isDynamic ? '[동적]' : '[고정]';
    const tpPct     = ((tpPrice / price - 1) * 100).toFixed(1);
    const slPct     = ((slPrice / price - 1) * 100).toFixed(1);
    lines.push(`${dynTag} TP: $${tpPrice?.toLocaleString()} (+${tpPct}%) | SL: $${slPrice?.toLocaleString()} (${slPct}%)`);
  }
  if (memo) lines.push(`📝 ${memo}`);
  if (capitalInfo) {
    lines.push(DIVIDER);
    if (capitalInfo.balance    != null) lines.push(`💰 가용 잔고: $${parseFloat(capitalInfo.balance).toFixed(2)}`);
    if (capitalInfo.openPositions != null) lines.push(`📊 동시 포지션: ${capitalInfo.openPositions}/${capitalInfo.maxPositions}`);
    if (capitalInfo.dailyPnL   != null) lines.push(`🛡️ 일간 PnL: ${capitalInfo.dailyPnL >= 0 ? '+' : ''}${capitalInfo.dailyPnL.toFixed(2)} USDT`);
  }
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'trade', alertLevel: 1 });
}

export function notifyKisSignal({ symbol, action, amountKrw, confidence, reasoning, paper, tradeMode = null }) {
  const tag   = formatExecutionTag({ paper, exchange: 'kis', tradeMode });
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [국내주식] ${action} 신호 — ${symbol}`,
    `금액: ${amountKrw?.toLocaleString()}원`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${compactReasoning(reasoning)}` : '',
  ].filter(Boolean).join('\n');
  return publishLunaMessage({ message: msg, eventType: 'signal', alertLevel: 1 });
}

export function notifyKisOverseasSignal({ symbol, action, amountUsdt, confidence, reasoning, paper, tradeMode = null }) {
  const tag   = formatExecutionTag({ paper, exchange: 'kis_overseas', tradeMode });
  const emoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🟡';
  const msg   = [
    `${tag}${emoji} [미국주식] ${action} 신호 — ${symbol}`,
    `금액: $${amountUsdt?.toFixed(2) || 'N/A'}`,
    `확신도: ${((confidence || 0) * 100).toFixed(0)}%`,
    reasoning ? `근거: ${compactReasoning(reasoning)}` : '',
  ].filter(Boolean).join('\n');
  return publishLunaMessage({ message: msg, eventType: 'signal', alertLevel: 1 });
}

/** @param {any} input */
export function notifyRiskRejection({ symbol, action, reason }) {
  const msg = `🚫 [리스크 거부] ${action} ${symbol}\n사유: ${reason}`;
  return publishLunaMessage({ message: msg, eventType: 'alert', alertLevel: 2 });
}

/** @param {any} input */
export function notifyTradeSkip({ symbol, action, reason, balance, openPositions, maxPositions, confidence }) {
  const compactReason = compactReasoning(reason, 80);
  const isDustSkip = /최소 매도 수량 미달|dust/i.test(String(reason || ''));
  const lines = [
    `${isDustSkip ? '🧹' : '⚠️'} ${symbol} ${action} ${isDustSkip ? 'dust 스킵' : '스킵'}`,
    DIVIDER,
    `사유: ${compactReason}`,
  ];
  if (confidence != null) lines.push(`시그널 신뢰도: ${((confidence || 0) * 100).toFixed(0)}%`);
  if (balance !== undefined) lines.push(`💰 가용 잔고: $${parseFloat(balance).toFixed(2)}`);
  if (openPositions !== undefined) lines.push(`📋 동시 포지션: ${openPositions}/${maxPositions}`);
  lines.push(SMALL_DIVIDER);
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'alert', alertLevel: isDustSkip ? 1 : 2 });
}

/** @param {any} input */
export function notifyCircuitBreaker({ reason, type, dailyPnL, weeklyPnL }) {
  const lines = [
    '🚨 서킷 브레이커 발동!',
    SMALL_DIVIDER,
    `사유: ${compactReasoning(reason, 80)}`,
  ];
  if (type === 'daily_loss' && dailyPnL !== undefined) {
    const pct = dailyPnL.toFixed(2);
    lines.push(`일간 PnL: ${pct} USDT`);
  }
  if (type === 'weekly_loss' && weeklyPnL !== undefined) {
    lines.push(`주간 PnL: ${weeklyPnL.toFixed(2)} USDT`);
  }
  lines.push('매매 자동 중지');
  lines.push(SMALL_DIVIDER);
  lines.push('재개: /resume_trading (마스터만)');
  lines.push(DIVIDER);
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'alert', alertLevel: 4 });
}

/** @param {string} context @param {any} error */
export function notifyError(context, error) {
  const trace = Array.isArray(error?.llmTrace) ? error.llmTrace : [];
  const localStatus = loadRecentLocalLlmStatus();
  const traceLine = trace.length > 0
    ? `\nLLM trace: ${trace
      .slice(0, 5)
      .map((entry) => `${entry.provider}/${entry.model}:${entry.status}${entry.reason ? `(${String(entry.reason).slice(0, 32)})` : ''}`)
      .join(' -> ')}`
    : '';
  const localLine = /로컬 LLM 응답 없음|local llm/i.test(String(error?.message || error || '')) && localStatus
    ? `\nLocal probe: ${localStatus.status} / ok ${localStatus.okCount} / fail ${localStatus.failCount}${localStatus.latest?.probeError ? ` / ${localStatus.latest.probeError}` : ''}\n${formatLocalStandbyLine()}`
    : '';
  const msg = `❌ [오류] ${context}\n${error?.message || error}${traceLine}${localLine}`;
  return publishLunaMessage({
    message: msg,
    eventType: 'alert',
    alertLevel: 4,
    criticalTelegramMode: /** @type {any} */ ('team_only'),
  });
}

// ─── 매매일지 알림 ───────────────────────────────────────────────────

/**
 * 실시간 진입 알림 (trade_journal 기록 후 호출)
 * executionMode 기준 `[LIVE]` / `[PAPER]` 구분 표시
 */
/** @param {any} input */
export function notifyJournalEntry({
  tradeId, symbol, direction = 'long', market = 'crypto',
  exchange = null, tradeMode = null,
  entryPrice, entryValue, isPaper,
  confidence, reasoning,
  tpPrice, slPrice, tpSlSet, tpslSource,
  signalToExecMs,
  capitalInfo,  // { balance, openPositions, maxPositions, dailyPnL, totalCapital }
}) {
  const inferredExchange = exchange
    || (market === 'domestic' ? 'kis' : market === 'overseas' ? 'kis_overseas' : 'binance');
  const tag      = formatExecutionTag({ paper: isPaper, exchange: inferredExchange, tradeMode });
  const dir      = direction === 'long' ? 'LONG' : 'SHORT';
  const currency = market === 'domestic' ? '₩' : '$';
  const fmtPrice = (v) => v != null ? `${currency}${Number(v).toLocaleString()}` : '-';
  const isDynamic = tpslSource && tpslSource !== 'fixed' && tpslSource !== 'fixed_fallback';
  const dynTag    = isDynamic ? '[동적]' : '[고정]';

  const lines = [
    `${tag}🔔 ${symbol} ${dir} 실행`,
    SMALL_DIVIDER,
    `📍 진입: ${fmtPrice(entryPrice)}`,
  ];

  if (tpPrice && entryPrice) {
    const tpPct = ((tpPrice / entryPrice - 1) * 100).toFixed(1);
    lines.push(`🎯 TP: ${fmtPrice(tpPrice)} (+${tpPct}%) ${dynTag}`);
  }
  if (slPrice && entryPrice) {
    const slPct = ((slPrice / entryPrice - 1) * 100).toFixed(1);
    lines.push(`🛑 SL: ${fmtPrice(slPrice)} (${slPct}%) ${dynTag}`);
  }
  if (entryValue != null) {
    const capPct = capitalInfo?.totalCapital
      ? ` (자본의 ${(entryValue / capitalInfo.totalCapital * 100).toFixed(1)}%)` : '';
    lines.push(`📊 포지션: ${fmtPrice(entryValue)}${capPct}`);
  }
  if (tpSlSet !== undefined) lines.push(`🔒 TP/SL 설정: ${tpSlSet ? '✅ 완료' : '⚠️ 미설정'}`);

  if (capitalInfo || confidence != null) {
    lines.push(SMALL_DIVIDER);
    if (capitalInfo?.balance    != null) lines.push(`💰 가용 잔고: ${fmtPrice(capitalInfo.balance)}`);
    if (capitalInfo?.openPositions != null) lines.push(`📋 동시 포지션: ${capitalInfo.openPositions}/${capitalInfo.maxPositions ?? '-'}`);
    if (capitalInfo?.dailyPnL   != null) {
      const sign = capitalInfo.dailyPnL >= 0 ? '+' : '';
      lines.push(`📈 일간 PnL: ${sign}${capitalInfo.dailyPnL.toFixed(2)} USDT`);
    }
    if (confidence != null) lines.push(`🔋 시그널 신뢰도: ${(confidence * 100).toFixed(0)}%`);
  }
  lines.push(SMALL_DIVIDER);

  if (reasoning)     lines.push(`근거: ${compactReasoning(reasoning)}`);
  if (signalToExecMs) lines.push(`실행 속도: ${(signalToExecMs / 1000).toFixed(1)}초`);

  return publishLunaMessage({ message: lines.join('\n'), eventType: 'trade', alertLevel: 1 });
}

/**
 * 일간 매매일지 리포트 텔레그램 발송
 * @param {string} date  'YYYY-MM-DD'
 * @param {Array}  records  getDailyPerformance() 결과 (호출자가 조회해서 전달)
 */
export function notifyDailyJournal(date, records = []) {
  const lines = [
    `📊 루나팀 일간 매매일지 (${date})`,
    DIVIDER,
    '',
  ];

  const marketLabel = { crypto: '암호화폐', domestic: '국내장', overseas: '국외장', all: '전체' };
  const marketTag = {
    crypto: `${getMarketExecutionModeInfo('crypto', '암호화폐').executionMode.toUpperCase()} / ${getMarketExecutionModeInfo('crypto', '암호화폐').brokerAccountMode.toUpperCase()} 🔴`,
    domestic: `${getMarketExecutionModeInfo('stocks', '국내주식').executionMode.toUpperCase()} / ${getMarketExecutionModeInfo('stocks', '국내주식').brokerAccountMode.toUpperCase()} 🔵`,
    overseas: `${getMarketExecutionModeInfo('stocks', '미국주식').executionMode.toUpperCase()} / ${getMarketExecutionModeInfo('stocks', '미국주식').brokerAccountMode.toUpperCase()} 🔵`,
  };

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

  return publishLunaMessage({ message: lines.join('\n'), eventType: 'report', alertLevel: 1 });
}

/**
 * 매매 청산 알림 — 포지션 종료 시 PnL 결산
 */
export function notifySettlement({
  symbol, side, entryPrice, exitPrice, pnl, holdDuration, weeklyPnl, winRate, totalTrades, wins, paper,
  market = 'crypto', pnlPercent = null, maxFavorable = null, maxAdverse = null,
  signalAccuracy = null, executionSpeed = null,
}) {
  const tag     = formatExecutionTag(paper);
  const dir     = side === 'buy' ? 'LONG' : 'SHORT';
  const pnlSign = (pnl || 0) >= 0 ? '+' : '';
  const currency = market === 'domestic' ? '₩' : '$';
  const pricePct = (entryPrice && exitPrice)
    ? ` (${((exitPrice / entryPrice - 1) * 100).toFixed(1)}%)` : '';

  const lines = [
    `${tag}💰 ${symbol} ${dir} 체결`,
    SMALL_DIVIDER,
    `진입: ${currency}${Number(entryPrice).toLocaleString()}`,
    `청산: ${currency}${Number(exitPrice).toLocaleString()}${pricePct}`,
    `수익: ${pnlSign}${currency}${Math.abs(pnl || 0).toFixed(2)}`,
  ];
  if (holdDuration) lines.push(`보유 시간: ${holdDuration}`);
  if (pnlPercent != null) lines.push(`실현 수익률: ${pnlPercent >= 0 ? '+' : ''}${Number(pnlPercent).toFixed(2)}%`);
  if (maxFavorable != null || maxAdverse != null) {
    const mf = maxFavorable != null ? `MFE +${Number(maxFavorable).toFixed(2)}%` : 'MFE -';
    const ma = maxAdverse != null ? `MAE ${Number(maxAdverse).toFixed(2)}%` : 'MAE -';
    lines.push(`${mf} | ${ma}`);
  }
  if (signalAccuracy || executionSpeed) {
    lines.push(`리뷰: ${signalAccuracy || '-'} / 실행속도 ${executionSpeed || '-'}`);
  }
  lines.push(SMALL_DIVIDER);
  if (weeklyPnl != null) {
    const wSign = weeklyPnl >= 0 ? '+' : '';
    lines.push(`누적 PnL: ${wSign}${currency}${Math.abs(weeklyPnl).toFixed(2)} (이번 주)`);
  }
  if (winRate != null && totalTrades != null) {
    lines.push(`승률: ${((winRate) * 100).toFixed(0)}% (${wins}/${totalTrades})`);
  }
  lines.push(DIVIDER);
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'report', alertLevel: 1 });
}

/**
 * 자본 현황 알림 (/capital_status 명령 응답)
 */
export function notifyCapitalStatus({ totalCapital, balance, positionValue, reserve, openPositions, maxPositions, dailyTrades, maxDailyTrades, dailyPnl, circuitOn }) {
  const total  = totalCapital || 0;
  const balPct = total > 0 ? (balance / total * 100).toFixed(0) : 0;
  const posPct = total > 0 ? ((positionValue || 0) / total * 100).toFixed(0) : 0;
  const resPct = total > 0 ? ((reserve || 0) / total * 100).toFixed(0) : 0;
  const pnlSign = (dailyPnl || 0) >= 0 ? '+' : '';

  const lines = [
    '💰 자본 현황',
    DIVIDER,
    `총 자본:   ${total.toFixed(2)} USDT`,
    `가용 잔고: ${(balance || 0).toFixed(2)} USDT (${balPct}%)`,
    `포지션 중: ${(positionValue || 0).toFixed(2)} USDT (${posPct}%)`,
    `예비금:    ${(reserve || 0).toFixed(2)} USDT (${resPct}%)`,
    SMALL_DIVIDER,
    `📋 포지션: ${openPositions ?? '-'}/${maxPositions ?? '-'}`,
    `📊 일간 매매: ${dailyTrades ?? '-'}/${maxDailyTrades ?? '-'}`,
    `📈 일간 PnL: ${pnlSign}${(dailyPnl || 0).toFixed(2)} USDT`,
    `🛡️ 서킷 브레이커: ${circuitOn ? 'ON 🔴' : 'OFF ✅'}`,
    DIVIDER,
  ];
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'report', alertLevel: 1 });
}

/**
 * 주간 자기반성 리포트 — 루나팀 주간 리뷰
 */
export function notifyWeeklyReflection({ weekStart, weekEnd, trades, wins, losses, totalPnl, avgRR, llmCost, lossAnalysis }) {
  const winRate = trades > 0 ? Math.round(wins / trades * 100) : 0;
  const pnlSign = (totalPnl || 0) >= 0 ? '+' : '';

  const lines = [
    '📋 루나팀 주간 자기반성 리포트',
    DIVIDER,
    `📅 ${weekStart} ~ ${weekEnd}`,
    '',
    '■ 성과 요약',
    `  매매: ${trades}건 (승 ${wins} / 패 ${losses})`,
    `  승률: ${winRate}%`,
    `  총 PnL: ${pnlSign}${(totalPnl || 0).toFixed(2)} USDT`,
  ];
  if (avgRR != null) lines.push(`  평균 R/R: ${avgRR.toFixed(1)}:1`);
  if (llmCost != null) lines.push(`  LLM 비용: $${llmCost.toFixed(2)}`);

  if (lossAnalysis) {
    lines.push('');
    lines.push('■ 손실 분석');
    if (lossAnalysis.cause)   lines.push(`  🔍 원인: ${lossAnalysis.cause}`);
    if (lossAnalysis.pattern) lines.push(`  🔄 패턴: ${lossAnalysis.pattern}`);
    if (lossAnalysis.suggest) lines.push(`  💡 제안: ${lossAnalysis.suggest}`);
    if (lossAnalysis.caution) lines.push(`  ⚠️ 주의: ${lossAnalysis.caution}`);
  }
  lines.push(DIVIDER);
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'report', alertLevel: 1 });
}

export function notifyCycleSummary({ cycle, symbols, results, paperMode, durationMs, exchange = 'binance', tradeMode = null }) {
  const tag   = formatExecutionTag({ paper: paperMode, exchange, tradeMode });
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
  return publishLunaMessage({ message: lines.join('\n'), eventType: 'report', alertLevel: 1 });
}

// @ts-nocheck
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
 * runtime:
 *   Luna ops-scheduler / Elixir supervisor 통합 경로에서 호출
 */

import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { loadPreScreened } from './pre-market-screen.ts';
import { getInvestmentProfile } from './investment-profile.ts';
import { buildRuntimeLearningLoopReport } from './runtime-learning-loop-report.ts';
import { getKisMarketStatus, getKisOverseasMarketStatus, initHubSecrets } from '../shared/secrets.ts';
import { getDomesticBalance, getOverseasBalance } from '../shared/kis-client.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import { getInvestmentAlertRuntimeConfig } from '../shared/runtime-config.ts';
import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
const ALERT_RUNTIME = getInvestmentAlertRuntimeConfig();
const MARKET_ALERT_MEMORY = {
  episodicThreshold: Number(ALERT_RUNTIME.marketAlertMemory?.episodicThreshold ?? 0.33),
  semanticThreshold: Number(ALERT_RUNTIME.marketAlertMemory?.semanticThreshold ?? 0.28),
};
let marketAlertMemory = null;
try {
  const { createAgentMemory } = createRequire(import.meta.url)('../../../packages/core/lib/agent-memory.ts');
  marketAlertMemory = createAgentMemory({ agentId: 'investment.market-alert', team: 'investment' });
} catch (error) {
  console.warn(`  ⚠️ [market-alert] agent-memory 로드 실패(무시): ${error?.message || error}`);
}
const safeMarketAlertMemory = marketAlertMemory || {
  recallCountHint: async () => '',
  recallHint: async () => '',
  remember: async () => {},
  consolidate: async () => {},
};

// ── 인수 파싱 ──────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const market = args.find(a => a.startsWith('--market='))?.split('=')[1];
const event  = args.find(a => a.startsWith('--event='))?.split('=')[1];
const force  = args.includes('--force');

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

const ALERT_WINDOWS = {
  domestic: {
    open: { hour: 9, minute: 0 },
    close: { hour: 15, minute: 30 },
  },
  overseas: {
    open: { hour: 23, minute: 30 },
    close: { hour: 6, minute: 0 },
  },
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

async function loadAlertPositions(market, exchange, profile) {
  if (market === 'domestic' || market === 'overseas') {
    try {
      await initHubSecrets();
      const useMock = profile?.brokerAccountMode === 'mock';
      if (market === 'domestic') {
        const balance = await getDomesticBalance(useMock);
        return (balance?.holdings || []).map((holding) => ({
          symbol: holding.symbol,
          amount: Number(holding.qty || 0),
          pnl_pct: Number.isFinite(Number(holding.pnl_pct)) ? Number(holding.pnl_pct) : null,
          trade_modes: [],
        }));
      }

      const balance = await getOverseasBalance(useMock);
      return (balance?.holdings || []).map((holding) => ({
        symbol: holding.symbol,
        amount: Number(holding.qty || 0),
        pnl_pct: Number.isFinite(Number(holding.pnl_pct)) ? Number(holding.pnl_pct) : null,
        trade_modes: [],
      }));
    } catch (error) {
      console.warn(`[market-alert] ${market} 브로커 잔고 조회 실패 → DB fallback: ${error?.message || error}`);
    }
  }

  const allPositions = await db.getAllPositions();
  const positions    = allPositions.filter((p) => p.exchange === exchange && p.amount > 0);
  return aggregatePositionsBySymbol(positions);
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

function buildMarketAlertMemoryQuery(kind, market, extras = []) {
  return [
    'investment market alert',
    kind,
    market,
    ...extras,
  ].filter(Boolean).join(' ');
}

async function loadLearningLoopSummary() {
  return buildRuntimeLearningLoopReport({ days: 14, json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
}

function buildLearningLoopAlertLine(learningLoopSummary) {
  if (!learningLoopSummary || learningLoopSummary.error || learningLoopSummary.decision?.status !== 'regime_strategy_tuning_needed') {
    return null;
  }
  const weakest = learningLoopSummary.sections?.regimeLaneSummary?.weakestRegime;
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode || 'n/a';
  const topSuggestion = learningLoopSummary.sections?.strategy?.runtimeSuggestionTop;
  const suggestionValue = topSuggestion?.suggestedValue ?? topSuggestion?.suggested;
  const parts = [
    `weakest ${weakest?.regime || 'n/a'} / ${weakestMode}`,
    topSuggestion?.key && suggestionValue != null ? `${topSuggestion.key} -> ${suggestionValue}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `🧭 learning loop: ${parts.join(' | ')}` : null;
}

function getLearningLoopNextCommand(learningLoopSummary) {
  const nextActions = learningLoopSummary?.decision?.nextActions;
  if (!Array.isArray(nextActions)) return null;
  return nextActions.find((item) => typeof item === 'string' && item.startsWith('npm --prefix')) || null;
}

// KST 기준 오늘 날짜
const todayKST = () => kst.today();

function getKstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function shouldAllowScheduledAlert(market, event, date = new Date()) {
  if (force || market === 'crypto' || !['open', 'close'].includes(event)) {
    return { allowed: true, deltaMinutes: 0, expectedLabel: null };
  }

  const target = ALERT_WINDOWS[market]?.[event];
  if (!target) {
    return { allowed: true, deltaMinutes: 0, expectedLabel: null };
  }

  const parts = getKstParts(date);
  const currentMinutes = (parts.hour * 60) + parts.minute;
  const targetMinutes = (target.hour * 60) + target.minute;
  const deltaMinutes = Math.abs(currentMinutes - targetMinutes);
  const expectedLabel = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')} KST`;

  return {
    allowed: deltaMinutes <= 5,
    deltaMinutes,
    expectedLabel,
  };
}

// ── 메인 ──────────────────────────────────────────────────────────────

async function main() {
  const label = MARKET_LABEL[market];
  if (!label) {
    console.error('--market=domestic|overseas|crypto 필수');
    process.exit(1);
  }

  const timingGuard = shouldAllowScheduledAlert(market, event, new Date());
  if (!timingGuard.allowed) {
    console.warn(
      `[market-alert] ${label} ${event} 알림 스킵 — 현재 시각이 기대 시각(${timingGuard.expectedLabel})과 ${timingGuard.deltaMinutes}분 차이`,
    );
    process.exit(0);
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
  const learningLoopSummary = await loadLearningLoopSummary();
  const exchange   = EXCHANGE_MAP[market];
  const prescreened = loadPreScreened(market);
  const symbols    = prescreened?.symbols || [];
  const syncResult = (market === 'domestic' || market === 'overseas')
    ? await syncPositionsAtMarketOpen(market).catch((error) => ({
      ok: false,
      mismatchCount: 0,
      mismatches: [],
      positions: [],
      reason: error?.message || String(error),
    }))
    : null;

  // 현재 보유 포지션
  // 주식은 브로커 실잔고를 우선 사용해 stale DB 포지션 노출을 막는다.
  const aggregatedPositions = Array.isArray(syncResult?.positions)
    ? syncResult.positions
    : await loadAlertPositions(market, exchange, profile);

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

  if (syncResult && market !== 'crypto') {
    lines.push('');
    if (syncResult.ok) {
      lines.push(`[포지션 동기화] ${syncResult.executionMode.toUpperCase()} / ${syncResult.brokerAccountMode.toUpperCase()} 기준 동기화 완료`);
      lines.push(`  브로커 ${syncResult.brokerPositionCount}개 / DB 기존 ${syncResult.dbPositionCountBefore}개 / 불일치 ${syncResult.mismatchCount}건`);
      for (const item of (syncResult.mismatches || []).slice(0, 4)) {
        if (item.type === 'stale_db_position') {
          lines.push(`  - ${item.symbol}: DB stale ${item.dbQty} → 브로커 0 (정리)`);
        } else if (item.type === 'missing_db_position') {
          lines.push(`  - ${item.symbol}: 브로커 ${item.brokerQty} / DB 누락 (추가)`);
        } else if (item.type === 'quantity_mismatch') {
          lines.push(`  - ${item.symbol}: 수량 불일치 DB ${item.dbQty} / 브로커 ${item.brokerQty}`);
        } else if (item.type === 'trade_mode_split') {
          lines.push(`  - ${item.symbol}: trade_mode 분할 ${item.rowCount}건 [${(item.tradeModes || []).join('+')}]`);
        }
      }
    } else {
      lines.push(`[포지션 동기화] 실패 — ${syncResult.reason || '브로커 동기화 오류'}`);
    }
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

  const memoryQuery = buildMarketAlertMemoryQuery('open', market, [profile.mode, `${aggregatedPositions.length}-positions`]);
  const episodicHint = await safeMarketAlertMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.episodicThreshold,
    title: '최근 유사 알림',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      open: '시작',
      close: '마감',
      daily: '일일',
    },
    order: ['open', 'close', 'daily'],
  }).catch(() => '');
  const semanticHint = await safeMarketAlertMemory.recallHint(`${memoryQuery} consolidated market pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.semanticThreshold,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const learningLoopLine = buildLearningLoopAlertLine(learningLoopSummary);
  if (learningLoopLine) lines.push(learningLoopLine);
  const learningLoopNextCommand = getLearningLoopNextCommand(learningLoopSummary);
  if (learningLoopNextCommand) lines.push(`🛠️ next command: ${learningLoopNextCommand}`);
  const message = `${lines.join('\n')}${episodicHint}${semanticHint}`;

  await publishAlert({
    from_bot:    'luna',
    event_type:  'market_open',
    alert_level: 1,
    message,
    payload:     { market, exchange, symbols, positionCount: aggregatedPositions.length, learningLoopSummary },
  });
  await safeMarketAlertMemory.remember(message, 'episodic', {
    importance: 0.64,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'open',
      market,
      positionCount: aggregatedPositions.length,
      screeningCount: symbols.length,
    },
  }).catch(() => {});
  await safeMarketAlertMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  console.log(`[market-alert] ${label} 장 시작 알림 발송 완료`);
}

// ── 장 종료 + 매매일지 보고 ────────────────────────────────────────────

async function sendCloseReport(market, label) {
  const profile  = await getInvestmentProfile(market);
  const learningLoopSummary = await loadLearningLoopSummary();
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

  const memoryQuery = buildMarketAlertMemoryQuery('close', market, [profile.mode, trades.length > 0 ? 'trade-day' : 'quiet-day']);
  const episodicHint = await safeMarketAlertMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.episodicThreshold,
    title: '최근 유사 알림',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      close: '마감',
      open: '시작',
      daily: '일일',
    },
    order: ['close', 'open', 'daily'],
  }).catch(() => '');
  const semanticHint = await safeMarketAlertMemory.recallHint(`${memoryQuery} consolidated market pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.semanticThreshold,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const learningLoopLine = buildLearningLoopAlertLine(learningLoopSummary);
  if (learningLoopLine) lines.push(learningLoopLine);
  const learningLoopNextCommand = getLearningLoopNextCommand(learningLoopSummary);
  if (learningLoopNextCommand) lines.push(`🛠️ next command: ${learningLoopNextCommand}`);
  const message = `${lines.join('\n')}${episodicHint}${semanticHint}`;

  await publishAlert({
    from_bot:    'luna',
    event_type:  'market_close_report',
    alert_level: trades.length > 0 ? 2 : 1,
    message,
    payload:     { market, exchange, tradeCount: trades.length, positionCount: aggregatedPositions.length, date: today, learningLoopSummary },
  });
  await safeMarketAlertMemory.remember(message, 'episodic', {
    importance: trades.length > 0 ? 0.72 : 0.62,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'close',
      market,
      tradeCount: trades.length,
      positionCount: aggregatedPositions.length,
      date: today,
    },
  }).catch(() => {});
  await safeMarketAlertMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  console.log(`[market-alert] ${label} 장 마감 매매일지 발송 완료 (거래 ${trades.length}건)`);
}

// ── 암호화폐 일일 보고 ─────────────────────────────────────────────────

async function sendCryptoDailyReport(label) {
  const profile = await getInvestmentProfile('crypto');
  const learningLoopSummary = await loadLearningLoopSummary();
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

  const memoryQuery = buildMarketAlertMemoryQuery('daily', 'crypto', [profile.mode, trades.length > 0 ? 'trade-day' : 'quiet-day']);
  const episodicHint = await safeMarketAlertMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.episodicThreshold,
    title: '최근 유사 알림',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      daily: '일일',
      close: '마감',
      open: '시작',
    },
    order: ['daily', 'close', 'open'],
  }).catch(() => '');
  const semanticHint = await safeMarketAlertMemory.recallHint(`${memoryQuery} consolidated market pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: MARKET_ALERT_MEMORY.semanticThreshold,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const learningLoopLine = buildLearningLoopAlertLine(learningLoopSummary);
  if (learningLoopLine) lines.push(learningLoopLine);
  const learningLoopNextCommand = getLearningLoopNextCommand(learningLoopSummary);
  if (learningLoopNextCommand) lines.push(`🛠️ next command: ${learningLoopNextCommand}`);
  const message = `${lines.join('\n')}${episodicHint}${semanticHint}`;

  await publishAlert({
    from_bot:    'luna',
    event_type:  'crypto_daily_report',
    alert_level: 1,
    message,
    payload:     { market: 'crypto', tradeCount: trades.length, positionCount: aggregatedPositions.length, date: today, learningLoopSummary },
  });
  await safeMarketAlertMemory.remember(message, 'episodic', {
    importance: 0.66,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'daily',
      market: 'crypto',
      tradeCount: trades.length,
      positionCount: aggregatedPositions.length,
      date: today,
    },
  }).catch(() => {});
  await safeMarketAlertMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  console.log(`[market-alert] 암호화폐 일일 보고 발송 완료 (거래 ${trades.length}건)`);
}

// ── 실행 ──────────────────────────────────────────────────────────────

main().catch(e => {
  console.error('[market-alert] 오류:', e.message);
  process.exit(1);
});

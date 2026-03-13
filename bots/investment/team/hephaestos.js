/**
 * team/hephaestos.js — 헤파이스토스 (바이낸스 실행봇)
 *
 * 역할: 루나가 승인한 신호를 바이낸스 Spot API로 실행
 * LLM: 없음 (규칙 기반)
 * PAPER_MODE: true → DB 저장 + 텔레그램만 (실주문 없음)
 *
 * bots/invest/src/binance-executor.js 패턴 재사용
 * (Phase 3-A: PAPER_MODE 기본값 — 실주문은 Phase 3-C에서 활성화)
 *
 * 실행: node team/hephaestos.js [--symbol=BTC/USDT] [--action=BUY] [--amount=100]
 */

import ccxt from 'ccxt';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';
import { loadSecrets, isPaperMode } from '../shared/secrets.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyTrade, notifyError, notifyJournalEntry, notifyTradeSkip, notifyCircuitBreaker } from '../shared/report.js';
import { preTradeCheck, calculatePositionSize, getAvailableBalance, getAvailableUSDT, getOpenPositions, getDailyPnL, getDailyTradeCount, checkCircuitBreaker, config as cmConfig } from '../shared/capital-manager.js';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

const BINANCE_SYMBOL_RE = /^[A-Z0-9]+\/USDT$/;

function isBinanceSymbol(symbol) {
  return BINANCE_SYMBOL_RE.test(symbol);
}

// ─── CCXT 바이낸스 클라이언트 (lazy init) ──────────────────────────

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;
  const secrets = loadSecrets();
  _exchange = new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    options: { defaultType: 'spot' },
  });
  return _exchange;
}

/**
 * 바이낸스 USDT 가용 잔고 조회 (LU-004: 잔고 부족 알림용)
 */
export async function fetchUsdtBalance() {
  const ex  = getExchange();
  const bal = await ex.fetchBalance();
  return bal.free?.USDT || 0;
}

/**
 * 현재가 조회 (PAPER_MODE에서도 사용)
 */
export async function fetchTicker(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last;
}

/**
 * 시장가 매수 (PAPER_MODE: 모의 주문)
 */
async function marketBuy(symbol, amountUsdt, paperMode) {
  if (paperMode) {
    const price  = await fetchTicker(symbol).catch(() => 0);
    const filled = price > 0 ? amountUsdt / price : 0;
    console.log(`  📄 [헤파이스토스] PAPER BUY ${symbol} $${amountUsdt} @ ~$${price?.toLocaleString()}`);
    return { filled, price, dryRun: true };
  }
  const ex = getExchange();
  return await ex.createOrder(symbol, 'market', 'buy', undefined, undefined, { quoteOrderQty: amountUsdt });
}

/**
 * 시장가 매도 (PAPER_MODE: 모의 주문)
 */
async function marketSell(symbol, amount, paperMode) {
  if (paperMode) {
    const price     = await fetchTicker(symbol).catch(() => 0);
    const totalUsdt = amount * price;
    console.log(`  📄 [헤파이스토스] PAPER SELL ${symbol} ${amount} @ ~$${price?.toLocaleString()}`);
    return { amount, price, totalUsdt, dryRun: true };
  }
  const ex = getExchange();
  return await ex.createOrder(symbol, 'market', 'sell', amount);
}

function isCapitalShortageReason(reason = '') {
  return reason.includes('잔고 부족') || reason.includes('현금 보유 부족');
}

async function closeOpenJournalForSymbol(symbol, isPaper, exitPrice, exitValue, exitReason) {
  const openEntries = await journalDb.getOpenJournalEntries('crypto');
  const entry = openEntries.find(e => e.symbol === symbol && Boolean(e.is_paper) === Boolean(isPaper));
  if (!entry) return;

  const pnlAmount  = (exitValue || 0) - (entry.entry_value || 0);
  const pnlPercent = entry.entry_value > 0 ? pnlAmount / entry.entry_value : null;
  await journalDb.closeJournalEntry(entry.trade_id, {
    exitPrice,
    exitValue,
    exitReason,
    pnlAmount,
    pnlPercent,
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
}

async function maybePromotePaperPositions() {
  const paperPositions = await db.getPaperPositions('binance').catch(() => []);
  if (paperPositions.length === 0) return [];

  const promoted = [];
  for (const paperPos of paperPositions) {
    const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
    if (desiredUsdt < (cmConfig.min_order_usdt || 11)) continue;

    const freeUsdt = await getAvailableUSDT().catch(() => 0);
    if (freeUsdt < desiredUsdt) break;

    const check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance');
    if (!check.allowed) {
      if (isCapitalShortageReason(check.reason || '')) break;
      continue;
    }

    const order = await marketBuy(paperPos.symbol, desiredUsdt, false);
    const trade = {
      signalId:   null,
      symbol:     paperPos.symbol,
      side:       'buy',
      amount:     order.filled,
      price:      order.price,
      totalUsdt:  desiredUsdt,
      paper:      false,
      exchange:   'binance',
    };

    await closeOpenJournalForSymbol(
      paperPos.symbol,
      true,
      order.price,
      (paperPos.amount || 0) * (order.price || 0),
      'promoted_to_live',
    ).catch(() => {});

    await db.upsertPosition({
      symbol:        paperPos.symbol,
      amount:        order.filled || 0,
      avgPrice:      order.price || 0,
      unrealizedPnl: 0,
      exchange:      'binance',
      paper:         false,
    });
    await db.insertTrade(trade);

    try {
      const execTime = Date.now();
      const tradeId  = await journalDb.generateTradeId();
      await journalDb.insertJournalEntry({
        trade_id:      tradeId,
        signal_id:     null,
        market:        'crypto',
        exchange:      'binance',
        symbol:        trade.symbol,
        is_paper:      false,
        entry_time:    execTime,
        entry_price:   trade.price || 0,
        entry_size:    trade.amount || 0,
        entry_value:   trade.totalUsdt || 0,
        direction:     'long',
      });
      notifyJournalEntry({
        tradeId,
        symbol:     trade.symbol,
        direction:  'long',
        market:     'crypto',
        entryPrice: trade.price,
        entryValue: trade.totalUsdt,
        isPaper:    false,
      });
    } catch (journalErr) {
      console.warn(`  ⚠️ paper→live 승격 일지 기록 실패: ${journalErr.message}`);
    }

    await notifyTrade({
      ...trade,
      memo: `기존 PAPER 포지션 실투자 승격 (${paperPos.amount?.toFixed(6)} → ${trade.amount?.toFixed(6)})`,
    }).catch(() => {});

    promoted.push({ symbol: paperPos.symbol, totalUsdt: desiredUsdt, amount: trade.amount });
  }

  return promoted;
}

export async function inspectPromotionCandidates() {
  const freeUsdt = await getAvailableUSDT().catch(() => 0);
  const paperPositions = await db.getPaperPositions('binance').catch(() => []);
  const results = [];

  for (const paperPos of paperPositions) {
    const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
    const minOrder = cmConfig.min_order_usdt || 11;
    const tooSmall = desiredUsdt < minOrder;
    const enoughUsdt = freeUsdt >= desiredUsdt;
    let check = { allowed: false, reason: tooSmall ? `최소 주문 미만: ${desiredUsdt.toFixed(2)} USDT` : 'USDT 부족' };

    if (!tooSmall && enoughUsdt) {
      check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance');
    }

    results.push({
      symbol: paperPos.symbol,
      paperAmount: paperPos.amount || 0,
      avgPrice: paperPos.avg_price || 0,
      desiredUsdt,
      freeUsdt,
      promotable: !tooSmall && enoughUsdt && check.allowed,
      reason: !tooSmall && enoughUsdt ? (check.allowed ? '승격 가능' : check.reason) : check.reason,
    });
  }

  return {
    freeUsdt,
    paperCount: paperPositions.length,
    candidates: results,
  };
}

export async function simulateBuyDecision({ symbol, amountUsdt = 100 }) {
  const currentPrice = await fetchTicker(symbol).catch(() => 0);
  const slPrice = 0;
  const check = await preTradeCheck(symbol, 'BUY', amountUsdt, 'binance');
  const sizing = await calculatePositionSize(symbol, currentPrice, slPrice);
  const paperFallback = !isPaperMode() && !check.circuit && !check.allowed && isCapitalShortageReason(check.reason || '');

  return {
    symbol,
    requestedAmountUsdt: amountUsdt,
    currentPrice,
    liveAllowed: check.allowed,
    liveReason: check.allowed ? 'LIVE 가능' : check.reason,
    paperFallback,
    finalMode: check.allowed ? 'live' : paperFallback ? 'paper' : 'blocked',
    suggestedLiveAmountUsdt: sizing.skip ? 0 : sizing.size,
    sizing,
  };
}

// ─── BTC 직접 페어 매수 ──────────────────────────────────────────────

/**
 * 미추적 BTC → 직접 BTC 페어(ETH/BTC 등)로 매수
 * BTC→USDT 변환 없이 1회 수수료로 처리 (가격 갭 최소화)
 * @returns {object|null} 성공 시 결과 객체, BTC 페어 없거나 미추적 BTC 없으면 null
 */
async function _tryBuyWithBtcPair(symbol, base, signalId, signal, paperMode) {
  if (base === 'BTC') return null;  // BTC 자체는 흡수 블록에서 처리

  // 미추적 BTC 확인
  const walletBal    = await getExchange().fetchBalance();
  const walletBtc    = walletBal.free?.BTC || 0;
  const trackedBtcPos = await db.getLivePosition('BTC/USDT').catch(() => null);
  const trackedBtc   = trackedBtcPos?.amount || 0;
  const untrackedBtc = walletBtc - trackedBtc;

  if (untrackedBtc <= 0) return null;

  // 미추적 BTC USD 환산 → 최소금액 체크
  const btcPrice     = await fetchTicker('BTC/USDT').catch(() => 0);
  const untrackedUsd = untrackedBtc * btcPrice;
  if (untrackedUsd < (cmConfig.min_order_usdt || 11)) return null;

  // BTC 직접 페어 존재 여부 확인
  const btcPair = `${base}/BTC`;
  const ex      = getExchange();
  const markets = await ex.loadMarkets();
  if (!markets[btcPair]) {
    console.log(`  ℹ️ ${btcPair} 페어 없음 → USDT 전환 폴백`);
    return null;
  }

  // ETH/BTC 현재가 → 살 수 있는 코인 수량
  const pairTicker = await ex.fetchTicker(btcPair);
  const btcPerCoin = pairTicker.last;  // 1 ETH = N BTC
  const coinAmount = untrackedBtc / btcPerCoin;

  console.log(`  💱 [헤파이스토스] BTC 직접 매수: ${untrackedBtc.toFixed(6)} BTC → ${coinAmount.toFixed(6)} ${base} (${btcPair})`);

  // 시장가 매수
  let order;
  if (paperMode) {
    order = { filled: coinAmount, price: btcPerCoin, dryRun: true };
    console.log(`  📄 [헤파이스토스] PAPER BUY ${btcPair} ${coinAmount.toFixed(6)} @ ${btcPerCoin}`);
  } else {
    order = await ex.createOrder(btcPair, 'market', 'buy', coinAmount);
  }

  const filledCoin  = order.filled || coinAmount;
  const usdPrice    = await fetchTicker(symbol).catch(() => btcPrice * btcPerCoin);
  const usdEquiv    = filledCoin * usdPrice;

  // DB 포지션 등록 (USDT 환산 기준)
  await db.upsertPosition({ symbol, amount: filledCoin, avgPrice: usdPrice, unrealizedPnl: 0, paper: paperMode });

  // TP/SL OCO — /USDT 페어 기준 설정 (일관성 유지)
  const tpPrice = parseFloat((usdPrice * 1.06).toFixed(2));
  const slPrice = parseFloat((usdPrice * 0.97).toFixed(2));
  let tpSlSet   = false;
  if (!paperMode && usdPrice > 0) {
    try {
      const slLimit = parseFloat((slPrice * 0.999).toFixed(2));
      await ex.createOrder(symbol, 'oco_sell', 'sell', filledCoin, tpPrice, {
        stopPrice:            slPrice,
        stopLimitPrice:       slLimit,
        stopLimitTimeInForce: 'GTC',
      });
      tpSlSet = true;
      console.log(`  🛡️ TP/SL OCO (${symbol}): TP=${tpPrice} SL=${slPrice}`);
    } catch (e) {
      console.warn(`  ⚠️ TP/SL 설정 실패: ${e.message}`);
      await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, e);
    }
  }

  const trade = {
    signalId, symbol,
    side:      'buy',
    amount:    filledCoin,
    price:     usdPrice,
    totalUsdt: usdEquiv,
    paper:     paperMode,
    exchange:  'binance',
    tpPrice, slPrice, tpSlSet,
    tpslSource: 'fixed',
  };
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

  await notifyTrade({
    ...trade,
    memo: `BTC 직접 매수 (${btcPair}) — 미추적 BTC ${untrackedBtc.toFixed(6)} 활용${paperMode ? ' [PAPER]' : ''}`,
  }).catch(() => {});

  return { success: true, btcDirect: true, btcPair, amount: filledCoin, price: usdPrice };
}

// ─── 미추적 코인 청산 (자본 확보) ───────────────────────────────────

/**
 * 지갑에서 DB 포지션에 없는 코인(BTC 등)을 매도해 USDT 확보
 * @param {string} excludeBase  — 매수 대상 base 심볼 (예: 'ETH') → 이것은 매도 제외
 * @param {boolean} paperMode
 */
async function _liquidateUntrackedForCapital(excludeBase, paperMode) {
  const ex        = getExchange();
  const walletBal = await ex.fetchBalance();
  let totalUsd    = 0;

  for (const [coin, free] of Object.entries(walletBal.free || {})) {
    if (coin === 'USDT')        continue;  // 기축통화 제외
    if (coin === excludeBase)   continue;  // 매수 대상 제외
    if (!free || free <= 0)     continue;

    const sym        = `${coin}/USDT`;
    const trackedPos = await db.getLivePosition(sym).catch(() => null);
    const trackedAmt = trackedPos?.amount || 0;
    const untracked  = free - trackedAmt;

    if (untracked <= 0) continue;

    const curPrice    = await fetchTicker(sym).catch(() => 0);
    const untrackedUsd = untracked * curPrice;

    if (untrackedUsd < (cmConfig.min_order_usdt || 11)) {
      console.log(`  ℹ️ 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 스킵`);
      continue;
    }

    console.log(`  💱 [헤파이스토스] 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → USDT 전환`);
    await marketSell(sym, untracked, paperMode);
    totalUsd += untrackedUsd;
  }

  if (totalUsd > 0) {
    console.log(`  ✅ 미추적 코인 청산 완료: 총 ≈$${totalUsd.toFixed(2)} USDT 확보`);
    notifyTrade({
      symbol:    `미추적코인→USDT`,
      side:      'liquidate',
      totalUsdt: totalUsd,
      paper:     paperMode,
      exchange:  'binance',
      memo:      `미추적 코인 청산 → 신규 매수 자본 확보${paperMode ? ' [PAPER]' : ''}`,
    }).catch(() => {});
  }
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

/**
 * 단일 바이낸스 신호 실행
 * @param {object} signal  { id, symbol, action, amountUsdt, confidence, reasoning }
 */
export async function executeSignal(signal) {
  const globalPaperMode = isPaperMode();
  const { id: signalId, symbol, action } = signal;
  const amountUsdt = signal.amountUsdt || signal.amount_usdt || 100;
  let effectivePaperMode = globalPaperMode;

  if (!isBinanceSymbol(symbol)) {
    return { success: false, reason: `바이낸스 심볼이 아님: ${symbol}` };
  }

  const tag = effectivePaperMode ? '[PAPER]' : '[LIVE]';
  console.log(`\n⚡ [헤파이스토스] ${symbol} ${action} $${amountUsdt} ${tag}`);

  try {
    let trade;

    if (action === ACTIONS.BUY) {
      if (!globalPaperMode) {
        const promoted = await maybePromotePaperPositions().catch(err => {
          console.warn(`  ⚠️ PAPER 포지션 승격 체크 실패: ${err.message}`);
          return [];
        });
        if (promoted.length > 0) {
          console.log(`  🔁 PAPER→LIVE 승격 완료: ${promoted.map(p => p.symbol).join(', ')}`);
        }
      }

      // ── BUY 공통 안전 게이트 ─────────────────────────────────────────
      // 흡수·BTC직접매수 경로도 서킷 브레이커·포지션 한도·일간 횟수를 준수해야 함
      const circuit = await checkCircuitBreaker();
      if (circuit.triggered) {
        console.log(`  ⛔ [서킷 브레이커] ${circuit.reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        notifyCircuitBreaker({ reason: circuit.reason, type: circuit.type }).catch(() => {});
        return { success: false, reason: circuit.reason };
      }
      const openPositionsSafe = await getOpenPositions('binance').catch(() => []);
      if (openPositionsSafe.length >= cmConfig.max_concurrent_positions) {
        const reason = `최대 포지션 도달: ${openPositionsSafe.length}/${cmConfig.max_concurrent_positions}`;
        console.log(`  ⛔ [자본관리] ${reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        notifyTradeSkip({ symbol, action, reason, openPositions: openPositionsSafe.length, maxPositions: cmConfig.max_concurrent_positions }).catch(() => {});
        return { success: false, reason };
      }
      const dailyTradesSafe = await getDailyTradeCount().catch(() => 0);
      if (dailyTradesSafe >= cmConfig.max_daily_trades) {
        const reason = `일간 매매 한도: ${dailyTradesSafe}/${cmConfig.max_daily_trades}`;
        console.log(`  ⛔ [자본관리] ${reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        notifyTradeSkip({ symbol, action, reason }).catch(() => {});
        return { success: false, reason };
      }

      // ── 미추적 잔고 흡수 ─────────────────────────────────────────────
      // 지갑에 있지만 DB 포지션에 없는 코인 → 기존 BTC를 포지션으로 등록 + TP/SL 설정
      // 이미 보유한 코인을 그대로 매매에 사용 (불필요한 매도·재매수 없음)
      try {
        const base       = symbol.split('/')[0];
        const walletBal  = await getExchange().fetchBalance();
        const walletFree = walletBal.free?.[base] || 0;
        const trackedPos = await db.getLivePosition(symbol);
        const trackedAmt = trackedPos?.amount || 0;
        const untracked  = walletFree - trackedAmt;

        if (untracked > 0) {
          const curPrice     = await fetchTicker(symbol).catch(() => 0);
          const untrackedUsd = untracked * curPrice;

          if (untrackedUsd >= (cmConfig.min_order_usdt || 11)) {
            console.log(`  ✅ [헤파이스토스] 미추적 ${base} 흡수: ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → 포지션 등록 + TP/SL 설정`);

            // DB 포지션 등록 (현재가 기준 평균가)
            const newAmount   = trackedAmt + untracked;
            const newAvgPrice = trackedPos && trackedAmt > 0
              ? ((trackedAmt * trackedPos.avg_price) + untrackedUsd) / newAmount
              : curPrice;
            await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0, paper: effectivePaperMode });

            // TP/SL OCO 설정 (실투자 모드에서만)
            const tpPrice = parseFloat((curPrice * 1.06).toFixed(2));
            const slPrice = parseFloat((curPrice * 0.97).toFixed(2));
            let tpSlSet   = false;
            if (!effectivePaperMode && curPrice > 0) {
              try {
                const ex      = getExchange();
                const slLimit = parseFloat((slPrice * 0.999).toFixed(2));
                await ex.createOrder(symbol, 'oco_sell', 'sell', untracked, tpPrice, {
                  stopPrice:            slPrice,
                  stopLimitPrice:       slLimit,
                  stopLimitTimeInForce: 'GTC',
                });
                tpSlSet = true;
                console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${tpPrice} SL=${slPrice}`);
              } catch (tpslErr) {
                console.warn(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
              }
            }

            // 텔레그램 알림
            const tag = effectivePaperMode ? ' [PAPER]' : '';
            notifyTrade({
              signalId, symbol,
              side:      'absorb',
              amount:    untracked,
              price:     curPrice,
              totalUsdt: untrackedUsd,
              paper:     effectivePaperMode,
              exchange:  'binance',
              tpPrice, slPrice, tpSlSet,
              memo:      `미추적 잔고 흡수 — 봇 외부 매수 코인 포지션 등록${tag}`,
            }).catch(() => {});

            await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
            return { success: true, absorbed: true, amount: untracked, price: curPrice };
          } else {
            console.log(`  ℹ️ 미추적 ${base} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 무시`);
          }
        }
      } catch (e) {
        console.warn(`  ⚠️ 미추적 잔고 흡수 실패 (일반 매수 계속): ${e.message}`);
      }

      // ── 미추적 BTC로 직접 매수 (BTC 페어 우선) ─────────────────────
      // 1순위: ETH/BTC 같은 직접 페어 → BTC→USDT 변환 없이 1회 수수료로 매수
      // 2순위: BTC 페어 없으면 BTC→USDT 전환 후 매수 (USDT 폴백)
      try {
        const btcResult = await _tryBuyWithBtcPair(symbol, base, signalId, signal, effectivePaperMode);
        if (btcResult) return btcResult;
      } catch (e) {
        console.warn(`  ⚠️ BTC 직접 매수 실패 (USDT 전환 폴백): ${e.message}`);
      }

      // USDT 폴백: BTC 페어 없는 종목일 때 BTC → USDT → 매수
      try {
        await _liquidateUntrackedForCapital(base, effectivePaperMode);
      } catch (e) {
        console.warn(`  ⚠️ 미추적 코인 청산 실패 (매수 계속): ${e.message}`);
      }

      // ── 자본 관리 게이트 ────────────────────────────────────────────
      const check = await preTradeCheck(symbol, 'BUY', amountUsdt, 'binance');
      if (!check.allowed) {
        if (!globalPaperMode && !check.circuit && isCapitalShortageReason(check.reason || '')) {
          effectivePaperMode = true;
          console.log(`  📄 [자본관리] 실잔고 부족 → PAPER 폴백: ${check.reason}`);
          await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [`paper_fallback:${check.reason}`, signalId]);
          notifyTradeSkip({ symbol, action, reason: `실잔고 부족으로 PAPER 전환: ${check.reason}` }).catch(() => {});
        } else {
          console.log(`  ⛔ [자본관리] 매매 스킵: ${check.reason}`);
          await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
          await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [check.reason, signalId]);
          if (check.circuit) {
            notifyCircuitBreaker({ reason: check.reason, type: check.circuitType }).catch(() => {});
          } else {
            const openPos = await getOpenPositions('binance').catch(() => []);
            notifyTradeSkip({ symbol, action, reason: check.reason, openPositions: openPos.length, maxPositions: cmConfig.max_concurrent_positions }).catch(() => {});
          }
          return { success: false, reason: check.reason };
        }
      }

      // ── 동적 포지션 사이징 ──────────────────────────────────────────
      const slPrice = signal.slPrice || 0;
      const currentPrice = await fetchTicker(symbol).catch(() => 0);
      const sizing  = await calculatePositionSize(symbol, currentPrice, slPrice);
      if (sizing.skip && !effectivePaperMode) {
        console.log(`  ⛔ [자본관리] 포지션 크기 부족: ${sizing.reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [sizing.reason, signalId]);
        notifyTradeSkip({ symbol, action, reason: sizing.reason }).catch(() => {});
        return { success: false, reason: sizing.reason };
      }
      const actualAmount = effectivePaperMode ? amountUsdt : sizing.size;
      if (effectivePaperMode) {
        console.log(`  📄 [PAPER] 시그널 원본 금액으로 가상 포지션 추적: ${actualAmount.toFixed(2)} USDT`);
      } else {
        console.log(`  📐 [자본관리] 포지션 ${actualAmount.toFixed(2)} USDT (자본의 ${sizing.capitalPct}% | 리스크 ${sizing.riskPercent}%)`);
      }

      const order = await marketBuy(symbol, actualAmount, effectivePaperMode);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: actualAmount,
        paper:     effectivePaperMode,
        exchange:  'binance',
      };

      const existing    = await db.getPosition(symbol);
      if (effectivePaperMode && existing && existing.paper === false) {
        const reason = '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음';
        console.log(`  ⛔ [자본관리] ${reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [reason, signalId]);
        notifyTradeSkip({ symbol, action, reason }).catch(() => {});
        return { success: false, reason };
      }
      const newAmount   = (existing?.amount || 0) + (order.filled || 0);
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + actualAmount) / newAmount
        : order.price || 0;

      await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0, paper: effectivePaperMode });

      // ── TP/SL 가격 결정 (동적/고정, PAPER_MODE 포함) ────────────────
      // 우선순위: 1) 네메시스 동적 TP/SL (signal.tpPrice/slPrice, applied=true)
      //           2) 고정 TP +6%, SL -3% 폴백
      const fillPrice = order.price || order.average || 0;
      if (fillPrice > 0 && order.filled > 0) {
        const hasDynamic  = !!(signal.tpPrice && signal.slPrice);
        trade.tpPrice     = hasDynamic
          ? parseFloat(signal.tpPrice.toFixed(2))
          : parseFloat((fillPrice * 1.06).toFixed(2));
        trade.slPrice     = hasDynamic
          ? parseFloat(signal.slPrice.toFixed(2))
          : parseFloat((fillPrice * 0.97).toFixed(2));
        trade.tpslSource  = hasDynamic ? (signal.tpslSource || 'atr') : 'fixed';
        const tpslTag     = hasDynamic ? '[동적 TP/SL]' : '[고정 TP/SL]';
        console.log(`  📐 ${tpslTag} TP=${trade.tpPrice} SL=${trade.slPrice} (${trade.tpslSource})`);

        // OCO 주문은 실투자 모드에서만 거래소에 실제 전송
        if (!effectivePaperMode) {
          try {
            const ex      = getExchange();
            const slLimit = parseFloat((trade.slPrice * 0.999).toFixed(2));
            const ocoOrder = await ex.createOrder(symbol, 'oco_sell', 'sell', order.filled, trade.tpPrice, {
              stopPrice:            trade.slPrice,
              stopLimitPrice:       slLimit,
              stopLimitTimeInForce: 'GTC',
            });
            // Binance OCO 응답: orderReports[0]=LIMIT_MAKER(TP), [1]=STOP_LOSS_LIMIT(SL)
            trade.tpOrderId = ocoOrder?.info?.orderReports?.[0]?.orderId?.toString() ?? null;
            trade.slOrderId = ocoOrder?.info?.orderReports?.[1]?.orderId?.toString() ?? null;
            trade.tpSlSet   = true;
            console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${trade.tpPrice} SL=${trade.slPrice}`);
          } catch (tpslErr) {
            console.error(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
            trade.tpSlSet = false;
            await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, tpslErr);
          }
        }
      }

    } else if (action === ACTIONS.SELL) {
      // DB 포지션 우선, 없으면 실제 바이낸스 잔고 조회 (외부 매수 코인도 매도 가능)
      const position = await db.getPosition(symbol);
      let amount = position?.amount;
      const sellPaperMode = globalPaperMode || Boolean(position?.paper);
      if (!amount || amount <= 0) {
        const base = symbol.split('/')[0];
        const bal  = await getExchange().fetchBalance();
        amount = bal.free[base] || 0;
        if (amount <= 0) {
          console.warn(`  ⚠️ ${symbol} 보유량 없음 (DB+바이낸스 모두 0) — SELL 스킵`);
          await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
          return { success: false, reason: '보유량 없음' };
        }
        console.log(`  ℹ️ DB 포지션 없음 → 바이낸스 실잔고 사용: ${amount} ${base}`);
      }

      const order = await marketSell(symbol, amount, sellPaperMode);
      trade = {
        signalId,
        symbol,
        side:      'sell',
        amount:    order.amount || amount,
        price:     order.price,
        totalUsdt: order.totalUsdt,
        paper:     sellPaperMode,
        exchange:  'binance',
      };

      await db.deletePosition(symbol);

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

    // 자본 관리 정보 포함 알림
    const [curBalance, curPositions, curDailyPnl] = await Promise.all([
      getAvailableBalance().catch(() => null),
      getOpenPositions('binance').catch(() => []),
      getDailyPnL().catch(() => null),
    ]);
    await notifyTrade({
      ...trade,
      capitalInfo: {
        balance:       curBalance,
        openPositions: curPositions.length,
        maxPositions:  cmConfig.max_concurrent_positions,
        dailyPnL:      curDailyPnl,
      },
    });

    // ── 매매일지 기록 (기존 기능에 영향 없도록 try-catch 감쌈) ────────
    try {
      if (trade.side === 'buy') {
        const execTime = Date.now();
        const tradeId  = await journalDb.generateTradeId();
        await journalDb.insertJournalEntry({
          trade_id:      tradeId,
          signal_id:     signalId,
          market:        'crypto',
          exchange:      trade.exchange,
          symbol:        trade.symbol,
          is_paper:      trade.paper,
          entry_time:    execTime,
          entry_price:   trade.price || 0,
          entry_size:    trade.amount || 0,
          entry_value:   trade.totalUsdt || 0,
          direction:     'long',
          tp_price:      trade.tpPrice ?? null,
          sl_price:      trade.slPrice ?? null,
          tp_order_id:   trade.tpOrderId ?? null,
          sl_order_id:   trade.slOrderId ?? null,
          tp_sl_set:     trade.tpSlSet ?? false,
        });
        await journalDb.linkRationaleToTrade(tradeId, signalId);
        notifyJournalEntry({
          tradeId,
          symbol:    trade.symbol,
          direction: 'long',
          market:    'crypto',
          entryPrice: trade.price,
          entryValue: trade.totalUsdt,
          isPaper:   trade.paper,
          tpPrice:   trade.tpPrice,
          slPrice:   trade.slPrice,
          tpSlSet:   trade.tpSlSet,
        });
      } else if (trade.side === 'sell') {
        await closeOpenJournalForSymbol(
          trade.symbol,
          trade.paper,
          trade.price,
          trade.totalUsdt,
          'signal_reverse',
        );
      }
    } catch (journalErr) {
      console.warn(`  ⚠️ 매매일지 기록 실패 (거래는 정상 완료): ${journalErr.message}`);
    }

    const doneTag = trade.paper ? '[PAPER]' : '[LIVE]';
    console.log(`  ✅ ${doneTag} 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED).catch(() => {});
    await notifyError(`헤파이스토스 - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 바이낸스 신호 전체 처리
 */
export async function processAllPendingSignals() {
  const signals = await db.getApprovedSignals('binance');
  if (signals.length === 0) {
    console.log('[헤파이스토스] 대기 신호 없음');
    return [];
  }

  console.log(`[헤파이스토스] ${signals.length}개 신호 처리 시작`);
  const results = [];
  for (const signal of signals) {
    const r = await executeSignal(signal);
    results.push(r);
    await new Promise(res => setTimeout(res, 500));
  }
  return results;
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args              = process.argv.slice(2);
  const actionArg         = args.find(a => a.startsWith('--action='))?.split('=')[1];
  const symbolArg         = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
  const amountArg         = args.find(a => a.startsWith('--amount='))?.split('=')[1];
  const inspectPromotions = args.includes('--inspect-promotions');
  const simulateBuy       = args.includes('--simulate-buy');

  await db.initSchema();
  try {
    let r;
    if (inspectPromotions) {
      r = await inspectPromotionCandidates();
    } else if (simulateBuy && symbolArg) {
      r = await simulateBuyDecision({
        symbol: symbolArg.toUpperCase(),
        amountUsdt: parseFloat(amountArg || '100'),
      });
    } else if (actionArg && symbolArg) {
      r = await executeSignal({
        id:         `CLI-${Date.now()}`,
        symbol:     symbolArg.toUpperCase(),
        action:     actionArg.toUpperCase(),
        amountUsdt: parseFloat(amountArg || '100'),
        confidence: 0.7,
        reasoning:  'CLI 수동 실행',
      });
    } else {
      r = await processAllPendingSignals();
    }
    console.log('완료:', JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.error('❌ 헤파이스토스 오류:', e.message);
    process.exit(1);
  }
}

// @ts-nocheck
/**
 * PAPER -> LIVE promotion and buy simulation helpers for Hephaestos.
 *
 * The caller still decides when promotion is attempted. This module owns the
 * candidate inspection and promotion side effects so the main executor does
 * not carry the whole paper/live transition policy inline.
 */

export function createPaperPromotionPolicy(context = {}) {
  const {
    getCapitalConfig,
    getDynamicMinOrderAmount,
    getAvailableUSDT,
    getOpenPositions,
    preTradeCheck,
    isCapitalShortageReason,
    db,
    journalDb,
    marketBuy,
    closeOpenJournalForSymbol,
    notifyJournalEntry,
    notifyTrade,
    fetchTicker,
    calculatePositionSize,
    isPaperMode,
    getInvestmentTradeMode,
  } = context;

  async function maybePromotePaperPositions({ reserveSlots = 0 } = {}) {
    const capitalPolicy = getCapitalConfig('binance', 'normal');
    const minOrderUsdt = await getDynamicMinOrderAmount('binance', 'normal');
    const paperPositions = await db.getPaperPositions('binance', 'normal').catch(() => []);
    if (paperPositions.length === 0) return [];

    let liveOpenPositions = await getOpenPositions('binance', false, 'normal').catch(() => []);
    const maxPromotableOpenPositions = Math.max(0, capitalPolicy.max_concurrent_positions - Math.max(0, reserveSlots));
    if (liveOpenPositions.length >= maxPromotableOpenPositions) return [];

    const promoted = [];
    for (const paperPos of paperPositions) {
      if (liveOpenPositions.length >= maxPromotableOpenPositions) break;

      const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
      if (desiredUsdt < minOrderUsdt) continue;

      const freeUsdt = await getAvailableUSDT().catch(() => 0);
      if (freeUsdt < desiredUsdt) break;

      const check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance', 'normal');
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
        executionOrigin: 'promotion',
        qualityFlag: 'exclude_from_learning',
        excludeFromLearning: true,
        incidentLink: 'paper_to_live_promotion',
      };

      await closeOpenJournalForSymbol(
        paperPos.symbol,
        true,
        order.price,
        (paperPos.amount || 0) * (order.price || 0),
        'promoted_to_live',
        paperPos.trade_mode || 'normal',
        {
          executionOrigin: 'promotion',
          qualityFlag: 'exclude_from_learning',
          excludeFromLearning: true,
          incidentLink: 'paper_to_live_promotion',
        },
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
          execution_origin: 'promotion',
          quality_flag: 'exclude_from_learning',
          exclude_from_learning: true,
          incident_link: 'paper_to_live_promotion',
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
        tradeMode: 'normal',
        memo: `기존 PAPER 포지션 실투자 승격 (${paperPos.amount?.toFixed(6)} → ${trade.amount?.toFixed(6)})`,
      }).catch(() => {});

      promoted.push({ symbol: paperPos.symbol, totalUsdt: desiredUsdt, amount: trade.amount });
      liveOpenPositions = await getOpenPositions('binance', false, 'normal').catch(() => liveOpenPositions);
    }

    return promoted;
  }

  async function inspectPromotionCandidates() {
    const minOrderUsdt = await getDynamicMinOrderAmount('binance', 'normal');
    const freeUsdt = await getAvailableUSDT().catch(() => 0);
    const paperPositions = await db.getPaperPositions('binance', 'normal').catch(() => []);
    const results = [];

    for (const paperPos of paperPositions) {
      const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
      const minOrder = minOrderUsdt;
      const tooSmall = desiredUsdt < minOrder;
      const enoughUsdt = freeUsdt >= desiredUsdt;
      /** @type {any} */
      let check = { allowed: false, reason: tooSmall ? `최소 주문 미만: ${desiredUsdt.toFixed(2)} USDT` : 'USDT 부족' };

      if (!tooSmall && enoughUsdt) {
        check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance', 'normal');
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

  async function simulateBuyDecision({ symbol, amountUsdt = 100 }) {
    const tradeMode = getInvestmentTradeMode();
    const capitalPolicy = getCapitalConfig('binance', tradeMode);
    const minOrderUsdt = await getDynamicMinOrderAmount('binance', tradeMode);
    const currentPrice = await fetchTicker(symbol).catch(() => 0);
    const slPrice = 0;
    const check = await preTradeCheck(symbol, 'BUY', amountUsdt, 'binance');
    const sizing = await calculatePositionSize(symbol, currentPrice, slPrice, 'binance');
    const paperFallback = !isPaperMode() && !check.circuit && !check.allowed && isCapitalShortageReason(check.reason || '');
    const reducedAmountMultiplier = Number(check.reducedAmountMultiplier || 1);
    const suggestedLiveAmountUsdt = sizing.skip ? 0 : sizing.size * (reducedAmountMultiplier > 0 && reducedAmountMultiplier < 1 ? reducedAmountMultiplier : 1);

    return {
      symbol,
      requestedAmountUsdt: amountUsdt,
      currentPrice,
      liveAllowed: check.allowed,
      liveReason: check.allowed ? 'LIVE 가능' : check.reason,
      paperFallback,
      finalMode: check.allowed ? 'live' : paperFallback ? 'paper' : 'blocked',
      suggestedLiveAmountUsdt,
      softGuardApplied: Boolean(check.softGuardApplied),
      softGuards: check.softGuards || [],
      reducedAmountMultiplier,
      capitalPolicy: {
        reserveRatio: capitalPolicy.reserve_ratio,
        minOrderUsdt,
        maxPositionPct: capitalPolicy.max_position_pct,
        maxConcurrentPositions: capitalPolicy.max_concurrent_positions,
      },
      sizing,
    };
  }

  return {
    maybePromotePaperPositions,
    inspectPromotionCandidates,
    simulateBuyDecision,
  };
}

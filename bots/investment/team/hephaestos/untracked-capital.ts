// @ts-nocheck

function formatConvertAmount(amount, decimals = 12) {
  return Number(amount || 0).toFixed(decimals).replace(/0+$/u, '').replace(/\.$/u, '');
}

export function createUntrackedCapitalPolicy({
  SIGNAL_STATUS,
  db,
  getExchange,
  getCapitalConfig,
  getDynamicMinOrderAmount,
  getInvestmentTradeMode,
  fetchTicker,
  marketSell,
  normalizeProtectiveExitPrices,
  buildProtectionSnapshot,
  placeBinanceProtectiveExit,
  isStopLossOnlyMode,
  notifyError,
  notifyTrade,
} = {}) {
  async function tryConvertResidualDustToUsdt(symbol, amount) {
    const ex = getExchange();
    const base = String(symbol || '').split('/')[0];
    const normalizedAmount = Number(amount || 0);
    if (!(normalizedAmount > 0.00000001)) return null;
    if (typeof ex.fetchConvertQuote !== 'function' || typeof ex.createConvertTrade !== 'function') return null;

    const convertAmount = formatConvertAmount(normalizedAmount);
    if (!convertAmount) return null;

    const quote = await ex.fetchConvertQuote(base, 'USDT', convertAmount);
    const quoteId = quote?.id || quote?.info?.quoteId;
    if (!quoteId) return null;

    const execution = await ex.createConvertTrade(quoteId, base, 'USDT', convertAmount);
    return {
      amount: normalizedAmount,
      toAmount: Number(execution?.toAmount || execution?.info?.toAmount || quote?.toAmount || 0),
      orderId: execution?.id || execution?.order || execution?.info?.orderId || quoteId,
    };
  }

  async function tryAbsorbUntrackedBalance({
    signalId,
    symbol,
    base,
    signalTradeMode,
    minOrderUsdt,
    effectivePaperMode,
  }) {
    try {
      const walletBal = await getExchange().fetchBalance();
      const walletFree = walletBal.free?.[base] || 0;
      const trackedPos = await db.getLivePosition(symbol, null, signalTradeMode);
      const trackedAmt = trackedPos?.amount || 0;
      const untracked = walletFree - trackedAmt;
      if (!(untracked > 0)) return null;

      const curPrice = await fetchTicker(symbol).catch(() => 0);
      const untrackedUsd = untracked * curPrice;
      if (untrackedUsd < minOrderUsdt) {
        console.log(`  ℹ️ 미추적 ${base} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 무시`);
        return null;
      }

      console.log(`  ✅ [헤파이스토스] 미추적 ${base} 흡수: ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → 포지션 등록 + TP/SL 설정`);

      const newAmount = trackedAmt + untracked;
      const newAvgPrice = trackedPos && trackedAmt > 0
        ? ((trackedAmt * trackedPos.avg_price) + untrackedUsd) / newAmount
        : curPrice;
      await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0, paper: effectivePaperMode });

      const normalizedProtection = normalizeProtectiveExitPrices(symbol, curPrice, curPrice * 1.06, curPrice * 0.97, 'fixed');
      const tpPrice = normalizedProtection.tpPrice;
      const slPrice = normalizedProtection.slPrice;
      let protectionSnapshot = buildProtectionSnapshot();
      if (!effectivePaperMode && curPrice > 0) {
        try {
          const protection = await placeBinanceProtectiveExit(symbol, untracked, curPrice, tpPrice, slPrice);
          protectionSnapshot = buildProtectionSnapshot(protection);
          if (protection.ok) {
            console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${tpPrice} SL=${slPrice}`);
          } else if (isStopLossOnlyMode(protection.mode)) {
            console.warn(`  ⚠️ TP/SL OCO 미지원 → SL-only 보호주문 설정: SL=${slPrice}`);
          } else {
            throw new Error(protection.error || 'protective_exit_failed');
          }
        } catch (tpslErr) {
          protectionSnapshot = buildProtectionSnapshot(null, tpslErr.message);
          console.warn(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
        }
      }

      const paperTag = effectivePaperMode ? ' [PAPER]' : '';
      notifyTrade({
        signalId,
        symbol,
        side: 'absorb',
        amount: untracked,
        price: curPrice,
        totalUsdt: untrackedUsd,
        paper: effectivePaperMode,
        exchange: 'binance',
        tpPrice,
        slPrice,
        ...protectionSnapshot,
        memo: `미추적 잔고 흡수 — 봇 외부 매수 코인 포지션 등록${paperTag}`,
      }).catch(() => {});

      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true, absorbed: true, amount: untracked, price: curPrice };
    } catch (error) {
      console.warn(`  ⚠️ 미추적 잔고 흡수 실패 (일반 매수 계속): ${error.message}`);
      return null;
    }
  }

  async function getUntrackedLiquidationQuarantineSummary(symbol) {
    const [recentTrade] = await db.query(
      `SELECT side, executed_at
         FROM trades
        WHERE symbol = $1
          AND exchange = 'binance'
          AND executed_at > now() - interval '24 hours'
        ORDER BY executed_at DESC
        LIMIT 1`,
      [symbol],
    ).catch(() => [[]]);

    const [recentPromotion] = await db.query(
      `SELECT trade_id, exit_time
         FROM trade_journal
        WHERE symbol = $1
          AND exchange = 'binance'
          AND exit_reason = 'promoted_to_live'
          AND exit_time IS NOT NULL
          AND to_timestamp(exit_time / 1000.0) > now() - interval '24 hours'
        ORDER BY exit_time DESC
        LIMIT 1`,
      [symbol],
    ).catch(() => [[]]);

    return {
      recentTrade: recentTrade || null,
      recentPromotion: recentPromotion || null,
      active: Boolean(recentTrade || recentPromotion),
    };
  }

  async function liquidateUntrackedForCapital(excludeBasesInput, paperMode) {
    const minOrderUsdt = await getDynamicMinOrderAmount('binance', getInvestmentTradeMode());
    const ex = getExchange();
    const walletBal = await ex.fetchBalance();
    let totalUsd = 0;
    const liquidated = [];
    const quarantined = [];
    const excludeBases = new Set(
      (Array.isArray(excludeBasesInput) ? excludeBasesInput : [excludeBasesInput])
        .filter(Boolean)
        .map((value) => String(value).trim().toUpperCase()),
    );

    for (const [coin, free] of Object.entries(walletBal.free || {})) {
      if (coin === 'USDT') continue;
      if (excludeBases.has(String(coin).trim().toUpperCase())) continue;
      if (!free || free <= 0) continue;

      const sym = `${coin}/USDT`;
      const trackedPos = await db.getLivePosition(sym, null, getInvestmentTradeMode()).catch(() => null);
      const trackedAmt = trackedPos?.amount || 0;
      const untracked = free - trackedAmt;

      if (untracked <= 0) continue;

      const curPrice = await fetchTicker(sym).catch(() => 0);
      const untrackedUsd = untracked * curPrice;

      if (untrackedUsd < minOrderUsdt) {
        console.log(`  ℹ️ 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 스킵`);
        continue;
      }

      const quarantine = await getUntrackedLiquidationQuarantineSummary(sym);
      if (quarantine.active) {
        const reasons = [
          quarantine.recentPromotion ? '최근 승격 이력' : null,
          quarantine.recentTrade ? `최근 ${String(quarantine.recentTrade.side || 'trade').toUpperCase()} 체결` : null,
        ].filter(Boolean);
        console.log(`  🧪 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — ${reasons.join(' + ')} 감지, 자동 청산 보류`);
        quarantined.push(`${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)})`);
        continue;
      }

      console.log(`  💱 [헤파이스토스] 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → USDT 전환`);
      const liquidationOrder = await marketSell(sym, untracked, paperMode);
      const liquidatedAmount = Number(liquidationOrder?.filled || liquidationOrder?.amount || untracked || 0);
      const liquidatedPrice = Number(liquidationOrder?.price || liquidationOrder?.average || curPrice || 0);
      const liquidatedUsdt = Number(liquidationOrder?.totalUsdt || liquidationOrder?.cost || (liquidatedAmount * liquidatedPrice));
      await db.insertTrade({
        signalId: null,
        symbol: sym,
        side: 'liquidate',
        amount: liquidatedAmount,
        price: liquidatedPrice || null,
        totalUsdt: liquidatedUsdt,
        paper: paperMode,
        exchange: 'binance',
        tradeMode: getInvestmentTradeMode(),
        executionOrigin: 'cleanup',
        qualityFlag: 'exclude_from_learning',
        excludeFromLearning: true,
        incidentLink: 'untracked_liquidation',
      }).catch((err) => {
        console.warn(`  ⚠️ 미추적 청산 체결 기록 실패 (${sym}): ${err.message}`);
      });
      totalUsd += liquidatedUsdt;
      liquidated.push(`${coin} ${liquidatedAmount.toFixed(6)} (≈$${liquidatedUsdt.toFixed(2)})`);
    }

    if (totalUsd > 0) {
      console.log(`  ✅ 미추적 코인 청산 완료: 총 ≈$${totalUsd.toFixed(2)} USDT 확보`);
      notifyTrade({
        symbol: '미추적코인→USDT',
        side: 'liquidate',
        totalUsdt: totalUsd,
        paper: paperMode,
        exchange: 'binance',
        tradeMode: getInvestmentTradeMode(),
        memo: `미추적 코인 청산 → 신규 매수 자본 확보${paperMode ? ' [PAPER]' : ''}${liquidated.length ? ` | ${liquidated.join(', ')}` : ''}`,
      }).catch(() => {});
    }

    if (quarantined.length > 0) {
      console.log(`  🧪 미추적 코인 자동 청산 보류: ${quarantined.join(', ')}`);
    }

    return {
      totalUsd,
      liquidated,
      quarantined,
    };
  }

  return {
    tryConvertResidualDustToUsdt,
    tryAbsorbUntrackedBalance,
    getUntrackedLiquidationQuarantineSummary,
    liquidateUntrackedForCapital,
  };
}

// @ts-nocheck

export function createLunaPortfolioDecisionGuards({
  ACTIONS,
  db,
  getOpenPositions,
  getCapitalConfigWithOverrides,
  isPaperMode,
  isValidationTradeMode,
  adjustLunaBuyCandidate,
  enrichCapitalCheck,
  checkReflexionBeforeEntry,
}) {
  async function applyCryptoRepresentativePass(portfolioDecision, exchange) {
    if (exchange !== 'binance') {
      return { decision: portfolioDecision, reduction: null };
    }
    if (isPaperMode() || isValidationTradeMode()) {
      return { decision: portfolioDecision, reduction: null };
    }

    const decisions = Array.isArray(portfolioDecision?.decisions) ? [...portfolioDecision.decisions] : [];
    const buyDecisions = decisions.filter((item) => item?.action === ACTIONS.BUY);
    if (buyDecisions.length <= 1) {
      return { decision: portfolioDecision, reduction: null };
    }

    const [openPositions, capitalPolicy] = await Promise.all([
      getOpenPositions(exchange, false, 'normal').catch(() => []),
      getCapitalConfigWithOverrides(exchange, 'normal').catch(() => ({})),
    ]);

    const maxSameDirection = Number(capitalPolicy?.max_same_direction_positions || 3);
    const currentLongCount = Array.isArray(openPositions) ? openPositions.length : 0;
    const remainingLongSlots = Math.max(0, maxSameDirection - currentLongCount);

    if (buyDecisions.length <= remainingLongSlots) {
      return { decision: portfolioDecision, reduction: null };
    }

    const sortedBuys = [...buyDecisions].sort((a, b) => {
      const confidenceGap = Number(b?.confidence || 0) - Number(a?.confidence || 0);
      if (confidenceGap !== 0) return confidenceGap;
      const amountGap = Number(b?.amount_usdt || 0) - Number(a?.amount_usdt || 0);
      if (amountGap !== 0) return amountGap;
      return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
    });

    const keepBuySet = new Set(sortedBuys.slice(0, remainingLongSlots).map((item) => item.symbol));
    const kept = [];
    const dropped = [];
    const nextDecisions = decisions.filter((item) => {
      if (item?.action !== ACTIONS.BUY) return true;
      if (keepBuySet.has(item.symbol)) {
        kept.push(item.symbol);
        keepBuySet.delete(item.symbol);
        return true;
      }
      dropped.push(item.symbol);
      return false;
    });

    return {
      decision: {
        ...portfolioDecision,
        decisions: nextDecisions,
      },
      reduction: {
        currentLongCount,
        maxSameDirection,
        remainingLongSlots,
        requestedBuyCount: buyDecisions.length,
        kept,
        dropped,
      },
    };
  }

  async function applyReflexionEntryGateToDecisions(portfolioDecision, exchange) {
    const decisions = Array.isArray(portfolioDecision?.decisions) ? portfolioDecision.decisions : [];
    if (decisions.length === 0) return portfolioDecision;

    const adjusted = [];
    for (const decision of decisions) {
      if (decision?.action !== ACTIONS.BUY) {
        adjusted.push(decision);
        continue;
      }

      const reflexion = await checkReflexionBeforeEntry(
        decision.symbol,
        exchange,
        'LONG',
        { pattern: decision?.setup_type || decision?.strategy_route?.setupType || null },
      ).catch(() => ({
        confidenceDelta: 0,
        blockedByReflexion: false,
        relevantFailures: [],
        warningMessage: null,
      }));

      if (reflexion?.blockedByReflexion) {
        const nextDecision = {
          ...decision,
          action: ACTIONS.HOLD,
          amount_usdt: 0,
          confidence: Math.max(0, Number(decision?.confidence || 0) + Number(reflexion?.confidenceDelta || 0)),
          reasoning: `reflexion_entry_blocked: ${(reflexion?.warningMessage || '유사 실패 패턴').slice(0, 160)}`,
          block_meta: {
            ...(decision?.block_meta || {}),
            reflexion: {
              blocked: true,
              confidenceDelta: Number(reflexion?.confidenceDelta || 0),
              failures: Number(reflexion?.relevantFailures?.length || 0),
            },
          },
        };
        adjusted.push(nextDecision);
        await db.run(
          `INSERT INTO investment.mapek_knowledge(event_type, payload) VALUES ($1, $2::jsonb)`,
          ['reflexion_entry_blocked', JSON.stringify({
            symbol: decision.symbol,
            exchange,
            confidence_delta: Number(reflexion?.confidenceDelta || 0),
            failures: Number(reflexion?.relevantFailures?.length || 0),
            at: new Date().toISOString(),
          })],
        ).catch(() => {});
        continue;
      }

      const delta = Number(reflexion?.confidenceDelta || 0);
      if (delta >= 0) {
        adjusted.push(decision);
        continue;
      }
      const nextConfidence = Math.max(0, Math.min(1, Number(decision?.confidence || 0) + delta));
      adjusted.push({
        ...decision,
        confidence: nextConfidence,
        reasoning: `${decision?.reasoning || ''} | reflexion_confidence_adjusted(${delta.toFixed(2)})`.slice(0, 200),
        block_meta: {
          ...(decision?.block_meta || {}),
          reflexion: {
            blocked: false,
            confidenceDelta: delta,
            failures: Number(reflexion?.relevantFailures?.length || 0),
          },
        },
      });
      await db.run(
        `INSERT INTO investment.mapek_knowledge(event_type, payload) VALUES ($1, $2::jsonb)`,
        ['reflexion_confidence_adjusted', JSON.stringify({
          symbol: decision.symbol,
          exchange,
          confidence_delta: delta,
          adjusted_confidence: nextConfidence,
          failures: Number(reflexion?.relevantFailures?.length || 0),
          at: new Date().toISOString(),
        })],
      ).catch(() => {});
    }
    return { ...portfolioDecision, decisions: adjusted };
  }

  function applyBudgetCheckerToDecisions(portfolioDecision, portfolio, exchange) {
    const capitalSnapshot = portfolio?.capitalSnapshot ?? null;
    if (!capitalSnapshot) return portfolioDecision;

    const decisions = Array.isArray(portfolioDecision?.decisions) ? portfolioDecision.decisions : [];
    const adjusted = [];
    let anyAdjusted = false;

    for (const d of decisions) {
      if (d.action !== ACTIONS.BUY) {
        adjusted.push(d);
        continue;
      }
      const desired = Number(d.amount_usdt || 0);
      const check = adjustLunaBuyCandidate(desired, capitalSnapshot);
      const enrichedCheck = enrichCapitalCheck(check, capitalSnapshot);

      if (check.result === 'accepted') {
        adjusted.push(d);
        continue;
      }

      anyAdjusted = true;

      if (check.result === 'reduced') {
        console.log(`  💱 [루나 budget] ${d.symbol} BUY ${desired} → ${check.adjustedAmount} (${check.reason})`);
        adjusted.push({
          ...d,
          amount_usdt: check.adjustedAmount,
          block_meta: { capitalCheck: enrichedCheck },
        });
        continue;
      }

      console.log(`  🔒 [루나 budget] ${d.symbol} BUY → HOLD (${check.result}): ${check.reason}`);
      adjusted.push({
        ...d,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `capital_backpressure: ${check.reason} | ${d.reasoning || ''}`.slice(0, 200),
        block_meta: { capitalCheck: enrichedCheck },
      });
    }

    if (!anyAdjusted) return portfolioDecision;
    return { ...portfolioDecision, decisions: adjusted };
  }

  return {
    applyCryptoRepresentativePass,
    applyReflexionEntryGateToDecisions,
    applyBudgetCheckerToDecisions,
  };
}

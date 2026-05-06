// @ts-nocheck
import {
  ensureLunaDiscoveryEntryTables,
  expireEntryTriggers,
  getRecentFiredEntryTrigger,
  insertEntryTrigger,
  updateEntryTriggerState,
  listActiveEntryTriggers,
} from './luna-discovery-entry-store.ts';
import { getLunaIntelligentDiscoveryFlags } from './luna-intelligent-discovery-config.ts';
import { checkAvoidPatterns } from './reflexion-engine.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';
import { evaluateLunaConstitutionForEntry } from './luna-constitution.ts';
import { buildPredictiveValidationEvidence } from './predictive-validation.ts';
import { isMaturePosition } from './luna-discovery-mature-policy.ts';
import { enforceTpSlRequirement } from './tp-sl-enforcer.ts';
import { evaluateTradingViewEntryGuard } from './tradingview-entry-guard.ts';
import { query as dbQuery } from './db/core.ts';

const ACTIONS = {
  BUY: 'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
};

function nowIso() {
  return new Date().toISOString();
}

function plusMinutes(minutes = 180) {
  return new Date(Date.now() + Math.max(1, Number(minutes || 180)) * 60000).toISOString();
}

function resolveTriggerType(candidate = {}) {
  const setup = String(candidate?.setup_type || candidate?.strategy_route?.setupType || candidate?.setupType || '').toLowerCase();
  if (setup.includes('breakout')) return 'breakout_confirmation';
  if (setup.includes('mean') || setup.includes('pullback')) return 'pullback_to_support';
  if (setup.includes('volume') || setup.includes('vsa')) return 'volume_burst';
  if (setup.includes('mtf')) return 'mtf_alignment';
  if (setup.includes('news')) return 'news_momentum';
  return 'mtf_alignment';
}

function isAllowedTriggerType(triggerType, flags) {
  const allowed = Array.isArray(flags?.entryTrigger?.triggerTypes)
    ? flags.entryTrigger.triggerTypes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return allowed.length <= 0 || allowed.includes(triggerType);
}

function shouldFireTrigger(candidate = {}, context = {}) {
  const hints = candidate?.triggerHints || {};
  const mtfAgreement = Number(hints.mtfAgreement ?? context?.mtfAgreement ?? 0);
  const discoveryScore = Number(hints.discoveryScore ?? context?.discoveryScore ?? 0);
  const volumeBurst = Number(hints.volumeBurst ?? 0);
  const breakoutRetest = hints.breakoutRetest === true;
  const newsMomentum = Number(hints.newsMomentum ?? 0);

  if (breakoutRetest && mtfAgreement >= 0.62) return true;
  if (volumeBurst >= 1.8 && mtfAgreement >= 0.58) return true;
  if (newsMomentum >= 0.6 && discoveryScore >= 0.62) return true;
  if (mtfAgreement >= 0.72 && discoveryScore >= 0.58) return true;
  return false;
}

function annotateEntryTrigger(candidate = {}, entryTrigger = {}) {
  return {
    ...candidate,
    block_meta: {
      ...(candidate?.block_meta || {}),
      entryTrigger: {
        ...((candidate?.block_meta || {}).entryTrigger || {}),
        ...entryTrigger,
      },
    },
  };
}

function finiteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveCapitalSnapshot(candidate = {}, context = {}) {
  return (
    context?.capitalSnapshot
    || context?.portfolio?.capitalSnapshot
    || candidate?.capitalSnapshot
    || candidate?.portfolio?.capitalSnapshot
    || null
  );
}

function resolveCapitalCheck(candidate = {}, context = {}) {
  return (
    candidate?.block_meta?.capitalCheck
    || candidate?.capitalCheck
    || context?.capitalCheck
    || null
  );
}

function resolveCandidateTpSlInput(candidate = {}, context = {}, market = 'crypto') {
  return {
    entryPrice: candidate?.entry_price ?? candidate?.entryPrice ?? candidate?.target_price ?? candidate?.targetPrice ?? context?.entryPrice ?? null,
    side: candidate?.side || 'BUY',
    atr: candidate?.atr ?? candidate?.atr_value ?? candidate?.indicators?.atr ?? candidate?.block_meta?.atr ?? context?.atr ?? null,
    prePlannedSl: candidate?.sl_price ?? candidate?.stop_loss ?? candidate?.stopLoss ?? candidate?.block_meta?.sl_price ?? null,
    prePlannedTp: candidate?.tp_price ?? candidate?.take_profit ?? candidate?.takeProfit ?? candidate?.block_meta?.tp_price ?? null,
    tpSlSet: candidate?.tp_sl_set === true || candidate?.tpSlSet === true || candidate?.block_meta?.tp_sl_set === true || candidate?.block_meta?.tpSlSet === true,
    market,
    symbol: candidate?.symbol || null,
  };
}

function applyComputedTpSl(candidate = {}, enforcement = null) {
  if (!enforcement?.computed) return candidate;
  return {
    ...candidate,
    tp_sl_set: true,
    sl_price: candidate?.sl_price ?? candidate?.stop_loss ?? candidate?.stopLoss ?? enforcement.computed.stopLoss,
    tp_price: candidate?.tp_price ?? candidate?.take_profit ?? candidate?.takeProfit ?? enforcement.computed.takeProfit,
    block_meta: {
      ...(candidate?.block_meta || {}),
      tp_sl_enforcer: {
        allowed: true,
        alreadySet: false,
        computed: enforcement.computed,
        warningMessage: enforcement.warningMessage || null,
      },
    },
  };
}

function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function signalRowToEntryCandidate(row = {}) {
  const strategyRoute = parseJsonMaybe(row.strategy_route, null);
  const blockMeta = parseJsonMaybe(row.block_meta, {});
  return {
    symbol: row.symbol,
    action: ACTIONS.BUY,
    amount_usdt: Number(row.amount_usdt || 0),
    confidence: Number(row.confidence || 0),
    reasoning: `entry_trigger_signal_refresh(${row.id}) | ${row.reasoning || ''}`.slice(0, 220),
    exchange: row.exchange || 'binance',
    strategy_family: row.strategy_family || strategyRoute?.selectedFamily || null,
    strategy_route: strategyRoute,
    setup_type: strategyRoute?.setupType || row.strategy_family || null,
    entry_price: blockMeta?.entry_price ?? blockMeta?.entryPrice ?? null,
    atr: blockMeta?.atr ?? blockMeta?.atr_value ?? null,
    tp_sl_set: blockMeta?.tp_sl_set === true || blockMeta?.tpSlSet === true,
    sl_price: blockMeta?.sl_price ?? blockMeta?.stop_loss ?? null,
    tp_price: blockMeta?.tp_price ?? blockMeta?.take_profit ?? null,
    triggerHints: {
      ...(blockMeta?.entryTrigger?.hints || {}),
      discoveryScore: Number(row.confidence || 0),
    },
    block_meta: {
      ...blockMeta,
      entryTriggerSignalRefresh: {
        signalId: row.id,
        signalCreatedAt: row.created_at || null,
        source: 'recent_buy_signal',
      },
    },
  };
}

export function evaluateEntryTriggerLiveRiskGate({ candidate = {}, trigger = null, context = {}, flags = null } = {}) {
  const runtimeFlags = flags || getLunaIntelligentDiscoveryFlags();
  const gate = runtimeFlags.entryTrigger || {};
  if (!runtimeFlags.shouldAllowLiveEntryFire() || gate.liveRiskGateEnabled === false) {
    return { ok: true, reason: 'not_required' };
  }

  const confidence = finiteNumber(candidate?.confidence ?? trigger?.confidence, 0);
  const predictiveScore = finiteNumber(candidate?.predictiveScore ?? trigger?.predictive_score, 0);
  const amountUsdt = finiteNumber(candidate?.amount_usdt ?? candidate?.amountUsdt ?? context?.defaultAmountUsdt, 0);
  const capitalSnapshot = resolveCapitalSnapshot(candidate, context);
  const capitalCheck = resolveCapitalCheck(candidate, context);
  const minLiveConfidence = finiteNumber(gate.minLiveConfidence, 0.68);
  const minPredictiveScore = finiteNumber(gate.minLivePredictiveScore, 0);
  const minLiveAmountUsdt = finiteNumber(gate.minLiveAmountUsdt, 0);

  if (confidence < minLiveConfidence) {
    return {
      ok: false,
      reason: 'live_confidence_below_min',
      details: { confidence, minLiveConfidence },
    };
  }

  if (gate.requirePredictiveScore && predictiveScore <= 0) {
    return {
      ok: false,
      reason: 'predictive_score_missing',
      details: { minPredictiveScore },
    };
  }

  if (minPredictiveScore > 0 && predictiveScore > 0 && predictiveScore < minPredictiveScore) {
    return {
      ok: false,
      reason: 'predictive_score_below_min',
      details: { predictiveScore, minPredictiveScore },
    };
  }

  if (runtimeFlags.phases.predictiveValidationEnabled && runtimeFlags.predictive?.mode === 'hard_gate') {
    const evidence = buildPredictiveValidationEvidence(candidate, context, runtimeFlags.predictive);
    if (runtimeFlags.predictive?.requireComponents && Object.keys(evidence.components || {}).length === 0) {
      return {
        ok: false,
        reason: 'predictive_components_missing',
        details: evidence,
      };
    }
    if (evidence.blocked) {
      return {
        ok: false,
        reason: `predictive_validation_${evidence.decision}`,
        details: evidence,
      };
    }
  }

  if (minLiveAmountUsdt > 0 && amountUsdt > 0 && amountUsdt < minLiveAmountUsdt) {
    return {
      ok: false,
      reason: 'live_amount_below_min',
      details: { amountUsdt, minLiveAmountUsdt },
    };
  }

  if (capitalCheck && capitalCheck.result && !['accepted', 'reduced'].includes(String(capitalCheck.result))) {
    return {
      ok: false,
      reason: 'capital_check_not_accepted',
      details: { result: capitalCheck.result, reason: capitalCheck.reason || null },
    };
  }

  if (gate.requireLiveRiskContext && !capitalSnapshot && !capitalCheck) {
    return {
      ok: false,
      reason: 'risk_context_missing',
      details: { requireLiveRiskContext: true },
    };
  }

  if (gate.requireCapitalActive && capitalSnapshot) {
    if (capitalSnapshot.balanceStatus && capitalSnapshot.balanceStatus !== 'ok') {
      return {
        ok: false,
        reason: 'balance_status_not_ok',
        details: { balanceStatus: capitalSnapshot.balanceStatus },
      };
    }
    if (capitalSnapshot.mode && capitalSnapshot.mode !== 'ACTIVE_DISCOVERY') {
      return {
        ok: false,
        reason: 'capital_mode_not_active',
        details: { mode: capitalSnapshot.mode, reasonCode: capitalSnapshot.reasonCode || null },
      };
    }
    if (Number.isFinite(Number(capitalSnapshot.remainingSlots)) && Number(capitalSnapshot.remainingSlots) <= 0) {
      return {
        ok: false,
        reason: 'no_remaining_position_slots',
        details: { remainingSlots: Number(capitalSnapshot.remainingSlots) },
      };
    }
    const buyableAmount = finiteNumber(capitalSnapshot.buyableAmount, 0);
    const minOrderAmount = finiteNumber(capitalSnapshot.minOrderAmount, 0);
    const requiredAmount = Math.max(minOrderAmount, minLiveAmountUsdt, amountUsdt > 0 ? Math.min(amountUsdt, minOrderAmount || amountUsdt) : 0);
    if (requiredAmount > 0 && buyableAmount < requiredAmount) {
      return {
        ok: false,
        reason: 'buyable_amount_below_required',
        details: { buyableAmount, requiredAmount, minOrderAmount },
      };
    }
  }

  return {
    ok: true,
    reason: 'live_risk_gate_passed',
    details: {
      confidence,
      predictiveScore,
      amountUsdt,
      capitalMode: capitalSnapshot?.mode || null,
      capitalCheckResult: capitalCheck?.result || null,
    },
  };
}

export async function evaluateEntryTriggers(candidates = [], context = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  const posttradeCfg = getPosttradeFeedbackRuntimeConfig();
  const constitutionalEnabled = posttradeCfg?.constitutional_feedback?.enabled === true;
  if (!flags.phases.entryTriggerEnabled) {
    return { decisions: candidates, stats: { enabled: false, armed: 0, fired: 0, blocked: 0 } };
  }

  await ensureLunaDiscoveryEntryTables();
  await expireEntryTriggers().catch(() => 0);

  const exchange = String(context.exchange || 'binance');
  const ttlMinutes = Number(flags.entryTrigger.ttlMinutes || 180);
  const minConfidence = Number(flags.entryTrigger.minConfidence || 0.48);
  const fireCooldownMinutes = Number(flags.entryTrigger.fireCooldownMinutes || 10);
  const allowLiveFire = flags.shouldAllowLiveEntryFire();
  const shouldMutate = flags.shouldEntryTriggerMutate();
  const activeMap = new Map();
  const existing = await listActiveEntryTriggers({ exchange, limit: 1000 }).catch(() => []);
  for (const row of existing) {
    activeMap.set(`${row.symbol}:${row.trigger_type}`, row);
  }

  const output = [];
  let armed = 0;
  let fired = 0;
  let blocked = 0;
  let observed = 0;

  for (const candidate of candidates) {
    if (candidate?.action !== ACTIONS.BUY) {
      output.push(candidate);
      continue;
    }

    const rawConfidence = Number(candidate?.confidence || 0);
    const market = String(candidate?.market || context?.market || (exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto'));
    const regime = String(candidate?.regime || candidate?.market_regime || context?.regime || '').trim();
    const reflexionGuard = await checkAvoidPatterns(
      String(candidate?.symbol || ''),
      market,
      'long',
      regime,
    ).catch(() => ({ matched: false, penalty: 0, reason: '' }));
    const reflexionMatched = reflexionGuard?.matched === true && Number(reflexionGuard?.penalty || 0) > 0;
    const reflexionMatchMeta = reflexionMatched ? {
      matched: true,
      penalty: Number(reflexionGuard?.penalty || 0),
      reason: reflexionGuard?.reason || 'reflexion_match',
      source: 'reflexion-engine',
    } : null;
    const confidence = Math.max(0, rawConfidence - Number(reflexionGuard?.penalty || 0));
    const triggerType = resolveTriggerType(candidate);
    if (!isAllowedTriggerType(triggerType, flags)) {
      blocked++;
      const meta = {
        triggerType,
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'trigger_type_disabled',
        mode: flags.mode,
      };
      output.push(shouldMutate ? {
        ...candidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: trigger_type_disabled(${triggerType}) | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(candidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: meta,
        },
      } : annotateEntryTrigger(candidate, meta));
      continue;
    }
    const key = `${candidate.symbol}:${triggerType}`;
    const existingTrigger = activeMap.get(key) || null;
    const fireNow = shouldFireTrigger(candidate, context);
    const baseMeta = {
      setupType: candidate?.setup_type || candidate?.strategy_route?.setupType || null,
      confidence,
      source: 'entry_trigger_engine',
      evaluatedAt: nowIso(),
      hints: candidate?.triggerHints || {},
    };

    const tpSlEnforcement = enforceTpSlRequirement(resolveCandidateTpSlInput(candidate, context, market));
    const candidateWithTpSl = applyComputedTpSl(candidate, tpSlEnforcement);
    if (!tpSlEnforcement.allowed) {
      blocked++;
      const tpSlMeta = {
        triggerType,
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'tp_sl_required_not_met',
        blockReason: tpSlEnforcement.blockReason,
        mode: flags.mode,
      };
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(candidateWithTpSl, tpSlMeta));
        continue;
      }
      output.push({
        ...candidateWithTpSl,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: ${tpSlEnforcement.blockReason || 'tp_sl_required_not_met'} | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(candidateWithTpSl.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: tpSlMeta,
        },
      });
      continue;
    }

    const constitutionAudit = constitutionalEnabled
      ? evaluateLunaConstitutionForEntry(candidateWithTpSl, { ...context, market, exchange })
      : { blocked: false, violations: [], violationCount: 0 };
    const constitutionBlocked = candidateWithTpSl?.block_meta?.constitution?.blocked === true
      || (constitutionAudit?.blocked === true && posttradeCfg?.constitutional_feedback?.hard_gate === true);
    const candidateWithConstitution = constitutionalEnabled ? {
      ...candidateWithTpSl,
      block_meta: {
        ...(candidateWithTpSl.block_meta || {}),
        constitution: {
          ...(candidateWithTpSl.block_meta?.constitution || {}),
          ok: constitutionAudit.ok,
          blocked: constitutionBlocked,
          violations: constitutionAudit.violations || [],
          violationCount: constitutionAudit.violationCount || 0,
          hardGate: posttradeCfg?.constitutional_feedback?.hard_gate === true,
        },
      },
    } : candidateWithTpSl;

    if (constitutionalEnabled && constitutionBlocked) {
      blocked++;
      const constitutionMeta = {
        triggerType,
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'constitution_blocked',
        confidence,
        mode: flags.mode,
        violations: constitutionAudit?.violations || candidate?.block_meta?.constitution?.violations || [],
      };
      output.push(shouldMutate ? {
        ...candidateWithConstitution,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: constitution_blocked | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(candidateWithConstitution.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: constitutionMeta,
        },
      } : annotateEntryTrigger(candidateWithConstitution, constitutionMeta));
      continue;
    }
    const activeCandidate = candidateWithConstitution;
    const matureHold = await isMaturePosition(String(activeCandidate?.symbol || ''), exchange).catch(() => false);
    if (matureHold) {
      blocked++;
      const matureMeta = {
        triggerType,
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'mature_position_hold',
        mode: flags.mode,
      };
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, matureMeta));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: mature_position_hold | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: matureMeta,
        },
      });
      continue;
    }

    if (confidence < minConfidence) {
      blocked++;
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerType,
          state: 'observed',
          reason: 'low_confidence',
          confidence,
          minConfidence,
          mode: flags.mode,
        }));
        continue;
      }
      const blockedDecision = {
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: confidence ${confidence.toFixed(2)} < ${minConfidence.toFixed(2)} | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          ...(reflexionMatchMeta ? { reflexion_match: reflexionMatchMeta } : {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerType,
            state: 'blocked',
            reason: 'low_confidence',
            confidence,
            minConfidence,
            ...(reflexionMatchMeta ? { reflexion_match: reflexionMatchMeta } : {}),
          },
        },
      };
      output.push(blockedDecision);
      continue;
    }

    if (reflexionMatched && !shouldMutate) {
      observed++;
      output.push(annotateEntryTrigger(activeCandidate, {
        triggerType,
        state: 'observed',
        reason: 'reflexion_penalty_applied',
        confidenceBefore: rawConfidence,
        confidenceAfter: confidence,
        reflexionReason: reflexionGuard?.reason || '',
        reflexion_match: reflexionMatchMeta,
      }));
      continue;
    }

    const persisted = await insertEntryTrigger({
      symbol: activeCandidate.symbol,
      exchange,
      setupType: activeCandidate?.setup_type || activeCandidate?.strategy_route?.setupType || null,
      triggerType,
      triggerState: 'armed',
      confidence,
      waitingFor: triggerType,
      targetPrice: Number(activeCandidate?.target_price || activeCandidate?.entry_price || 0) || null,
      stopLoss: Number(activeCandidate?.sl_price || activeCandidate?.stop_loss || 0) || null,
      takeProfit: Number(activeCandidate?.tp_price || activeCandidate?.take_profit || 0) || null,
      triggerContext: baseMeta,
      triggerMeta: { phase: 'F-1', mode: flags.mode },
      predictiveScore: Number(candidate?.predictiveScore || 0) || null,
      expiresAt: plusMinutes(ttlMinutes),
    }).catch(() => null);

    if (!persisted) {
      blocked++;
      if (!shouldMutate) {
        observed++;
      output.push(annotateEntryTrigger(activeCandidate, {
          triggerType,
          state: 'observed',
          reason: 'persist_failed',
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: persist_failed | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: { triggerType, state: 'blocked', reason: 'persist_failed' },
        },
      });
      continue;
    }

    armed++;
    if (!fireNow) {
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerId: persisted.id,
          triggerType,
          state: 'armed',
          expiresAt: persisted.expires_at || null,
          observedOnly: true,
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_armed(${triggerType}) 대기 | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'armed',
            expiresAt: persisted.expires_at || null,
          },
        },
      });
      continue;
    }

    if (!allowLiveFire) {
      blocked++;
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerId: persisted.id,
          triggerType,
          state: 'ready',
          reason: 'mode_observe_only',
          observedOnly: true,
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_ready_but_mode_blocked(${flags.mode}) | ${activeCandidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'blocked',
            reason: 'mode_blocked',
            mode: flags.mode,
          },
        },
      });
      continue;
    }

    const tradingViewGuard = await evaluateTradingViewEntryGuard({ candidate: activeCandidate, exchange }).catch((error) => ({
      ok: false,
      blocked: true,
      enabled: true,
      reason: 'tradingview_guard_error',
      error: error?.message || String(error),
    }));
    if (tradingViewGuard?.blocked) {
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'tradingview_chart_guard_blocked',
          tradingViewReason: tradingViewGuard.reason || null,
          tradingViewGuard,
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: tradingview_chart_guard(${tradingViewGuard.reason || 'blocked'}) | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: 'tradingview_chart_guard_blocked',
            tradingViewReason: tradingViewGuard.reason || null,
          },
          tradingViewGuard,
        },
      });
      continue;
    }

    const riskGate = evaluateEntryTriggerLiveRiskGate({ candidate: activeCandidate, trigger: persisted, context, flags });
    if (!riskGate.ok) {
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'live_risk_gate_blocked',
          riskGateReason: riskGate.reason,
          riskGateDetails: riskGate.details || {},
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: ${riskGate.reason} | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: 'live_risk_gate_blocked',
            riskGateReason: riskGate.reason,
            riskGateDetails: riskGate.details || {},
          },
        },
      });
      continue;
    }

    const recentFired = await getRecentFiredEntryTrigger({
      symbol: candidate.symbol,
      exchange,
      triggerType,
      minutes: fireCooldownMinutes,
    }).catch(() => null);
    if (recentFired) {
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          duplicateFireCooldownMinutes: fireCooldownMinutes,
          recentFiredTriggerId: recentFired.id,
          reason: 'duplicate_fire_cooldown',
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: duplicate_fire_cooldown(${fireCooldownMinutes}m) | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: 'duplicate_fire_cooldown',
            recentFiredTriggerId: recentFired.id,
            cooldownMinutes: fireCooldownMinutes,
          },
        },
      });
      continue;
    }

    fired++;
    await updateEntryTriggerState(persisted.id, {
      triggerState: 'fired',
      firedAt: nowIso(),
      triggerMetaPatch: {
        firedBy: 'entry_trigger_engine',
        eventType: 'entry_trigger_fired',
      },
    }).catch(() => {});

    output.push({
      ...activeCandidate,
      block_meta: {
        ...(activeCandidate.block_meta || {}),
        event_type: 'autonomous_action_executed',
        entryTrigger: {
          triggerId: persisted.id,
          triggerType,
          state: 'fired',
          firedAt: nowIso(),
        },
      },
    });
  }

  return {
    decisions: output,
    stats: {
      enabled: true,
      armed,
      fired,
      blocked,
      observed,
      allowLiveFire,
      shouldMutate,
      mode: flags.mode,
    },
  };
}

export async function refreshEntryTriggersFromRecentBuySignals({
  exchange = 'binance',
  hours = 6,
  limit = 25,
  context = {},
} = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  if (!flags.phases.entryTriggerEnabled) {
    return { enabled: false, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  const refreshEnabled = String(process.env.LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  if (!refreshEnabled) {
    return { enabled: true, refreshEnabled: false, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  await ensureLunaDiscoveryEntryTables();
  const minConfidence = Number(flags.entryTrigger.minConfidence || 0.48);
  const rows = await dbQuery(
    `SELECT id, symbol, action, amount_usdt, confidence, reasoning, status, exchange,
            strategy_family, strategy_route, block_meta, created_at
       FROM signals
      WHERE exchange = $1
        AND action = 'BUY'
        AND created_at >= now() - ($2::int * INTERVAL '1 hour')
        AND COALESCE(exclude_from_learning, false) = false
        AND COALESCE(quality_flag, 'trusted') <> 'exclude_from_learning'
        AND COALESCE(status, 'pending') IN ('pending', 'approved', 'queued', 'retrying')
        AND COALESCE(confidence, 0) >= $3
      ORDER BY confidence DESC NULLS LAST, created_at DESC
      LIMIT $4`,
    [
      exchange,
      Math.max(1, Number(hours || 6)),
      minConfidence,
      Math.max(1, Number(limit || 25)),
    ],
  ).catch(() => []);

  const candidates = rows.map(signalRowToEntryCandidate).filter((item) => item.symbol);
  if (candidates.length === 0) {
    return { enabled: true, refreshEnabled: true, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  const result = await evaluateEntryTriggers(candidates, {
    ...context,
    exchange,
    signalRefresh: true,
  });
  return {
    enabled: true,
    refreshEnabled: true,
    refreshed: Number(result?.stats?.armed || 0),
    armed: Number(result?.stats?.armed || 0),
    fired: Number(result?.stats?.fired || 0),
    blocked: Number(result?.stats?.blocked || 0),
    observed: Number(result?.stats?.observed || 0),
    sourceSignals: candidates.length,
    mode: result?.stats?.mode || flags.mode,
  };
}

export async function evaluateActiveEntryTriggersAgainstMarketEvents(events = [], context = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  if (!flags.phases.entryTriggerEnabled) {
    return { enabled: false, fired: 0, readyBlocked: 0, checked: 0, results: [] };
  }
  await ensureLunaDiscoveryEntryTables();
  await expireEntryTriggers().catch(() => 0);

  const exchange = String(context.exchange || 'binance');
  const allowLiveFire = flags.shouldAllowLiveEntryFire();
  const fireCooldownMinutes = Number(flags.entryTrigger.fireCooldownMinutes || 10);
  const eventsBySymbol = new Map();
  for (const event of events || []) {
    const symbol = String(event?.symbol || '').trim();
    if (!symbol) continue;
    eventsBySymbol.set(symbol, event);
  }

  const active = await listActiveEntryTriggers({ exchange, limit: Number(context.limit || 1000) }).catch(() => []);
  const results = [];
  let fired = 0;
  let readyBlocked = 0;
  let checked = 0;

  for (const trigger of active || []) {
    const event = eventsBySymbol.get(String(trigger.symbol || ''));
    if (!event) continue;
    checked++;
    const candidate = {
      symbol: trigger.symbol,
      action: ACTIONS.BUY,
      confidence: Number(trigger.confidence || 0),
      setup_type: trigger.setup_type || null,
      triggerHints: {
        ...(trigger.trigger_context?.hints || {}),
        ...(event.triggerHints || {}),
        mtfAgreement: event.mtfAgreement ?? event.triggerHints?.mtfAgreement ?? trigger.trigger_context?.hints?.mtfAgreement,
        discoveryScore: event.discoveryScore ?? event.triggerHints?.discoveryScore ?? trigger.trigger_context?.hints?.discoveryScore,
        volumeBurst: event.volumeBurst ?? event.triggerHints?.volumeBurst ?? trigger.trigger_context?.hints?.volumeBurst,
        breakoutRetest: event.breakoutRetest ?? event.triggerHints?.breakoutRetest ?? trigger.trigger_context?.hints?.breakoutRetest,
        newsMomentum: event.newsMomentum ?? event.triggerHints?.newsMomentum ?? trigger.trigger_context?.hints?.newsMomentum,
      },
    };
    const fireNow = shouldFireTrigger(candidate, context);
    if (!fireNow) {
      results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: trigger.trigger_state, fired: false, reason: 'conditions_not_met' });
      continue;
    }
    if (!allowLiveFire) {
      readyBlocked++;
      await updateEntryTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          readyBlockedByMode: flags.mode,
        },
      }).catch(() => null);
      results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: 'waiting', fired: false, reason: 'mode_blocked', mode: flags.mode });
      continue;
    }
    const tradingViewGuard = await evaluateTradingViewEntryGuard({ candidate, event, exchange }).catch((error) => ({
      ok: false,
      blocked: true,
      enabled: true,
      reason: 'tradingview_guard_error',
      error: error?.message || String(error),
    }));
    if (tradingViewGuard?.blocked) {
      readyBlocked++;
      await updateEntryTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          reason: 'tradingview_chart_guard_blocked',
          tradingViewReason: tradingViewGuard.reason || null,
          tradingViewGuard,
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'tradingview_chart_guard_blocked',
        tradingViewReason: tradingViewGuard.reason || null,
      });
      continue;
    }
    const riskGate = evaluateEntryTriggerLiveRiskGate({ candidate, trigger, context, flags });
    if (!riskGate.ok) {
      readyBlocked++;
      await updateEntryTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'live_risk_gate_blocked',
          riskGateReason: riskGate.reason,
          riskGateDetails: riskGate.details || {},
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'live_risk_gate_blocked',
        riskGateReason: riskGate.reason,
      });
      continue;
    }
    const recentFired = await getRecentFiredEntryTrigger({
      symbol: trigger.symbol,
      exchange,
      triggerType: trigger.trigger_type,
      minutes: fireCooldownMinutes,
    }).catch(() => null);
    if (recentFired && recentFired.id !== trigger.id) {
      readyBlocked++;
      await updateEntryTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          duplicateFireCooldownMinutes: fireCooldownMinutes,
          recentFiredTriggerId: recentFired.id,
          reason: 'duplicate_fire_cooldown',
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'duplicate_fire_cooldown',
        recentFiredTriggerId: recentFired.id,
      });
      continue;
    }
    fired++;
    const updated = await updateEntryTriggerState(trigger.id, {
      triggerState: 'fired',
      firedAt: nowIso(),
      triggerMetaPatch: {
        firedBy: 'entry_trigger_event_worker',
        eventType: 'entry_trigger_fired',
        event,
      },
    }).catch(() => null);
    results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: updated?.trigger_state || 'fired', fired: true });
  }

  return {
    enabled: true,
    mode: flags.mode,
    allowLiveFire,
    checked,
    fired,
    readyBlocked,
    results,
  };
}

export default evaluateEntryTriggers;

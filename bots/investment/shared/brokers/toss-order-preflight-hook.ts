// @ts-nocheck

import { assertExecutable } from './broker-adapter.ts';
import { getBrokerAdapter } from './broker-router.ts';
import { getTossPromotionStage } from './promotion-stage.ts';

function normalizeSide(value = 'buy') {
  const raw = String(value || '').trim().toLowerCase();
  if (['sell', 'close', 'exit'].includes(raw)) return 'sell';
  return 'buy';
}

function marketForSymbol(symbol = '', fallback = 'domestic') {
  const raw = String(symbol || '').trim();
  if (/^[0-9]{6}$/.test(raw)) return 'domestic';
  return fallback === 'overseas' ? 'overseas' : 'domestic';
}

function checkOk(value) {
  if (!value) return false;
  if (value.skipped === true) return false;
  if (value.raw?.skipped === true) return false;
  return true;
}

export async function evaluateTossOrderPreflightHook(candidate = {}, options = {}, deps = {}) {
  const adapter = deps.adapter || getBrokerAdapter('toss');
  const stage = (deps.getTossPromotionStage || getTossPromotionStage)(options.stageOptions || {}, deps);
  const symbol = String(candidate.symbol || options.symbol || '').trim().toUpperCase();
  const side = normalizeSide(candidate.side || candidate.action || options.side || 'buy');
  const market = marketForSymbol(symbol, candidate.market || options.market || 'domestic');
  const quantity = Number(candidate.quantity ?? candidate.qty ?? options.quantity ?? options.qty ?? 0);
  const advisoryOnly = !['s2_micro_live', 's3_scaled'].includes(stage.stage);

  if (!symbol) {
    return {
      ok: false,
      advisoryOnly: true,
      stage,
      symbol: null,
      side,
      checks: [],
      reason: 'symbol_required',
      placed: false,
      liveMutation: false,
    };
  }

  if (!advisoryOnly) {
    try {
      assertExecutable(adapter, { liveTrading: stage.liveTrading, promotionApproved: stage.approved });
    } catch (error) {
      return {
        ok: false,
        advisoryOnly: false,
        stage,
        symbol,
        side,
        checks: [],
        reason: error?.code || error?.message || 'broker_execution_disabled_shadow',
        placed: false,
        liveMutation: false,
      };
    }
  }

  const currency = market === 'overseas' ? 'USD' : 'KRW';
  const checks = [];
  async function readCheck(name, fn) {
    try {
      const result = await fn();
      checks.push({ name, ok: checkOk(result), result: result || null });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        skipped: true,
        reason: error?.message || String(error),
        result: null,
      });
    }
  }
  await readCheck('buying_power', () => (deps.getBuyingPower || adapter.getBuyingPower)?.({ market, currency }));
  await readCheck('sellable_quantity', () => (deps.getSellableQuantity || adapter.getSellableQuantity)?.(symbol, { market }));
  await readCheck('commissions', () => (deps.getCommissions || adapter.getCommissions)?.({ market }));

  return {
    ok: checks.every((item) => item.ok),
    advisoryOnly,
    stage,
    symbol,
    side,
    quantity,
    market,
    checks,
    placed: false,
    liveMutation: false,
    reason: checks.every((item) => item.ok) ? 'toss_preflight_read_checks_recorded' : 'toss_preflight_read_checks_incomplete',
  };
}

export default {
  evaluateTossOrderPreflightHook,
};

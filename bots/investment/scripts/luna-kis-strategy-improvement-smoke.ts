import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const INVESTMENT_ROOT = path.resolve(path.dirname(__filename), '..');

function readProject(relativePath: string): string {
  return fs.readFileSync(path.join(INVESTMENT_ROOT, relativePath), 'utf8');
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

const marketHoursGuard = readProject('shared/kis-market-hours-guard.ts');
const symbolPolicy = readProject('shared/kis-symbol-policy.ts');
const stockFlow = readProject('elixir/lib/luna/v2/agents/stock_flow.ex');
const positionWatch = readProject('elixir/lib/luna/v2/position_watch.ex');
const riskGovernor = readProject('elixir/lib/luna/v2/skill/risk_governor.ex');

assert.match(marketHoursGuard, /hour:\s*9,\s*allow:\s*false/);
assert.match(marketHoursGuard, /hour:\s*12,\s*allow:\s*true,\s*priority:\s*'high'/);
assert.match(marketHoursGuard, /hour:\s*13,\s*allow:\s*true,\s*priority:\s*'high'/);
assert.match(marketHoursGuard, /hour:\s*15,\s*allow:\s*false/);
assert.match(marketHoursGuard, /export function isKisAllowedTime/);
assert.match(marketHoursGuard, /export function evaluateKisTimeSlotPolicy/);

assert.equal(countMatches(symbolPolicy, /policy:\s*'whitelist'/g), 4);
assert.equal(countMatches(symbolPolicy, /policy:\s*'blacklist'/g), 6);
assert.ok(countMatches(symbolPolicy, /policy:\s*'avoid'/g) >= 5);
assert.match(symbolPolicy, /export function normalizeKisSymbol/);
assert.match(symbolPolicy, /export function isKisBlacklistedSymbol/);
assert.match(symbolPolicy, /export function evaluateKisSymbolPolicy/);

assert.match(stockFlow, /@kis_allowed_strategy_types\s+~w\[sma_crossover sma_pullback\]/);
assert.match(stockFlow, /def kis_strategy_shadow/);
assert.match(stockFlow, /normal_exit/);
assert.match(stockFlow, /strategy_exit/);
assert.match(stockFlow, /mutate:\s*false/);

assert.match(positionWatch, /@kis_max_hold_minutes\s+1440/);
assert.match(positionWatch, /def kis_max_hold_minutes/);
assert.match(positionWatch, /def kis_hold_time_shadow/);
assert.match(positionWatch, /:kis_max_hold_exceeded/);

assert.match(riskGovernor, /@kis_sl_pct\s+0\.02/);
assert.match(riskGovernor, /def kis_stop_loss_pct/);
assert.match(riskGovernor, /def kis_stop_loss_shadow/);
assert.doesNotMatch(riskGovernor, /symbol\s*=\s*'#\{symbol\}'/);
assert.doesNotMatch(riskGovernor, /exchange\s*=\s*'#\{exchange\}'/);

const result = {
  smoke: 'luna-kis-strategy-improvement',
  ok: true,
  strategies: {
    A_timeSlot: '09/15 blocked, 12/13 preferred, shadow helper exported',
    B_symbolPolicy: '4 whitelist, 6 blacklist, 5+ avoid, normalized lookup',
    C_smaStrategy: 'SMA-only shadow contract with strategy_exit normalization',
    D_holdTime: 'KIS max hold 1440 minutes with shadow attention',
    E_stopLoss: 'KIS absolute -2% shadow stop loss with parameterized SQL guard',
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('✅ luna kis strategy improvement smoke passed');
}

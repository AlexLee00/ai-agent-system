#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildKoreaDataPromotionGate } from '../shared/korea-data-promotion-gate.ts';
import { KOREA_DATA_SHADOW_SIGNAL_CONFIRM } from '../shared/korea-data-shadow-signal-ledger.ts';
import { runLunaDisclosureEventDriven } from './runtime-luna-disclosure-event-driven.ts';
import { runLunaEarningsSurpriseTrading } from './runtime-luna-earnings-surprise-trading.ts';
import { runLunaFundamentalQuantTrading } from './runtime-luna-fundamental-quant-trading.ts';
import { runLunaKoreaDataPromotionGate } from './runtime-luna-korea-data-promotion-gate.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function runLunaKoreaDataPromotionGateSmoke() {
  const ready = buildKoreaDataPromotionGate({
    openDartConfigured: true,
    dartFssAvailable: true,
    corpFinancialReports: 1200,
    corpFundamentals: 240,
    freshCorpFundamentals24h: 220,
    disclosuresToday: 120,
    koreanFactorRows7d: 1400,
    domesticBacktestRows7d: 30,
    domesticBacktestFreshRows7d: 28,
    domesticBacktestHealthyRows7d: 24,
    domesticBacktestPassRows7d: 22,
    shadowObservationDays: 8,
    strategyShadowSignals7d: 18,
    worldquantAlphaCount: 20,
  });
  assert.equal(ready.promotionReady, true);
  assert.equal(ready.promotionAllowed, false);
  assert.equal(ready.liveOrderAllowed, false);
  assert.equal(ready.explicitMasterApprovalRequired, true);
  assert.equal(ready.stages.stage1.ready, true);
  assert.equal(ready.stages.stage2.ready, true);
  assert.equal(ready.stages.stage3.ready, true);

  const blocked = buildKoreaDataPromotionGate({
    openDartConfigured: true,
    dartFssAvailable: false,
    corpFinancialReports: 100,
    corpFundamentals: 30,
    freshCorpFundamentals24h: 12,
    disclosuresToday: 5,
    koreanFactorRows7d: 10,
    domesticBacktestRows7d: 2,
    domesticBacktestFreshRows7d: 1,
    domesticBacktestHealthyRows7d: 1,
    domesticBacktestPassRows7d: 0,
    shadowObservationDays: 1,
    strategyShadowSignals7d: 2,
    worldquantAlphaCount: 12,
  });
  assert.equal(blocked.promotionReady, false);
  assert.ok(blocked.blockers.some((item) => item.code === 'financial_report_rows_below_target'));
  assert.ok(blocked.blockers.some((item) => item.code === 'domestic_backtest_pass_rate_below_target'));
  assert.ok(blocked.blockers.some((item) => item.code === 'shadow_observation_days_below_target'));
  assert.ok(blocked.warnings.some((item) => item.code === 'dart_fss_python_adapter_missing'));

  const runtime = await runLunaKoreaDataPromotionGate({ fixture: true, writeReport: false });
  assert.equal(runtime.fixture, true);
  assert.equal(runtime.promotionReady, true);
  assert.equal(runtime.writeMode, 'no-write');

  const writes = [];
  const runFn = async (sql, params = []) => {
    writes.push({ sql, params });
    return null;
  };
  const fundamental = await runLunaFundamentalQuantTrading({
    fixture: true,
    apply: true,
    confirm: KOREA_DATA_SHADOW_SIGNAL_CONFIRM.fundamentalQuant,
    run: runFn,
    writeReport: false,
  });
  const earnings = await runLunaEarningsSurpriseTrading({
    fixture: true,
    apply: true,
    confirm: KOREA_DATA_SHADOW_SIGNAL_CONFIRM.earningsSurprise,
    run: runFn,
    writeReport: false,
  });
  const disclosure = await runLunaDisclosureEventDriven({
    fixture: true,
    apply: true,
    confirm: KOREA_DATA_SHADOW_SIGNAL_CONFIRM.disclosureEvent,
    run: runFn,
    writeReport: false,
  });
  assert.equal(fundamental.shadowSignalLedger.writeApplied, true);
  assert.equal(earnings.shadowSignalLedger.writeApplied, true);
  assert.equal(disclosure.shadowSignalLedger.writeApplied, true);
  assert.equal(fundamental.shadowSignalLedger.total >= 1, true);
  assert.equal(earnings.shadowSignalLedger.total, 1);
  assert.equal(disclosure.shadowSignalLedger.total, 1);
  assert.ok(writes.some((item) => /korea_public_data_shadow_signals/u.test(item.sql)));

  return {
    ok: true,
    smoke: 'luna-korea-data-promotion-gate',
    readyStatus: ready.status,
    blockedCount: blocked.blockers.length,
    warningCount: blocked.warnings.length,
    runtimeStatus: runtime.status,
    shadowLedgerWrites: writes.filter((item) => /INSERT INTO investment\.korea_public_data_shadow_signals/u.test(item.sql)).length,
    shadowOnly: true,
    liveOrderAllowed: false,
  };
}

async function main() {
  const result = await runLunaKoreaDataPromotionGateSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-korea-data-promotion-gate-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-korea-data-promotion-gate-smoke error:' });
}

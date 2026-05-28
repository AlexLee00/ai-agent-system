#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createDisclosureEventDrivenHandler } from '../a2a/skills/disclosure-event-driven.ts';
import {
  KOREA_DATA_SHADOW_SIGNAL_CONFIRM,
  ensureKoreaDataShadowSignalSchema,
  extractKoreaDataShadowSignals,
  insertKoreaDataShadowSignals,
  summarizeKoreaDataShadowSignals,
} from '../shared/korea-data-shadow-signal-ledger.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-disclosure-event-shadow.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runLunaDisclosureEventDriven(options = {}) {
  const apply = options.apply === true;
  if (apply && options.confirm !== KOREA_DATA_SHADOW_SIGNAL_CONFIRM.disclosureEvent) {
    throw new Error(`runtime:luna-disclosure-event-driven apply requires --confirm=${KOREA_DATA_SHADOW_SIGNAL_CONFIRM.disclosureEvent}`);
  }
  const handler = createDisclosureEventDrivenHandler();
  const result = await handler({
    symbol: options.symbol,
    limit: options.limit || 50,
    disclosure: options.fixture ? {
      corp_code: '00126380',
      corp_name: '삼성전자',
      stock_code: '005930',
      report_nm: '자기주식취득결정',
      rcept_no: '20260523000004',
      rcept_dt: '20260523',
    } : null,
  });
  const signals = extractKoreaDataShadowSignals('disclosure-event-driven', result);
  let writtenSignals = [];
  if (apply) {
    await ensureKoreaDataShadowSignalSchema(options.run || undefined);
    writtenSignals = await insertKoreaDataShadowSignals(signals, options.run || undefined);
  }
  const ledgerSignals = apply ? writtenSignals : signals;
  const payload = {
    ok: result.status === 'completed',
    status: 'luna_disclosure_event_shadow_ready',
    dryRun: !apply,
    shadowOnly: true,
    liveOrderAllowed: false,
    shadowSignalLedger: {
      writeApplied: apply,
      writeMode: apply ? 'shadow-signal-ledger-apply' : 'plan-only',
      plannedTotal: signals.length,
      insertedTotal: apply ? writtenSignals.length : null,
      skippedDuplicateTotal: apply ? Math.max(0, signals.length - writtenSignals.length) : 0,
      ...summarizeKoreaDataShadowSignals(ledgerSignals),
    },
    result,
  };
  if (options.writeReport !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function main() {
  const result = await runLunaDisclosureEventDriven({
    symbol: argValue('symbol', null),
    limit: Number(argValue('limit', 50)),
    fixture: hasFlag('fixture'),
    apply: hasFlag('apply') && !hasFlag('dry-run'),
    confirm: argValue('confirm', ''),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-disclosure-event-driven] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-disclosure-event-driven error:' });
}

#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createFundamentalQuantTradingHandler } from '../a2a/skills/fundamental-quant-trading.ts';
import {
  KOREA_DATA_SHADOW_SIGNAL_CONFIRM,
  ensureKoreaDataShadowSignalSchema,
  extractKoreaDataShadowSignals,
  insertKoreaDataShadowSignals,
  summarizeKoreaDataShadowSignals,
} from '../shared/korea-data-shadow-signal-ledger.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-fundamental-quant-shadow.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runLunaFundamentalQuantTrading(options = {}) {
  const apply = options.apply === true;
  if (apply && options.confirm !== KOREA_DATA_SHADOW_SIGNAL_CONFIRM.fundamentalQuant) {
    throw new Error(`runtime:luna-fundamental-quant-trading apply requires --confirm=${KOREA_DATA_SHADOW_SIGNAL_CONFIRM.fundamentalQuant}`);
  }
  const handler = createFundamentalQuantTradingHandler();
  const result = await handler({
    symbol: options.symbol,
    limit: options.limit || 50,
    fundamental: options.fixture ? {
      stockCode: '005930',
      companyName: '삼성전자',
      per: 9.2,
      pbr: 1.1,
      roe: 0.18,
      roa: 0.08,
      debtRatio: 0.35,
      currentRatio: 1.9,
      revenueGrowth: 0.11,
    } : null,
  });
  const signals = extractKoreaDataShadowSignals('fundamental-quant-trading', result);
  let writtenSignals = [];
  if (apply) {
    await ensureKoreaDataShadowSignalSchema(options.run || undefined);
    writtenSignals = await insertKoreaDataShadowSignals(signals, options.run || undefined);
  }
  const ledgerSignals = apply ? writtenSignals : signals;
  const payload = {
    ok: result.status === 'completed',
    status: 'luna_fundamental_quant_shadow_ready',
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
  const result = await runLunaFundamentalQuantTrading({
    symbol: argValue('symbol', null),
    limit: Number(argValue('limit', 50)),
    fixture: hasFlag('fixture'),
    apply: hasFlag('apply') && !hasFlag('dry-run'),
    confirm: argValue('confirm', ''),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-fundamental-quant-trading] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-fundamental-quant-trading error:' });
}

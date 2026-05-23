#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createEarningsSurpriseTradingHandler } from '../a2a/skills/earnings-surprise-trading.ts';
import {
  KOREA_DATA_SHADOW_SIGNAL_CONFIRM,
  ensureKoreaDataShadowSignalSchema,
  extractKoreaDataShadowSignals,
  insertKoreaDataShadowSignals,
  summarizeKoreaDataShadowSignals,
} from '../shared/korea-data-shadow-signal-ledger.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-earnings-surprise-shadow.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runLunaEarningsSurpriseTrading(options = {}) {
  const apply = options.apply === true;
  if (apply && options.confirm !== KOREA_DATA_SHADOW_SIGNAL_CONFIRM.earningsSurprise) {
    throw new Error(`runtime:luna-earnings-surprise-trading apply requires --confirm=${KOREA_DATA_SHADOW_SIGNAL_CONFIRM.earningsSurprise}`);
  }
  const handler = createEarningsSurpriseTradingHandler();
  const result = await handler({
    symbol: options.symbol,
    limit: options.limit || 50,
    current: options.fixture ? {
      stockCode: '005930',
      companyName: '삼성전자',
      bsnsYear: '2024',
      reprtCode: '11011',
      revenue: 300870903000000,
      operatingIncome: 32726076000000,
    } : null,
    previous: options.fixture ? {
      stockCode: '005930',
      companyName: '삼성전자',
      bsnsYear: '2023',
      reprtCode: '11011',
      revenue: 258935494000000,
      operatingIncome: 6566976000000,
    } : null,
  });
  const signals = extractKoreaDataShadowSignals('earnings-surprise-trading', result);
  if (apply) {
    await ensureKoreaDataShadowSignalSchema(options.run || undefined);
    await insertKoreaDataShadowSignals(signals, options.run || undefined);
  }
  const payload = {
    ok: result.status === 'completed',
    status: 'luna_earnings_surprise_shadow_ready',
    dryRun: !apply,
    shadowOnly: true,
    liveOrderAllowed: false,
    shadowSignalLedger: {
      writeApplied: apply,
      writeMode: apply ? 'shadow-signal-ledger-apply' : 'plan-only',
      ...summarizeKoreaDataShadowSignals(signals),
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
  const result = await runLunaEarningsSurpriseTrading({
    symbol: argValue('symbol', null),
    limit: Number(argValue('limit', 50)),
    fixture: hasFlag('fixture'),
    apply: hasFlag('apply') && !hasFlag('dry-run'),
    confirm: argValue('confirm', ''),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-earnings-surprise-trading] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-earnings-surprise-trading error:' });
}

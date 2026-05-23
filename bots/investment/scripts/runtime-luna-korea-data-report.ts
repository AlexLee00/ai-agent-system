#!/usr/bin/env node
// @ts-nocheck

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveOpenDartCredentialStatus } from '../lib/korea-data/opendart-client.ts';
import { runLunaKoreaDataPromotionGate } from './runtime-luna-korea-data-promotion-gate.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-korea-data-report.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function safeCount(sql) {
  const row = await get(sql).catch((error) => ({ error: String(error?.message || error) }));
  if (row?.error) {
    return {
      count: null,
      error: row.error,
      tableMissing: /does not exist|relation .* does not exist/i.test(row.error),
    };
  }
  return { count: Number(row?.count || 0), error: null, tableMissing: false };
}

function fileStatus(file) {
  return existsSync(resolve(INVESTMENT_ROOT, file));
}

export async function runLunaKoreaDataReport(options = {}) {
  const secretStatus = await resolveOpenDartCredentialStatus({ timeoutMs: 3000 });
  const promotionGate = await runLunaKoreaDataPromotionGate({ writeReport: false }).catch((error) => ({
    ok: false,
    status: 'luna_korea_data_promotion_gate_unavailable',
    promotionReady: false,
    blockers: [{ code: 'promotion_gate_unavailable', detail: String(error?.message || error) }],
    warnings: [],
  }));
  const counts = {
    corpFundamentals: await safeCount('SELECT COUNT(*)::int AS count FROM investment.corp_fundamentals'),
    corpDisclosuresToday: await safeCount('SELECT COUNT(*)::int AS count FROM investment.corp_disclosures WHERE rcept_dt = CURRENT_DATE'),
    corpFinancialReports: await safeCount('SELECT COUNT(*)::int AS count FROM investment.corp_financial_reports'),
    koreanFactorLog: await safeCount('SELECT COUNT(*)::int AS count FROM investment.korean_factor_log'),
  };
  const files = {
    opendartClient: fileStatus('lib/korea-data/opendart-client.ts'),
    dartFssAdapter: fileStatus('python/korea-data/opendart_client.py'),
    corpFundamental: fileStatus('lib/korea-data/corp-fundamental.ts'),
    koreanFactorModel: fileStatus('shared/korean-factor-model.ts'),
    worldquantKorean: fileStatus('shared/worldquant-101-korean.ts'),
    disclosureLaunchd: fileStatus('launchd/ai.luna.opendart-disclosure-refresh.plist'),
    financialLaunchd: fileStatus('launchd/ai.luna.opendart-financial-refresh.plist'),
    earningsSurpriseLaunchd: fileStatus('launchd/ai.luna.earnings-surprise-trading.plist'),
  };
  const report = {
    ok: true,
    status: 'luna_korea_public_data_shadow_ready',
    generatedAt: new Date().toISOString(),
    shadowOnly: true,
    liveTradeImpact: false,
    openDart: {
      configured: secretStatus.configured,
      apiKeySource: secretStatus.apiKeySource,
      valueRedacted: true,
      baseUrl: secretStatus.baseUrl,
    },
    files,
    counts,
    stages: {
      stage1: {
        status: Object.values(files).slice(0, 3).every(Boolean)
          ? (Object.values(counts).some((item) => item.tableMissing) ? 'implemented_pending_schema_apply' : 'implemented')
          : 'partial',
        blockers: secretStatus.configured ? [] : ['opendart_api_key_missing_for_network_smoke'],
        pending: Object.values(counts).some((item) => item.tableMissing) ? ['run --write once to create Korea public data tables'] : [],
      },
      stage2: {
        status: 'shadow_scaffold_implemented',
        liveTradingEnabled: false,
      },
      stage3: {
        status: promotionGate.promotionReady
          ? 'promotion_ready_pending_master_approval'
          : 'promotion_pending_shadow_evidence',
        promotionRequired: true,
        blockers: promotionGate.blockers || [],
        warnings: promotionGate.warnings || [],
      },
    },
    promotionGate,
    nextChecks: [
      'npm --prefix bots/investment run -s smoke:luna-korea-data',
      'npm --prefix bots/investment run -s secrets-doctor:luna-opendart -- --template',
      'npm --prefix bots/investment run -s runtime:luna-opendart-disclosure-refresh -- --json --fixture',
      'npm --prefix bots/investment run -s runtime:luna-opendart-financial-refresh -- --json --fixture',
      'npm --prefix bots/investment run -s runtime:luna-earnings-surprise-trading -- --json --fixture --no-write',
      'npm --prefix bots/investment run -s runtime:luna-korea-data-promotion-gate -- --json --no-write',
    ],
  };
  if (options.write !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(report, null, 2));
  }
  return report;
}

async function main() {
  const result = await runLunaKoreaDataReport({
    output: argValue('output', DEFAULT_OUTPUT),
    write: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-korea-data-report] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-korea-data-report error:' });
}

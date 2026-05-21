#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveDomesticOfficialReferenceCredentialStatus } from '../shared/domestic-official-reference.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function field(fieldName: string, present: boolean, source: string | null) {
  return {
    field: fieldName,
    present,
    source,
    valueRedacted: true,
  };
}

export async function runLunaOfficialMarketReferenceSecretsDoctor(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 3000);
  const status = await resolveDomesticOfficialReferenceCredentialStatus({ timeoutMs });
  const required = [
    field('official_market_reference.krx_openapi_auth_key', status.krxConfigured, status.krxAuthKeySource),
    field('official_market_reference.data_go_kr_stock_price_service_key', status.stockPriceConfigured, status.stockPriceServiceKeySource),
    field('official_market_reference.data_go_kr_krx_listed_info_service_key', status.krxListedInfoConfigured, status.krxListedInfoServiceKeySource),
    field('official_market_reference.data_go_kr_corporate_finance_service_key', status.corporateFinanceConfigured, status.corporateFinanceServiceKeySource),
  ];
  const ready = required.every((item) => item.present);
  return {
    ok: true,
    ready,
    status: ready ? 'official_market_reference_secrets_ready' : 'official_market_reference_secrets_missing',
    valuesRedacted: true,
    required,
    acceptedFallbacks: {
      krx: [
        'krx.auth_key',
        'krx.openapi_auth_key',
        'official_market_reference.krx.auth_key',
      ],
      dataGoKr: [
        'official_market_reference.data_go_kr_stock_price_service_key',
        'official_market_reference.data_go_kr_krx_listed_info_service_key',
        'official_market_reference.data_go_kr.stock_price_service_key',
        'official_market_reference.data_go_kr.krx_listed_info_service_key',
      ],
      corporateFinance: [
        'official_market_reference.corporate_finance_service_key',
        'official_market_reference.company_finance_service_key',
        'official_market_reference.data_go_kr.corporate_finance_service_key',
        'data_go_kr.corporate_finance_service_key',
        'public_data.corporate_finance_service_key',
      ],
    },
    template: options.template
      ? {
          official_market_reference: {
            krx_openapi_auth_key: '<KRX_OPEN_API_KEY>',
            data_go_kr_stock_price_service_key: '<DATA_GO_KR_FINANCIAL_STOCK_PRICE_SERVICE_KEY>',
            data_go_kr_krx_listed_info_service_key: '<DATA_GO_KR_KRX_LISTED_INFO_SERVICE_KEY>',
            data_go_kr_corporate_finance_service_key: '<DATA_GO_KR_CORPORATE_FINANCE_SERVICE_KEY>',
          },
        }
      : undefined,
    nextCommands: [
      'npm --prefix bots/investment run -s secrets-doctor:luna-official-market-reference',
      'npm --prefix bots/investment run -s runtime:luna-domestic-official-reference -- --network --refresh --write-cache',
    ],
  };
}

async function main() {
  const result = await runLunaOfficialMarketReferenceSecretsDoctor({
    timeoutMs: Number(argValue('timeout-ms', process.env.LUNA_OFFICIAL_MARKET_REFERENCE_SECRET_TIMEOUT_MS || 3000)),
    template: hasFlag('template'),
  });
  if (hasFlag('strict') && !result.ready) {
    process.exitCode = 1;
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    const missing = result.required.filter((item) => !item.present).map((item) => item.field);
    console.log(`[luna-official-market-reference-secrets-doctor] ${result.status}${missing.length ? ` missing=${missing.join(',')}` : ''}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna-official-market-reference-secrets-doctor error:',
  });
}

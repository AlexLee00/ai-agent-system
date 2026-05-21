#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  annotateDomesticOfficialReferenceCandidates,
  buildFixtureDomesticOfficialReference,
  evaluateDomesticOfficialReferenceGate,
  resolveDomesticOfficialReferenceCredentialStatus,
} from '../shared/domestic-official-reference.ts';
import { runLunaDomesticOfficialReference } from './runtime-luna-domestic-official-reference.ts';

const require = createRequire(import.meta.url);
const hubClient = require('../../../packages/core/lib/hub-client');

export async function runLunaDomesticOfficialReferenceSmoke() {
  const originalFetchHubSecrets = hubClient.fetchHubSecrets;
  const categories = [];
  try {
    delete process.env.LUNA_OFFICIAL_MARKET_REFERENCE_DIRECT_SECRET_CATEGORY;
    hubClient.fetchHubSecrets = async (category) => {
      categories.push(category);
      if (category !== 'official_market_reference') return {};
      return {
        krx_openapi_auth_key: 'fixture-krx-key',
        data_go_kr_stock_price_service_key: 'fixture-stock-key',
        data_go_kr_corporate_finance_service_key: 'fixture-corporate-key',
      };
    };
    const credentialStatus = await resolveDomesticOfficialReferenceCredentialStatus({ timeoutMs: 1000 });
    assert.equal(credentialStatus.krxConfigured, true);
    assert.equal(credentialStatus.krxAuthKeySource, 'hub:official_market_reference');
    assert.ok(categories.includes('official_market_reference'));
  } finally {
    hubClient.fetchHubSecrets = originalFetchHubSecrets;
  }

  const reference = buildFixtureDomesticOfficialReference();
  assert.equal(reference.available, true);
  assert.equal(reference.bySymbol['005930'].officialEligible, true);
  assert.equal(reference.bySymbol['069500'].officialEligible, false);
  assert.ok(reference.bySymbol['069500'].officialBlockers.includes('security_type_etf'));
  assert.ok(reference.bySymbol['005935'].officialBlockers.includes('security_type_preferred_stock'));
  assert.ok(reference.bySymbol['123450'].officialBlockers.includes('security_type_spac'));
  assert.ok(reference.bySymbol['000020'].officialBlockers.includes('turnover_below_official_floor'));
  assert.ok(reference.bySymbol['111111'].officialBlockers.includes('trading_halt_or_suspended'));

  const commonGate = evaluateDomesticOfficialReferenceGate('005930', reference, { hardGate: true });
  assert.equal(commonGate.ok, true);
  assert.equal(commonGate.hardBlocked, false);

  const etfGate = evaluateDomesticOfficialReferenceGate('069500', reference, { hardGate: true });
  assert.equal(etfGate.blocked, true);
  assert.equal(etfGate.hardBlocked, true);
  assert.equal(etfGate.reason, 'security_type_etf');

  const shadowGate = evaluateDomesticOfficialReferenceGate('069500', reference, { hardGate: false });
  assert.equal(shadowGate.blocked, true);
  assert.equal(shadowGate.hardBlocked, false);

  const annotated = annotateDomesticOfficialReferenceCandidates([
    { symbol: '005930', score: 0.9 },
    { symbol: '069500', score: 0.8 },
    { symbol: '000020', score: 0.7 },
  ], reference, { hardGate: true });
  assert.equal(annotated.candidates.length, 1);
  assert.equal(annotated.excluded.length, 2);

  const runtime = await runLunaDomesticOfficialReference({ fixture: true, dryRun: true, hardGate: true });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.reference.available, true);
  assert.ok(runtime.officialReferenceCandidates.some((item) => item.symbol === '005930' && !item.officialReferenceHardBlocked));
  assert.ok(runtime.officialReferenceCandidates.some((item) => item.symbol === '069500' && item.officialReferenceHardBlocked));
  assert.ok(runtime.officialReferenceHoldings.some((item) => item.symbol === '069500' && item.officialReferenceWouldBlock));

  return {
    ok: true,
    smoke: 'luna-domestic-official-reference',
    symbols: reference.symbols.length,
    ineligibleCount: reference.excluded.ineligibleCount,
    runtimeWouldBlock: runtime.activeCandidates.wouldBlock,
    runtimeHoldingsReview: runtime.holdings.wouldBlock,
  };
}

async function main() {
  const result = await runLunaDomesticOfficialReferenceSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-domestic-official-reference-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna-domestic-official-reference-smoke error:',
  });
}

#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const { getFixturePayload } = require('../lib/edux-fixtures.ts');
const { generateCryptoImages, generateKisImages, generateOverseasImages } = require('../lib/edux-image-generator.ts');

process.env.EDUX_DISABLE_TRADINGVIEW_READONLY = 'true';

async function main() {
  const cryptoFixture = getFixturePayload('crypto');
  const kisFixture = getFixturePayload('kis');
  const overseasFixture = getFixturePayload('overseas');
  const results = {
    crypto: await generateCryptoImages('0600', { marketData: cryptoFixture.marketData, ohlcvData: cryptoFixture.ohlcvData }),
    kis: await generateKisImages({ marketData: kisFixture.marketData }),
    overseas: await generateOverseasImages({ marketData: overseasFixture.marketData }),
  };
  for (const [category, paths] of Object.entries(results)) {
    assert(paths.length >= 2, `${category} image count ${paths.length}`);
    for (const filePath of paths) assert(fs.existsSync(filePath), `${category} missing image: ${filePath}`);
  }
  console.log(JSON.stringify({ ok: true, counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])) }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

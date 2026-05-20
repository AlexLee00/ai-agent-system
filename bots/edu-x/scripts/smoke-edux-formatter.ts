#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { formatPost, validateContentQuality, buildCryptoTitle, displayMarketSymbol } = require('../lib/edux-formatter.ts');
const { formatContentForEduXWeb } = require('../lib/edux-runtime-support.ts');
const { getFixturePayload } = require('../lib/edux-fixtures.ts');

async function check(category, slot) {
  const fixture = getFixturePayload(category);
  const result = await formatPost(category, slot, fixture.marketData, fixture.evidenceItems, fixture.technicalData || {}, { fixture: true });
  const quality = validateContentQuality(result.content);
  assert.equal(quality.ok, true, `${category} formatter quality failed: ${JSON.stringify(quality)}`);
  assert.equal(result.content.includes('[이미지'), false, `${category} still contains image placeholder`);
  const html = formatContentForEduXWeb(result.content);
  assert.equal(html.includes('<h3>①'), true, `${category} html conversion missing section block`);
  assert.equal(html.includes('<p>'), true, `${category} html conversion missing paragraph block`);
  assert.equal(html.includes('**'), false, `${category} html conversion should strip markdown bold markers`);
  if (category === 'kis') {
    assert.equal(/BTC\/USDT|비트코인|Fear & Greed|암호화폐 커뮤니티/.test(result.content), false, 'kis fallback should not contain crypto-specific sections');
    assert.equal(/국내주식|코스피|외인/.test(result.content), true, 'kis fallback should contain domestic market sections');
  }
  if (category === 'overseas') {
    assert.equal(/BTC\/USDT|비트코인|Fear & Greed|암호화폐 커뮤니티/.test(result.content), false, 'overseas fallback should not contain crypto-specific sections');
    assert.equal(/해외주식|S&P500|Magnificent 7/.test(result.content), true, 'overseas fallback should contain overseas market sections');
  }
  return { category, slot, contentLen: quality.contentLen, sectionCount: 10 };
}

async function main() {
  const results = [
    await check('crypto', '0600'),
    await check('kis', '0900'),
    await check('overseas', '2200'),
  ];
  const cryptoTitle = buildCryptoTitle('1400', { btc_price: 90000, btc_change_24h: 1.2 });
  assert.equal(/유럽|아시아|미국/.test(cryptoTitle), false, `crypto title includes unnatural region label: ${cryptoTitle}`);
  assert.equal(buildCryptoTitle('1400', { btc_symbol: 'BTCUSDT', btc_price: 90000 }).includes('BTC/USDT'), true, 'crypto title should display BTC/USDT');
  assert.equal(displayMarketSymbol('ETHUSDT'), 'ETH/USDT');
  assert.equal(displayMarketSymbol('SOL'), 'SOL/USDT');
  const cryptoFixture = getFixturePayload('crypto');
  const cryptoPost = await formatPost('crypto', '1400', cryptoFixture.marketData, cryptoFixture.evidenceItems, cryptoFixture.technicalData, { fixture: true });
  const originalFormatterFixture = process.env.EDUX_FORMATTER_FIXTURE;
  delete process.env.EDUX_FORMATTER_FIXTURE;
  const cryptoDefault = await formatPost('crypto', '1400', cryptoFixture.marketData, cryptoFixture.evidenceItems, cryptoFixture.technicalData);
  if (originalFormatterFixture !== undefined) process.env.EDUX_FORMATTER_FIXTURE = originalFormatterFixture;
  assert.equal(cryptoDefault.source, 'crypto_deterministic', 'crypto formatter should default to deterministic mode');
  assert.equal(cryptoPost.content.includes('BTC/USDT'), true, 'crypto post should display BTC/USDT');
  assert.equal(cryptoPost.content.includes('ETH/USDT'), true, 'crypto post should display ETH/USDT');
  assert.equal(/BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT/.test(cryptoPost.content), false, 'crypto post should not expose raw exchange symbols');
  const btcInfoIndex = cryptoPost.content.indexOf('③ ₿ BTC/USDT 핵심 정보 카드');
  const communityIndex = cryptoPost.content.indexOf('④ 🌐 암호화폐 커뮤니티 이슈');
  const lunaIndex = cryptoPost.content.indexOf('⑨ 🤖 루나팀 자동매매 정보');
  assert.ok(btcInfoIndex > -1 && communityIndex > btcInfoIndex && lunaIndex > communityIndex, 'crypto post priority should be BTC info -> crypto community -> Luna automation');
  assert.equal(cryptoPost.content.includes('이미지 대신'), false, 'crypto post should not mention image replacement');
  assert.equal(/① 🧭|② ⚡|③ ₿|④ 🌐|⑤ 📈|⑥ 🛡️|⑦ 👀|⑧ 🗓️|⑨ 🤖|⑩ ⚠️/.test(cryptoPost.content), true, 'crypto post should include section header emojis');
  const tableHtml = formatContentForEduXWeb('① **제목**\n\n| symbol | 가격 |\n| --- | --- |\n| BTC/USDT | $1 |\n\n1. 첫 이슈\n2. 둘째 이슈');
  assert.equal(tableHtml.includes('<h3>① 제목</h3>'), true, 'html conversion should strip bold markers in headings');
  assert.equal(tableHtml.includes('• BTC/USDT — 가격 $1'), true, 'html conversion should render markdown tables as safe paragraph rows');
  assert.equal(tableHtml.includes('<table>'), false, 'html conversion should avoid table tags because Edu-X strips them');
  assert.equal(tableHtml.includes('<ol>'), false, 'html conversion should avoid ordered-list restart issues');
  assert.equal(tableHtml.includes('<p>1. 첫 이슈</p>'), true, 'html conversion should preserve numbered issue rows as paragraphs');
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

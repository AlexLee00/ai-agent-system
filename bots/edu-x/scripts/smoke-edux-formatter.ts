#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { formatPost, validateContentQuality, buildCryptoTitle, buildKisTitle, buildOverseasTitle, displayMarketSymbol } = require('../lib/edux-formatter.ts');
const { formatContentForEduXWeb, validatePostQuality } = require('../lib/edux-runtime-support.ts');
const { getFixturePayload } = require('../lib/edux-fixtures.ts');

async function check(category, slot) {
  const fixture = getFixturePayload(category);
  const result = await formatPost(category, slot, fixture.marketData, fixture.evidenceItems, fixture.technicalData || {}, { fixture: true });
  const quality = validateContentQuality(result.content, category);
  assert.equal(quality.ok, true, `${category} formatter quality failed: ${JSON.stringify(quality)}`);
  assert.equal(result.content.includes('[이미지'), false, `${category} still contains image placeholder`);
  assert.equal(/[①②③④⑤⑥⑦⑧⑨⑩]/.test(result.content), false, `${category} should not render legacy section numbers`);
  const html = formatContentForEduXWeb(result.content);
  assert.equal(html.includes('<h3>⚡'), true, `${category} html conversion missing first card block`);
  assert.equal(html.includes('<p>&nbsp;</p>\n<h3>'), true, `${category} html conversion should add visible spacing between section blocks`);
  assert.equal(html.includes('<p>'), true, `${category} html conversion missing paragraph block`);
  assert.equal(html.includes('**'), false, `${category} html conversion should strip markdown bold markers`);
  if (category === 'kis') {
    assert.equal(/BTC\/USDT|비트코인|Fear & Greed|암호화폐 커뮤니티/.test(result.content), false, 'kis fallback should not contain crypto-specific sections');
    assert.equal(/국내주식|코스피|외국인|오늘 볼 섹터/.test(result.content), true, 'kis fallback should contain domestic card sections');
  }
  if (category === 'overseas') {
    assert.equal(/BTC\/USDT|비트코인|Fear & Greed|암호화폐 커뮤니티/.test(result.content), false, 'overseas fallback should not contain crypto-specific sections');
    assert.equal(/해외주식|S&P500|Magnificent 7|지수·리스크 지도/.test(result.content), true, 'overseas fallback should contain overseas card sections');
  }
  return { category, slot, contentLen: quality.contentLen, sectionCount: quality.sectionCount };
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
  assert.equal(buildKisTitle({ kospi_index: 2920, kospi_change: 0.7 }).includes('국내주식 시황 카드'), true, 'kis title should use card pattern');
  assert.equal(buildOverseasTitle({ sp500_index: 6250, sp500_change: 0.5 }).includes('해외주식 시황 카드'), true, 'overseas title should use card pattern');
  assert.equal(displayMarketSymbol('ETHUSDT'), 'ETH/USDT');
  assert.equal(displayMarketSymbol('SOL'), 'SOL/USDT');
  const cryptoFixture = getFixturePayload('crypto');
  const cryptoPost = await formatPost('crypto', '1400', cryptoFixture.marketData, cryptoFixture.evidenceItems, cryptoFixture.technicalData, { fixture: true });
  const originalFormatterFixture = process.env.EDUX_FORMATTER_FIXTURE;
  delete process.env.EDUX_FORMATTER_FIXTURE;
  const cryptoDefault = await formatPost('crypto', '1400', cryptoFixture.marketData, cryptoFixture.evidenceItems, cryptoFixture.technicalData);
  assert.equal(cryptoDefault.source, 'crypto_deterministic', 'crypto formatter should default to deterministic mode');
  const kisFixture = getFixturePayload('kis');
  const overseasFixture = getFixturePayload('overseas');
  const kisDefault = await formatPost('kis', '0900', kisFixture.marketData, kisFixture.evidenceItems, {});
  const overseasDefault = await formatPost('overseas', '2200', overseasFixture.marketData, overseasFixture.evidenceItems, {});
  if (originalFormatterFixture !== undefined) process.env.EDUX_FORMATTER_FIXTURE = originalFormatterFixture;
  assert.equal(kisDefault.source, 'kis_deterministic', 'kis formatter should default to deterministic card mode');
  assert.equal(overseasDefault.source, 'overseas_deterministic', 'overseas formatter should default to deterministic card mode');
  assert.equal(cryptoPost.content.includes('BTC/USDT'), true, 'crypto post should display BTC/USDT');
  assert.equal(cryptoPost.content.includes('ETH/USDT'), true, 'crypto post should display ETH/USDT');
  assert.equal(/BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT/.test(cryptoPost.content), false, 'crypto post should not expose raw exchange symbols');
  const quickIndex = cryptoPost.content.indexOf('⚡ 핵심 3줄');
  const priceIndex = cryptoPost.content.indexOf('📌 BTC/USDT 가격 지도');
  const scenarioIndex = cryptoPost.content.indexOf('📈 상승/하락 시나리오');
  const communityIndex = cryptoPost.content.indexOf('🌐 커뮤니티·뉴스 이슈 Top 3');
  const checkpointIndex = cryptoPost.content.indexOf('⚠️ 오늘 체크포인트 + 면책');
  assert.ok(
    quickIndex > -1 && priceIndex > quickIndex && scenarioIndex > priceIndex && communityIndex > scenarioIndex && checkpointIndex > communityIndex,
    'crypto post priority should be quick read -> BTC price map -> scenario -> community/news -> disclaimer',
  );
  assert.equal(cryptoPost.content.includes('이미지 대신'), false, 'crypto post should not mention image replacement');
  assert.equal(/⚡|📌|📈|🌐|⚠️/.test(cryptoPost.content), true, 'crypto post should include section header emojis');
  assert.equal(/[①②③④⑤⑥⑦⑧⑨⑩]/.test(cryptoPost.content), false, 'crypto post should not include legacy section numbers');
  assert.equal(/수집 대기|데이터 없음|N\/A/.test(cryptoPost.content), false, 'crypto post should not expose placeholder text');
  assert.equal(/현재가|가격/.test(cryptoPost.content), true, 'crypto post should include BTC current price');
  assert.equal(/지지/.test(cryptoPost.content), true, 'crypto post should include support level');
  assert.equal(/저항/.test(cryptoPost.content), true, 'crypto post should include resistance level');
  assert.equal(/상승 시나리오/.test(cryptoPost.content), true, 'crypto post should include bull scenario');
  assert.equal(/하락 시나리오/.test(cryptoPost.content), true, 'crypto post should include bear scenario');
  assert.equal(/무효화|이탈|돌파 실패/.test(cryptoPost.content), true, 'crypto post should include invalidation condition');
  assert.equal(/luna-community|positive|neutral|negative/.test(cryptoPost.content), false, 'crypto post should not expose internal source or raw signal labels');
  assert.equal(/근거: 커뮤니티 수집, 해석:/.test(cryptoPost.content), true, 'crypto post should translate community source and signal labels for users');
  const machineSourcePost = await formatPost(
    'crypto',
    '1400',
    cryptoFixture.marketData,
    [{
      ...cryptoFixture.evidenceItems[0],
      sourceName: 'google_news_crypto_rss',
      signalDirection: 'bearish',
      evidenceSummary: 'Weekly crypto ETP outflows top $1B, ending six-week positive streak amid risk-off',
    }],
    cryptoFixture.technicalData,
    { fixture: true },
  );
  assert.equal(/google_news_crypto_rss|bearish/.test(machineSourcePost.content), false, 'crypto post should not expose machine source names or raw bearish labels');
  assert.equal(machineSourcePost.content.includes('근거: 뉴스 RSS, 해석: 주의'), true, 'crypto post should map machine source names to reader-facing labels');
  assert.equal(machineSourcePost.content.includes('ETF/ETP에서 $1B 규모의 자금 유출'), true, 'crypto post should preserve outflow direction and amount in Korean issue summaries');
  assert.equal(validateContentQuality(cryptoPost.content, 'crypto').infoIssues.length, 0, 'crypto post should pass information-density gate');
  const kisPatternPost = await formatPost(
    'kis',
    '0900',
    kisFixture.marketData,
    [{
      sourceName: 'naver_news_rss',
      signalDirection: 'positive',
      evidenceSummary: 'Samsung Electronics and SK Hynix rally on HBM AI demand while foreign investors return',
    }],
    {},
    { fixture: true },
  );
  assert.equal(/naver_news_rss|positive|Samsung Electronics/.test(kisPatternPost.content), false, 'kis post should not expose raw source, raw signal, or untranslated English issue titles');
  assert.equal(kisPatternPost.content.includes('반도체·HBM 이슈'), true, 'kis post should rewrite semiconductor/HBM community patterns');
  assert.equal(kisPatternPost.content.includes('근거: 네이버 뉴스, 해석: 긍정'), true, 'kis post should map equity source and tone labels');
  const kisInternalSignalPost = await formatPost(
    'kis',
    '0900',
    {},
    [{
      sourceName: 'luna-kis-signal',
      signalDirection: 'SELL',
      symbol: '031330',
      evidenceSummary: '[031330] 승인형 strategy-exit 실행 (stop_loss_threshold)',
    }],
    {},
    { fixture: true },
  );
  assert.equal(/strategy-|stop_loss|SELL|031330|승인형/.test(kisInternalSignalPost.content), false, 'kis post should filter internal trading signals from community issue rows');
  assert.equal(/미확인/.test(kisInternalSignalPost.content), false, 'kis fallback should avoid repeated unknown placeholders in reader-facing cards');
  const kisApprovedNewsPost = await formatPost(
    'kis',
    '0900',
    kisFixture.marketData,
    [{
      sourceName: 'naver_news_rss',
      signalDirection: 'positive',
      evidenceSummary: 'Korean biotech export candidate approved in overseas market while healthcare stocks gain',
    }],
    {},
    { fixture: true },
  );
  assert.equal(kisApprovedNewsPost.content.includes('근거: 네이버 뉴스'), true, 'kis post should not drop legitimate approved/news evidence from public sources');
  const overseasPatternPost = await formatPost(
    'overseas',
    '2200',
    overseasFixture.marketData,
    [{
      sourceName: 'reuters_news_rss',
      signalDirection: 'positive',
      evidenceSummary: 'Nvidia leads megacap gains as AI infrastructure demand lifts Nasdaq futures ahead of earnings',
    }],
    {},
    { fixture: true },
  );
  assert.equal(/reuters_news_rss|positive|Nvidia leads/.test(overseasPatternPost.content), false, 'overseas post should not expose raw source, raw signal, or untranslated English issue titles');
  assert.equal(overseasPatternPost.content.includes('AI 인프라·반도체 대형주 이슈'), true, 'overseas post should rewrite AI infrastructure community patterns');
  assert.equal(overseasPatternPost.content.includes('근거: Reuters 뉴스, 해석: 긍정'), true, 'overseas post should map overseas source and tone labels');
  const tableHtml = formatContentForEduXWeb('🧭 **제목**\n\n| symbol | 가격 |\n| --- | --- |\n| BTC/USDT | $1 |\n\n1. 첫 이슈\n2. 둘째 이슈');
  assert.equal(tableHtml.includes('<h3>🧭 제목</h3>'), true, 'html conversion should strip bold markers in headings');
  const legacyHtml = formatContentForEduXWeb('① 🧭 **제목**');
  assert.equal(legacyHtml.includes('<h3>🧭 제목</h3>'), true, 'html conversion should strip legacy section numbers');
  assert.equal(tableHtml.includes('• BTC/USDT — 가격 $1'), true, 'html conversion should render markdown tables as safe paragraph rows');
  assert.equal(tableHtml.includes('<table>'), false, 'html conversion should avoid table tags because Edu-X strips them');
  assert.equal(tableHtml.includes('<ol>'), false, 'html conversion should avoid ordered-list restart issues');
  assert.equal(tableHtml.includes('<p>1. 첫 이슈</p>'), true, 'html conversion should preserve numbered issue rows as paragraphs');
  const duplicateHeadings = Array.from({ length: 5 }, (_, index) => `⚡ 핵심 3줄 ${index + 1}\n본문`).join('\n\n');
  const duplicateFormatterQuality = validateContentQuality(duplicateHeadings, 'crypto');
  assert.equal(duplicateFormatterQuality.ok, false, 'formatter quality should reject duplicate headings with missing required sections');
  assert.equal(duplicateFormatterQuality.missingSections.includes('checkpoint_disclaimer'), true, 'formatter quality should report missing disclaimer section');
  const duplicateRuntimeQuality = validatePostQuality({ content: duplicateHeadings, category: 'crypto' });
  assert.equal(duplicateRuntimeQuality.ok, false, 'runtime quality should reject duplicate headings with missing required sections');
  assert.equal(duplicateRuntimeQuality.missingSections.includes('checkpoint_disclaimer'), true, 'runtime quality should report missing disclaimer section');
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

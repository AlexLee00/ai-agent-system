#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  buildDigestMessage,
  digestWindow,
  escapeHtml,
  fetchDigestRows,
  normalizeDigestPostUrl,
  parseDigestRow,
  resolveTelegramChannelId,
  summarizeOneLine,
} = require('./runtime-edux-daily-digest.ts');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

function parseArgs(argv = process.argv.slice(2)) {
  return { json: argv.includes('--json') };
}

function fixtureRows() {
  return [
    {
      schedule_slot: '0600',
      category: 'crypto',
      title: '06/22 BTC/USDT 시황 카드 | BTC/USDT $63,346 +0.9%',
      post_url: 'https://edu-x.io/community/crypto-fixture',
      published_at: '2026-06-22T06:00:00+09:00',
      metadata: {
        lunaEvidenceSummary: '⚡ 핵심 3줄 | BTC는 저항선 아래에서 단기 반등을 시험 중입니다. | 보조 문장',
      },
    },
    {
      schedule_slot: '1600',
      category: 'kis',
      title: '06/22 국내증시 마감 요약 | 코스피 9,115 +0.7%',
      post_url: 'https://edu-x.io/community/kis-fixture',
      published_at: '2026-06-22T16:00:00+09:00',
      metadata: {
        lunaEvidenceSummary: '■ 마감 확정치 | 코스피가 코스닥보다 강했고 대형주 우위가 관측됐습니다. 원/달러 환율은 1,537.88원으로 확인됐습니다. 지수는 모두 상승했지만 코스닥보다 코스피가 더 강했습니다. | 수급 보조 문장',
      },
    },
    {
      schedule_slot: '0630',
      category: 'overseas',
      title: '06/22 미국장 마감 요약 | S&P500 7,365 -1.4%',
      post_url: 'https://edu-x.io/community/overseas-close-fixture',
      published_at: '2026-06-22T22:00:00+09:00',
      metadata: {
        lunaEvidenceSummary: '■ 마감 확정치 | S&P500 7365로 -1.4%, Nasdaq은 25587로 -2.2%, Dow는 51667로 -0.1% 마감했습니다. | 보조 문장',
      },
    },
  ];
}

function assertMessage(rows, text) {
  const blockCount = (text.match(/^📊/gm) || []).length;
  assert.equal(blockCount, rows.length, `digest block count mismatch: ${blockCount}/${rows.length}`);
  for (const row of rows) {
    const expectedPostUrl = normalizeDigestPostUrl(row.post_url);
    assert.ok(text.includes(`href="${expectedPostUrl}"`), `missing linked post_url: ${expectedPostUrl}`);
    const parsed = parseDigestRow(row);
    assert.ok(parsed.assetLine, 'asset line should be parsed');
    assert.ok(parsed.summaryLine, 'summary line should be parsed');
    assert.ok(parsed.summaryLine.length <= 73, `summary must stay one-line-ish: ${parsed.summaryLine}`);
    if (parsed.category === 'kis' && parsed.scheduleSlot === '1600') {
      assert.equal(parsed.summaryLine.includes('마감'), false, `summary should omit duplicated close wording: ${parsed.summaryLine}`);
      assert.equal(parsed.summaryLine.includes('분야 강세'), false, `summary should omit redundant field wording: ${parsed.summaryLine}`);
    }
    assert.match(parsed.timeLabel, /^\d{2}:\d{2}$/);
    assert.ok(text.includes(`>${escapeHtml(`[${parsed.summaryLine}]`)}<\/a>`), `summary must be bracketed link: ${parsed.summaryLine}`);
    assert.ok(text.includes(`📊<b>`), 'title line should be bold');
  }
}

async function runSmoke() {
  const reference = new Date('2026-06-22T10:00:00+09:00');
  const windowCheck = digestWindow(reference);
  assert.equal(windowCheck.end.toISOString(), reference.toISOString());
  assert.equal(windowCheck.start.toISOString(), new Date(reference.getTime() - 24 * 60 * 60 * 1000).toISOString());
  assert.equal(
    normalizeDigestPostUrl('https://edu-x.io/community/posts/legacy-post-id'),
    'https://edu-x.io/community/legacy-post-id',
    'digest must normalize legacy API-style post URLs to web detail URLs',
  );
  const compressed = summarizeOneLine('원/달러 1,554원 급등 속 코스피·코스닥 동반 급락, 환율 안정 여부가 관건입니다. 추가 문장은 제거됩니다.');
  assert.ok(compressed.length <= 73, `compressed summary too long: ${compressed}`);
  assert.equal(compressed.includes('추가 문장'), false);

  let dbRows = [];
  let dbWindow = null;
  try {
    const result = await fetchDigestRows(pgPool);
    dbRows = result.rows || [];
    dbWindow = result.window;
  } catch (err) {
    dbRows = [];
    dbWindow = { error: err?.message || String(err) };
  }

  const rowsForFormat = dbRows.length > 0 ? dbRows : fixtureRows();
  const latestFirstText = buildDigestMessage(fixtureRows().slice().sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()), {
    dateMmdd: '06/22',
    playUrl: 'https://example.com/app',
  });
  assert.ok(latestFirstText.indexOf('미국 마감 S&amp;P500 7,365 -1.4%') < latestFirstText.indexOf('국내 마감 코스피 9,115 +0.7%'));
  assert.equal(latestFirstText.includes('미국 증시 S&amp;P500 7,365 -1.4%'), false);
  const text = buildDigestMessage(rowsForFormat, {
    dateMmdd: rowsForFormat[0]?.title?.slice(0, 5) || '06/22',
    playUrl: 'https://example.com/app',
  });
  assertMessage(rowsForFormat, text);
  assert.match(text, /<b>🔥\[\d{2} \/ \d{2}\]  오늘 꼭 알아야 할 시장 정보 총정리🔥<\/b>/);
  assert.ok(text.includes('Edu-X 에듀엑스 다운로드'));
  assert.ok(text.includes('href="https://example.com/app"'));
  const defaultPlayText = buildDigestMessage(rowsForFormat, {
    dateMmdd: rowsForFormat[0]?.title?.slice(0, 5) || '06/22',
  });
  assert.ok(defaultPlayText.includes('href="https://onelink.to/vmpdmz"'));
  assert.ok(defaultPlayText.includes('Edu-X 에듀엑스 다운로드'));
  assert.ok(text.includes('EduX 커뮤니티에 있습니다'));
  assert.ok(latestFirstText.includes('<b>국내 마감 코스피 9,115 +0.7%</b>'));
  assert.equal(text.includes('국내 마감 요약'), false);
  assert.equal(text.includes('국내 장시 마감 요약'), false);
  assert.equal(text.includes('게시글 보기'), false);
  assert.ok(text.includes('<a href="https://example.com/app">Edu-X 에듀엑스 다운로드 👉</a>'));
  assert.equal(/\(\d{2}:\d{2}\s+요약\)/.test(text), false);
  const originalEnv = {
    target: process.env.EDUX_DIGEST_TELEGRAM_TARGET,
    test: process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_TEST,
    live: process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_LIVE,
    legacy: process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID,
  };
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_TEST = 'test-channel';
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_LIVE = 'live-channel';
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID = 'legacy-channel';
  process.env.EDUX_DIGEST_TELEGRAM_TARGET = 'test';
  assert.equal(resolveTelegramChannelId(), 'test-channel');
  process.env.EDUX_DIGEST_TELEGRAM_TARGET = 'live';
  assert.equal(resolveTelegramChannelId(), 'live-channel');
  process.env.EDUX_DIGEST_TELEGRAM_TARGET = '';
  assert.equal(resolveTelegramChannelId(), 'legacy-channel');
  process.env.EDUX_DIGEST_TELEGRAM_TARGET = originalEnv.target;
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_TEST = originalEnv.test;
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_LIVE = originalEnv.live;
  process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID = originalEnv.legacy;

  return {
    ok: true,
    dbCount: dbRows.length,
    usedFixture: dbRows.length === 0,
    window: dbWindow && !dbWindow.error
      ? { start: dbWindow.start.toISOString(), end: dbWindow.end.toISOString() }
      : dbWindow,
    parsed: rowsForFormat.map(parseDigestRow),
    text,
  };
}

if (require.main === module) {
  const args = parseArgs();
  runSmoke()
    .then((result) => {
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(result.text);
        console.log(`[smoke-edux-daily-digest] ok dbCount=${result.dbCount} usedFixture=${result.usedFixture}`);
      }
    })
    .catch((err) => {
      console.error('[smoke-edux-daily-digest] 실패:', err);
      process.exit(1);
    });
}

module.exports = { runSmoke, fixtureRows };

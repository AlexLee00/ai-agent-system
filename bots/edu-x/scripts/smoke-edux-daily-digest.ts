#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  buildDigestMessage,
  fetchDigestRows,
  parseDigestRow,
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
      post_url: 'https://edu-x.io/community/posts/crypto-fixture',
      published_at: '2026-06-22T06:00:00+09:00',
      metadata: {
        lunaEvidenceSummary: '⚡ 핵심 3줄 | BTC는 저항선 아래에서 단기 반등을 시험 중입니다. | 보조 문장',
      },
    },
    {
      schedule_slot: '1600',
      category: 'kis',
      title: '06/22 국내증시 마감 요약 | 코스피 9,115 +0.7%',
      post_url: 'https://edu-x.io/community/posts/kis-fixture',
      published_at: '2026-06-22T16:00:00+09:00',
      metadata: {
        lunaEvidenceSummary: '■ 마감 확정치 | 코스피가 코스닥보다 강했고 대형주 우위가 관측됐습니다. | 수급 보조 문장',
      },
    },
  ];
}

function assertMessage(rows, text) {
  const blockCount = (text.match(/^📊/gm) || []).length;
  assert.equal(blockCount, rows.length, `digest block count mismatch: ${blockCount}/${rows.length}`);
  for (const row of rows) {
    assert.ok(text.includes(row.post_url), `missing post_url: ${row.post_url}`);
    const parsed = parseDigestRow(row);
    assert.ok(parsed.assetLine, 'asset line should be parsed');
    assert.ok(parsed.summaryLine, 'summary line should be parsed');
    assert.match(parsed.timeLabel, /^\d{2}:\d{2}$/);
  }
}

async function runSmoke() {
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
  const text = buildDigestMessage(rowsForFormat, {
    dateMmdd: rowsForFormat[0]?.title?.slice(0, 5) || '06/22',
    playUrl: 'https://example.com/app',
  });
  assertMessage(rowsForFormat, text);
  assert.ok(text.includes('오늘 꼭 알아야 할 시장 정보 총정리'));
  assert.ok(text.includes('EDU-X 앱 다운로드'));

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

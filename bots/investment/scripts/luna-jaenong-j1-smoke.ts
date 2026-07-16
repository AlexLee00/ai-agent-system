#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  FANDING_POST_FAILURE_THRESHOLD,
  classifyFandingFailure,
  collectFandingPostSnapshots,
  computeFandingArchiveCutoff,
  dedupeFandingPosts,
  mapWithConcurrency,
  upsertFandingPosts,
} from './fanding-post-collector.ts';
import {
  JAENONG_PARSER_VERSION,
  JAENONG_TICKER_DRAFT,
  parseJaenongPost,
  pointInTimeReferencePrice,
  validateJaenongBrief,
} from './jaenong-post-parser.ts';
import { scoreJaenongCandidates, scoreStoredJaenongPosts } from './jaenong-retro-score.ts';

const rawPost = {
  sourcePostId: 'post-1',
  url: 'https://fanding.kr/@fixture/post/1/',
  title: '마이크로소프트 조정 시 매수 전략',
  publishedAt: '2026-01-02T00:00:00.000Z',
  content: '마이크로소프트(MSFT)는 장기 매수 관점입니다. 400달러에서 매수하고 440달러에서 매도합니다. 380달러 이탈 시 손절합니다.',
  isPrivate: true,
};

async function main() {
  assert.equal(classifyFandingFailure({ httpStatus: 401 }), 'session_expired');
  assert.equal(classifyFandingFailure({ loginAttempted: true, authenticated: false }), 'login_failed');
  assert.equal(classifyFandingFailure({ authenticated: true, feedItems: [] }), 'empty_feed');
  assert.equal(classifyFandingFailure({ authenticated: true, feedItems: null }), 'dom_changed');
  assert.equal(FANDING_POST_FAILURE_THRESHOLD, 0.3);
  assert.equal(
    computeFandingArchiveCutoff('2026-07-15T09:30:00.000Z', 1).toISOString(),
    '2026-06-15T09:30:00.000Z',
  );
  assert.equal(
    computeFandingArchiveCutoff('2026-07-15T09:30:00.000Z', 12).toISOString(),
    '2025-07-15T09:30:00.000Z',
  );

  const archivePosts = [1, 2, 3, 4].map((id) => ({
    sourcePostId: `archive-${id}`,
    url: `https://fanding.kr/@fixture/post/${id}/`,
    title: `archive ${id}`,
    publishedAt: '2026-01-02T00:00:00.000Z',
    content: `snapshot ${id}`,
  }));
  const mixedSnapshots = await collectFandingPostSnapshots(archivePosts, async (post) => {
    if (post.sourcePostId === 'archive-2') {
      throw Object.assign(new Error('fixture selector mismatch'), {
        stage: 'snapshot_selector',
        selectorHint: '.fixture-content',
      });
    }
    return post;
  });
  assert.equal(mixedSnapshots.status, 'ok');
  assert.equal(mixedSnapshots.successCount, 3);
  assert.equal(mixedSnapshots.failureCount, 1);
  assert.equal(mixedSnapshots.skippedCount, 1);
  assert.deepEqual(mixedSnapshots.failedPosts[0], {
    sourcePostId: 'archive-2',
    url: 'https://fanding.kr/@fixture/post/2/',
    status: 'dom_changed_post',
    stage: 'snapshot_selector',
    selectorHint: '.fixture-content',
    error: 'fixture selector mismatch',
  });
  let archiveWrites = 0;
  assert.equal(await upsertFandingPosts(mixedSnapshots.successfulPosts, async () => {
    archiveWrites += 1;
  }), 3);
  assert.equal(archiveWrites, 3, 'only successful snapshots may reach the DB runner');
  const thresholdBoundary = await collectFandingPostSnapshots(
    Array.from({ length: 10 }, (_, index) => ({
      sourcePostId: `boundary-${index + 1}`,
      url: `https://fanding.kr/@fixture/post/boundary-${index + 1}/`,
    })),
    async (post) => {
      if (['boundary-1', 'boundary-2', 'boundary-3'].includes(post.sourcePostId)) {
        throw new Error('fixture boundary failure');
      }
      return post;
    },
  );
  assert.equal(thresholdBoundary.failureRate, 0.3);
  assert.equal(thresholdBoundary.status, 'ok', 'the aggregate must fail only above the threshold');
  const excessiveFailures = await collectFandingPostSnapshots(archivePosts, async (post) => {
    if (['archive-1', 'archive-2'].includes(post.sourcePostId)) throw new Error('fixture archive failure');
    return post;
  });
  assert.equal(excessiveFailures.status, 'dom_changed');

  const deduped = dedupeFandingPosts([
    rawPost,
    { ...rawPost, title: 'same identity, newer snapshot' },
  ]);
  assert.equal(deduped.length, 1, 'duplicate source keys must collapse deterministically');
  assert.equal(deduped[0].title, 'same identity, newer snapshot');

  const parsed = parseJaenongPost(rawPost);
  assert.equal(parsed.candidates[0].ticker, 'MSFT');
  assert.equal(parsed.candidates[0].direction, 'long');
  assert.equal(parsed.candidates[0].buyPoints[0].price, 400);
  assert.equal(parseJaenongPost({ content: 'multiple expansion을 관찰합니다.' }).candidates.length, 0);

  const yearOnly = parseJaenongPost({
    content: 'MSFT는 2027년까지 분할 매수 관점입니다.',
  });
  assert.equal(yearOnly.candidates[0].buyPoints.length, 0, 'a year must not become a price');

  const explicitDollar = parseJaenongPost({ content: 'MSFT $390 1차 매수.' });
  assert.equal(explicitDollar.candidates[0].buyPoints[0].price, 390);

  const dollarFormats = parseJaenongPost({
    content: 'MSFT $1,250.50 1차 매수. MSFT 390달러 타점. MSFT 380불에 진입.',
  });
  assert.deepEqual(
    dollarFormats.candidates[0].buyPoints.map((point) => point.price),
    [1250.5, 390, 380],
  );

  const nonPrices = parseJaenongPost({
    content: 'MSFT는 20%, 3배, 4개, 5월, 6일, 시총 3조 달러, 매출 4억 이후 분할 매수 관점입니다.',
  });
  assert.equal(nonPrices.candidates[0].buyPoints.length, 0, 'business metrics and bare numbers are not prices');

  const distantPrice = parseJaenongPost({
    content: `MSFT $390 ${'관망 '.repeat(20)}매수 관점입니다.`,
  });
  assert.equal(distantPrice.candidates[0].buyPoints.length, 0, 'price and trade keyword must be near each other');

  const drawdownPost = {
    content: 'MSFT -20% 오면 줍는다.',
    publishedAt: '2026-01-02T00:00:00.000Z',
  };
  const drawdown = validateJaenongBrief(parseJaenongPost(drawdownPost), drawdownPost, { MSFT: 500 });
  assert.equal(drawdown.candidates[0].buyPoints[0].price, 400);
  assert.equal(drawdown.candidates[0].buyPoints[0].derived, true);
  assert.deepEqual(drawdown.candidates[0].buyPoints[0].basis, {
    type: 'publication_reference_price',
    price: 500,
  });

  const explicitHigh = parseJaenongPost({
    content: 'MSFT 52주 고점 $500 대비 -30% 오면 줍는다.',
  });
  assert.equal(explicitHigh.candidates[0].buyPoints[0].price, 350);
  assert.equal(explicitHigh.candidates[0].buyPoints[0].derived, true);
  assert.deepEqual(explicitHigh.candidates[0].buyPoints[0].basis, {
    type: 'explicit_52_week_high',
    price: 500,
  });

  const impliedDrawdownPost = {
    content: 'MSFT 고점 대비 -30% 오면.',
    publishedAt: '2026-01-02T00:00:00.000Z',
  };
  const impliedDrawdown = validateJaenongBrief(
    parseJaenongPost(impliedDrawdownPost),
    impliedDrawdownPost,
    { MSFT: 500 },
  );
  assert.equal(impliedDrawdown.candidates[0].buyPoints[0].price, null);
  assert.equal(impliedDrawdown.candidates[0].available, false);
  assert.ok(impliedDrawdown.candidates[0].unavailableReasons.includes('drawdown_basis_missing'));

  const stopLossPercentagePost = {
    content: 'MSFT는 매수 후 -10% 손절합니다.',
    publishedAt: '2026-01-02T00:00:00.000Z',
  };
  const stopLossPercentage = validateJaenongBrief(
    parseJaenongPost(stopLossPercentagePost),
    stopLossPercentagePost,
    { MSFT: 400 },
  );
  assert.equal(stopLossPercentage.candidates[0].buyPoints.length, 0, 'a stop-loss percentage is not an entry');

  const explicitEntryPost = {
    content: 'MSFT 52주 고점 $500, 현재 $400에서 매수하고 -10% 손절합니다.',
    publishedAt: '2026-01-02T00:00:00.000Z',
  };
  const explicitEntry = validateJaenongBrief(
    parseJaenongPost(explicitEntryPost),
    explicitEntryPost,
    { MSFT: 400 },
  );
  assert.deepEqual(explicitEntry.candidates[0].buyPoints, [{
    price: 400,
    sourceSpan: explicitEntryPost.content,
  }]);
  assert.equal(explicitEntry.candidates[0].available, true);

  const explicitHighExit = parseJaenongPost({ content: 'MSFT 52주 고점 $500에 매도합니다.' });
  assert.equal(explicitHighExit.candidates[0].sellPoints[0].price, 500);

  const wonPost = {
    content: 'MSFT 55만원에 매수하고 5만 5천원에도 진입합니다.',
    publishedAt: '2026-01-02T00:00:00.000Z',
  };
  const wonDraft = parseJaenongPost(wonPost);
  assert.deepEqual(wonDraft.candidates[0].currencyMismatches.map((item) => item.amount), [550000, 55000]);
  assert.equal(wonDraft.candidates[0].buyPoints.length, 0, 'KRW must not be converted to a US ticker price');
  const wonValidated = validateJaenongBrief(wonDraft, wonPost, { MSFT: 400 });
  assert.ok(wonValidated.candidates[0].unavailableReasons.includes('currency_mismatch'));
  assert.equal(JAENONG_PARSER_VERSION, 'jaenong-deterministic-v2');

  const validated = validateJaenongBrief(parsed, rawPost, { MSFT: 410 });
  assert.equal(validated.candidates[0].available, true);
  assert.equal(validated.candidates[0].sellPoints[0].price, 440);

  let missingDateLookupCalled = false;
  for (const publishedAt of [null, undefined, 'invalid-date', '2026-02-30']) {
    assert.equal(await pointInTimeReferencePrice('MSFT', publishedAt, {
      getBars: async () => {
        missingDateLookupCalled = true;
        return [];
      },
    }), null);
  }
  assert.equal(missingDateLookupCalled, false, 'invalid publication dates must skip KIS lookup');
  const missingPublicationDate = validateJaenongBrief(parsed, { ...rawPost, publishedAt: null }, { MSFT: 410 });
  assert.equal(missingPublicationDate.candidates[0].available, false);
  assert.ok(missingPublicationDate.candidates[0].unavailableReasons.includes('invalid_publication_date'));

  const badDirection = validateJaenongBrief({
    ...parsed,
    candidates: [{
      ...parsed.candidates[0],
      direction: 'short',
      sourceSpans: ['마이크로소프트(MSFT)는 장기 매수 관점입니다.'],
    }],
  }, rawPost, { MSFT: 410 });
  assert.equal(badDirection.candidates[0].available, false);
  assert.ok(badDirection.candidates[0].unavailableReasons.includes('direction_conflict'));

  const outlier = validateJaenongBrief({
    ...parsed,
    candidates: [{
      ...parsed.candidates[0],
      buyPoints: [{ price: 900, sourceSpan: '400달러에서 매수' }],
    }],
  }, rawPost, { MSFT: 410 });
  assert.equal(outlier.candidates[0].available, false);
  assert.ok(outlier.candidates[0].unavailableReasons.includes('buy_point_out_of_range'));

  const missingTicker = validateJaenongBrief({
    ...parsed,
    candidates: [{ ...parsed.candidates[0], ticker: 'ZZZZ' }],
  }, rawPost, { ZZZZ: 10 });
  assert.equal(missingTicker.candidates[0].available, false);
  assert.ok(missingTicker.candidates[0].unavailableReasons.includes('ticker_not_whitelisted'));
  assert.equal(JAENONG_TICKER_DRAFT.MSFT.status, 'draft_master_approval_required');

  const partial = scoreJaenongCandidates([validated.candidates[0]], {
    MSFT: [
      { date: '20260102', open: 410, high: 415, low: 405, close: 412 },
      { date: '20260103', open: 401, high: 420, low: 399, close: 418 },
      { date: '2026-01-04', open: 425, high: 435, low: 420, close: 430 },
    ],
  });
  assert.equal(partial.summary.availableCandidates, 1);
  assert.equal(partial.summary.entryHitRate, 1);
  assert.equal(partial.rows[0].exitHit, false, 'partial event must remain distinct from completed exit');
  assert.equal(partial.rows[0].holdingReturns.day1, 7.5);
  const sameDayRoundTrip = scoreJaenongCandidates([validated.candidates[0]], {
    MSFT: [
      { date: '20260102', open: 410, high: 445, low: 399, close: 430 },
      { date: '20260103', open: 425, high: 435, low: 420, close: 430 },
    ],
  });
  assert.equal(sameDayRoundTrip.rows[0].exitHit, false, 'OHLC cannot establish same-day entry/exit order');

  let active = 0;
  let peak = 0;
  const concurrency = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(concurrency, [2, 4, 6, 8]);
  assert.equal(peak, 2);

  const cold = scoreJaenongCandidates([], {});
  assert.equal(cold.summary.availableCandidates, 0);
  assert.equal(cold.summary.entryHitRate, null);
  for (const publishedAt of ['invalid-date', '2026-99-99', '2026-02-30']) {
    const invalidDate = scoreJaenongCandidates([
      { ...validated.candidates[0], publishedAt },
    ], { MSFT: [{ date: '20260103', open: 401, high: 420, low: 399, close: 418 }] });
    assert.equal(invalidDate.rows[0].available, false);
    assert.deepEqual(invalidDate.rows[0].unavailableReasons, ['published_at_invalid']);
  }
  const dbDate = scoreJaenongCandidates([
    { ...validated.candidates[0], publishedAt: new Date('2026-01-02T00:00:00.000Z') },
  ], { MSFT: [{ date: '20260103', open: 401, high: 420, low: 399, close: 418 }] });
  assert.equal(dbDate.rows[0].available, true, 'PostgreSQL TIMESTAMPTZ Date values must remain scoreable');

  const scoreWrites = [];
  await scoreStoredJaenongPosts({ write: true }, {
    queryFn: async () => [
      {
        score_id: 1, post_id: 11, parser_version: 'fixture', source_post_id: 'p1',
        published_at: new Date('2026-01-02T00:00:00.000Z'), brief: validated,
      },
      {
        score_id: 2, post_id: 12, parser_version: 'fixture', source_post_id: 'p2',
        published_at: new Date('2026-02-02T00:00:00.000Z'), brief: validated,
      },
    ],
    getBars: async () => [{ date: '20260103', open: 401, high: 420, low: 399, close: 418 }],
    runFn: async (_sql, params) => scoreWrites.push(params),
  });
  assert.equal(scoreWrites.length, 2);
  assert.equal(JSON.parse(scoreWrites[0][0]).totalCandidates, 1, 'stored summary must be scoped to its post');
  assert.deepEqual(rawPost, {
    sourcePostId: 'post-1',
    url: 'https://fanding.kr/@fixture/post/1/',
    title: '마이크로소프트 조정 시 매수 전략',
    publishedAt: '2026-01-02T00:00:00.000Z',
    content: '마이크로소프트(MSFT)는 장기 매수 관점입니다. 400달러에서 매수하고 440달러에서 매도합니다. 380달러 이탈 시 손절합니다.',
    isPrivate: true,
  }, 'raw source sample must not be mutated');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'luna-jaenong-j1',
    boundaries: 8,
    fixtureScore: partial.summary,
  }, null, 2));
}

main().catch((error) => {
  console.error('luna-jaenong-j1-smoke failed:', error);
  process.exitCode = 1;
});

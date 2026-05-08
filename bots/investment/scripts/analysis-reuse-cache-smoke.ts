// @ts-nocheck
import assert from 'node:assert/strict';
import { buildReusableAnalysisResult, getAnalysisReuseTtlMinutes } from '../shared/analysis-reuse-cache.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';

function main() {
  const oldSentiment = process.env.LUNA_SENTIMENT_REUSE_TTL_MINUTES;
  const oldNews = process.env.LUNA_NEWS_REUSE_TTL_MINUTES;
  try {
    process.env.LUNA_SENTIMENT_REUSE_TTL_MINUTES = '45';
    process.env.LUNA_NEWS_REUSE_TTL_MINUTES = '75';
    assert.equal(getAnalysisReuseTtlMinutes(ANALYST_TYPES.SENTIMENT), 45);
    assert.equal(getAnalysisReuseTtlMinutes(ANALYST_TYPES.NEWS), 75);

    const result = buildReusableAnalysisResult({
      id: 'analysis_smoke_1',
      symbol: 'NVDA',
      analyst: ANALYST_TYPES.NEWS,
      signal: ACTIONS.BUY,
      confidence: 0.72,
      reasoning: '[뉴스] earnings beat',
      metadata: { sentiment: '강세', articleCount: 7 },
      exchange: 'kis_overseas',
      created_at: new Date(Date.now() - 9 * 60_000).toISOString(),
    }, {
      symbol: 'NVDA',
      exchange: 'kis_overseas',
      source: 'hermes',
    });

    assert.equal(result.symbol, 'NVDA');
    assert.equal(result.signal, ACTIONS.BUY);
    assert.equal(result.confidence, 0.72);
    assert.equal(result.metadata.reusedAnalysis, true);
    assert.equal(result.metadata.reuseSource, 'hermes');
    assert.equal(result.metadata.sourceAnalysisId, 'analysis_smoke_1');
    assert.equal(result.sentiment, '강세');

    console.log(JSON.stringify({
      ok: true,
      sentiment_ttl_minutes: getAnalysisReuseTtlMinutes(ANALYST_TYPES.SENTIMENT),
      news_ttl_minutes: getAnalysisReuseTtlMinutes(ANALYST_TYPES.NEWS),
      reuse_result_shape: true,
    }));
  } finally {
    if (oldSentiment == null) delete process.env.LUNA_SENTIMENT_REUSE_TTL_MINUTES;
    else process.env.LUNA_SENTIMENT_REUSE_TTL_MINUTES = oldSentiment;
    if (oldNews == null) delete process.env.LUNA_NEWS_REUSE_TTL_MINUTES;
    else process.env.LUNA_NEWS_REUSE_TTL_MINUTES = oldNews;
  }
}

main();

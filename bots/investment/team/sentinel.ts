// @ts-nocheck
/**
 * team/sentinel.js — 센티널 (외부 정보 감시관)
 *
 * 역할:
 *   - 최신 뉴스/감성 수집기의 통합 오케스트레이터
 *   - source tier / source breakdown / quality 상태를 함께 반환
 *   - 의사결정단이 "무엇이 본류 정보이고 무엇이 보조 정보인지" 해석할 수 있게 함
 */

import { analyzeNews } from './hermes.ts';
import { analyzeSentiment, combineSentiment } from './sophia.ts';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';

const SOURCE_TIERS = Object.freeze({
  news: 'tier2',
  community: 'tier3',
  fearGreed: 'tier2',
});

const TIER_WEIGHTS = Object.freeze({
  tier1: 0.0,
  tier2: 0.65,
  tier3: 0.35,
});

function scoreFromSignal(signal, confidence = 0) {
  if (signal === ACTIONS.BUY) return confidence;
  if (signal === ACTIONS.SELL) return -confidence;
  return 0;
}

export function combineSentinelResult(community = {}, news = {}) {
  const communityScore = scoreFromSignal(community.signal, community.confidence);
  const newsScore = scoreFromSignal(news.signal, news.confidence);
  const fearGreed = community.fearGreed ?? community.metadata?.fearGreed ?? null;
  const { combined, fgNorm, label } = combineSentiment(communityScore, fearGreed, newsScore);

  const signal = combined >= 0.2 ? ACTIONS.BUY : combined <= -0.2 ? ACTIONS.SELL : ACTIONS.HOLD;
  const confidence = Math.max(
    0.1,
    Math.min(
      0.95,
      Number(((Math.abs(combined) * 0.6) + ((community.confidence ?? 0) * 0.2) + ((news.confidence ?? 0) * 0.2)).toFixed(2)),
    ),
  );

  return {
    signal,
    confidence,
    reasoning: `커뮤니티·뉴스 통합 감성 ${label} (${combined.toFixed(2)})`,
    sentiment: label,
    combinedScore: combined,
    metadata: {
      sourceTierWeights: TIER_WEIGHTS,
      community: {
        signal: community.signal ?? ACTIONS.HOLD,
        confidence: community.confidence ?? 0,
        sentiment: community.sentiment ?? null,
        tier: SOURCE_TIERS.community,
      },
      news: {
        signal: news.signal ?? ACTIONS.HOLD,
        confidence: news.confidence ?? 0,
        sentiment: news.sentiment ?? null,
        tier: SOURCE_TIERS.news,
      },
      fearGreedNormalized: fgNorm,
      sourceBreakdown: {
        community: {
          available: Boolean(community?.signal),
          confidence: community.confidence ?? 0,
          signal: community.signal ?? ACTIONS.HOLD,
          tier: SOURCE_TIERS.community,
        },
        news: {
          available: Boolean(news?.signal),
          confidence: news.confidence ?? 0,
          signal: news.signal ?? ACTIONS.HOLD,
          tier: SOURCE_TIERS.news,
        },
        fearGreed: {
          available: fearGreed != null,
          normalized: fgNorm,
          tier: SOURCE_TIERS.fearGreed,
        },
      },
    },
  };
}

function buildSentinelQuality({ community = null, news = null, errors = [] } = {}) {
  const successCount = Number(Boolean(community)) + Number(Boolean(news));
  const status = successCount >= 2 ? 'ready' : successCount === 1 ? 'degraded' : 'insufficient';

  return {
    status,
    successCount,
    failedCount: Array.isArray(errors) ? errors.length : 0,
    partialFallback: successCount === 1,
    sources: {
      news: Boolean(news),
      community: Boolean(community),
    },
  };
}

export async function analyze(symbol = 'BTC/USDT', exchange = 'binance') {
  const [communityResult, newsResult] = await Promise.allSettled([
    analyzeSentiment(symbol, exchange),
    analyzeNews(symbol, exchange),
  ]);

  const errors = [];
  const community = communityResult.status === 'fulfilled'
    ? communityResult.value
    : null;
  const news = newsResult.status === 'fulfilled'
    ? newsResult.value
    : null;

  if (communityResult.status === 'rejected') {
    errors.push({
      source: 'sentiment',
      message: communityResult.reason?.message || String(communityResult.reason || 'unknown sentiment error'),
    });
  }

  if (newsResult.status === 'rejected') {
    errors.push({
      source: 'news',
      message: newsResult.reason?.message || String(newsResult.reason || 'unknown news error'),
    });
  }

  if (!community && !news) {
    const detail = errors.map((item) => `${item.source}: ${item.message}`).join(' | ');
    throw new Error(`sentinel collectors failed (${detail || 'unknown'})`);
  }

  const combined = combineSentinelResult(community || {}, news || {});
  const quality = buildSentinelQuality({ community, news, errors });
  const sourceBreakdown = {
    news: {
      ok: Boolean(news),
      analyst: 'hermes',
      signal: news?.signal ?? ACTIONS.HOLD,
      confidence: Number(news?.confidence || 0),
      tier: SOURCE_TIERS.news,
    },
    community: {
      ok: Boolean(community),
      analyst: 'sophia',
      signal: community?.signal ?? ACTIONS.HOLD,
      confidence: Number(community?.confidence || 0),
      tier: SOURCE_TIERS.community,
    },
  };
  return {
    symbol,
    analyst: ANALYST_TYPES.SENTINEL,
    partialFallback: errors.length > 0,
    errors,
    quality,
    ...combined,
    reasoning: `${combined.reasoning}${quality.status === 'degraded' ? ' | 부분 수집 폴백 반영' : ''}`,
    metadata: {
      ...(combined.metadata || {}),
      quality,
      sourceBreakdown,
      sourceTierWeights: TIER_WEIGHTS,
    },
  };
}

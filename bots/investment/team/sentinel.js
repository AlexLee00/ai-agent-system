/**
 * team/sentinel.js — 센티널 (외부 정보 감시관)
 *
 * 역할: 커뮤니티 감성 + 뉴스 분석 통합
 * 이전: sophia.js (커뮤니티) + hermes.js (뉴스) 통합
 */

import { analyzeNews } from './hermes.js';
import { analyzeSentiment, combineSentiment } from './sophia.js';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.js';

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
      community: {
        signal: community.signal ?? ACTIONS.HOLD,
        confidence: community.confidence ?? 0,
        sentiment: community.sentiment ?? null,
      },
      news: {
        signal: news.signal ?? ACTIONS.HOLD,
        confidence: news.confidence ?? 0,
        sentiment: news.sentiment ?? null,
      },
      fearGreedNormalized: fgNorm,
    },
  };
}

export async function analyze(symbol = 'BTC/USDT', exchange = 'binance') {
  const [community, news] = await Promise.all([
    analyzeSentiment(symbol, exchange),
    analyzeNews(symbol, exchange),
  ]);

  const combined = combineSentinelResult(community, news);
  return {
    symbol,
    analyst: ANALYST_TYPES.SENTINEL,
    ...combined,
  };
}


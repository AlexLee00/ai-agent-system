/**
 * team/argos.js — 아르고스 (외부 전략 수집봇)
 *
 * 역할: Reddit r/algotrading + r/CryptoCurrency 인기 포스트 수집
 *       → LLM 품질 평가 → strategy_pool DB 저장 → 텔레그램 리포트
 * LLM: Groq Scout (무료, 항상)
 * 주기: 6시간 (launchd: ai.investment.argos)
 *
 * 실행: node team/argos.js
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { sendTelegram } from '../shared/report.js';

const SUBREDDITS = [
  { name: 'algotrading',    market: 'all',    limit: 10 },
  { name: 'CryptoCurrency', market: 'crypto', limit: 8 },
  { name: 'stocks',         market: 'stocks', limit: 6 },
];

const MIN_QUALITY_SCORE = 0.5;  // 이 이상만 DB 저장

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const ARGOS_SYSTEM = `당신은 아르고스(Argos), 루나팀의 전략 수집봇이다.
Reddit 인기 트레이딩 포스트에서 실제 매매에 활용할 수 있는 전략을 추출하고 평가한다.

평가 기준:
- 구체적인 진입/청산 조건이 있는가? (기본 0~0.4점)
- 리스크 관리 방법이 명시되어 있는가? (+0.2)
- 실거래 적용 가능성이 높은가? (+0.2)
- 최신 시장 상황에 맞는가? (+0.2)

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "strategy_name": "전략 이름 (영어, 30자 이내)",
  "entry_condition": "진입 조건 (한국어, 100자 이내)",
  "exit_condition": "청산 조건 (한국어, 100자 이내)",
  "risk_management": "리스크 관리 (한국어, 80자 이내)",
  "applicable_timeframe": "1h|4h|1d|all",
  "quality_score": 0.0~1.0,
  "summary": "한줄 요약 (한국어, 80자 이내)",
  "applicable_now": true|false
}

전략이 아닌 잡담·뉴스·홍보 포스트이면 quality_score를 0으로 설정.`.trim();

// ─── Reddit 수집 ────────────────────────────────────────────────────

async function fetchRedditPosts(subreddit, limit = 10) {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?limit=${limit}&t=day`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'luna-argos/1.0 (investment bot)' },
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data?.children || [])
      .map(c => c.data)
      .filter(p => p.score >= 20 && !p.stickied);
  } catch (e) {
    console.warn(`  ⚠️ [아르고스] r/${subreddit} 수집 실패: ${e.message}`);
    return [];
  }
}

// ─── LLM 품질 평가 ──────────────────────────────────────────────────

async function evaluatePost(post, market) {
  const userMsg = [
    `제목: ${post.title}`,
    `내용: ${(post.selftext || '').slice(0, 800)}`,
    `좋아요: ${post.score} | 댓글: ${post.num_comments}`,
    ``,
    `이 포스트에서 트레이딩 전략을 추출하고 평가하시오.`,
  ].join('\n');

  const raw    = await callLLM('argos', ARGOS_SYSTEM, userMsg, 512);
  const parsed = parseJSON(raw);
  if (!parsed?.strategy_name) return null;

  return {
    ...parsed,
    market,
    source:     'reddit',
    source_url: `https://reddit.com${post.permalink}`,
  };
}

// ─── 메인 수집 함수 ──────────────────────────────────────────────────

export async function collectStrategies() {
  console.log('\n👁️ [아르고스] 외부 전략 수집 시작');

  let saved     = 0;
  const summary = [];

  for (const { name, market, limit } of SUBREDDITS) {
    console.log(`  📡 r/${name} 수집 중...`);
    const posts = await fetchRedditPosts(name, limit);
    console.log(`  → ${posts.length}개 포스트 (score≥20)`);

    for (const post of posts.slice(0, 5)) {
      try {
        const strategy = await evaluatePost(post, market);
        if (!strategy || strategy.quality_score < MIN_QUALITY_SCORE) continue;

        await db.upsertStrategy(strategy);
        saved++;
        summary.push(`• [${(strategy.quality_score * 10).toFixed(0)}점] ${strategy.strategy_name}: ${strategy.summary}`);
        console.log(`  ✅ 저장: ${strategy.strategy_name} (점수: ${strategy.quality_score.toFixed(2)})`);
      } catch (e) {
        console.warn(`  ⚠️ [아르고스] 평가 실패: ${e.message}`);
      }
    }
  }

  console.log(`\n✅ [아르고스] ${saved}개 전략 저장 완료`);

  if (saved > 0) {
    const msg = [
      `👁️ *아르고스 전략 수집 완료*`,
      `수집: ${saved}개 (품질 ${MIN_QUALITY_SCORE} 이상)`,
      '',
      ...summary.slice(0, 5),
    ].join('\n');
    await sendTelegram(msg).catch(() => {});
  }

  return saved;
}

export async function recommendStrategy(symbol, exchange = 'binance') {
  const market     = exchange === 'binance' ? 'crypto' : exchange === 'kis' ? 'stocks' : 'all';
  const strategies = await db.getActiveStrategies(market, 3);
  if (strategies.length === 0) return null;
  console.log(`  👁️ [아르고스] ${symbol} 추천 전략: ${strategies[0].strategy_name}`);
  return strategies[0];
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await db.initSchema();
  try {
    const count = await collectStrategies();
    console.log(`\n결과: ${count}개 전략`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 아르고스 오류:', e.message);
    process.exit(1);
  }
}

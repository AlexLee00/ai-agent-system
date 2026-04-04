'use strict';

/**
 * 다윈팀 자율 연구 스캐너
 */

const arxivClient = require('./arxiv-client');
const hfClient = require('./hf-papers-client');
const evaluator = require('./research-evaluator');
const rag = require('../../../../packages/core/lib/rag');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const kst = require('../../../../packages/core/lib/kst');

const ACTIVE_DOMAINS = ['neuron', 'gold-r', 'ink'];
const MAX_EVALUATIONS_PER_RUN = 30;
const EVALUATION_DELAY_MS = 1_000;
const DURATION_WARNING_THRESHOLD_SEC = 300;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _dedupePapers(papers) {
  const seen = new Set();
  const unique = [];

  for (const paper of papers) {
    const key = String(paper.arxiv_id || paper.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(paper);
  }

  return unique;
}

async function _collectPapers() {
  const arxivResults = [];
  for (const domain of ACTIVE_DOMAINS) {
    const papers = await arxivClient.searchByDomain(domain, 20);
    arxivResults.push(...papers);
    console.log(`[research-scanner] arXiv ${domain}: ${papers.length}건`);
  }

  const trending = await hfClient.fetchTrending();
  console.log(`[research-scanner] HF 트렌딩: ${trending.length}건`);

  const keywordPapers = [];
  for (const keyword of hfClient.HF_KEYWORDS.slice(0, 3)) {
    const papers = await hfClient.searchByKeyword(keyword);
    keywordPapers.push(...papers);
    console.log(`[research-scanner] HF 검색 ${keyword}: ${papers.length}건`);
  }

  return [...arxivResults, ...trending, ...keywordPapers];
}

async function _storeEvaluatedPapers(evaluated) {
  let storedCount = 0;

  for (const paper of evaluated) {
    try {
      await rag.store(
        'research',
        `${paper.title}\n${paper.korean_summary}`,
        {
          arxiv_id: paper.arxiv_id,
          domain: paper.domain,
          source: paper.source,
          relevance_score: paper.relevance_score,
          reason: paper.reason,
          upvotes: paper.upvotes || 0,
          authors: paper.authors || '',
          published: paper.published,
          keyword: paper.keyword || '',
          scanned_at: new Date().toISOString(),
        },
        'research-scanner'
      );
      storedCount += 1;
    } catch (err) {
      console.warn(`[research-scanner] 저장 실패 (${paper.arxiv_id}): ${err.message}`);
    }
  }

  return storedCount;
}

async function _alertHighRelevance(uniqueCount, evaluated, storedCount, startTime) {
  const highRelevance = evaluated.filter((paper) => paper.relevance_score >= 7);
  if (highRelevance.length === 0) return { highRelevanceCount: 0, alarmSent: false };

  const lines = [
    `🔬 다윈팀 일일 리서치 (${kst.today()})`,
    `수집: ${uniqueCount}건 | 평가: ${evaluated.length}건 | 저장: ${storedCount}건`,
    '',
    `⭐ 적합성 7점+ 논문 ${highRelevance.length}건:`,
  ];

  highRelevance.forEach((paper, index) => {
    lines.push(`${index + 1}. [${paper.relevance_score}점] ${paper.korean_summary}`);
    lines.push(`   ${paper.title.slice(0, 80)}`);
    lines.push(`   https://arxiv.org/abs/${paper.arxiv_id}`);
  });

  lines.push('', `소요: ${Math.round((Date.now() - startTime) / 1000)}초`);

  const alarmResult = await postAlarm({
    message: lines.join('\n'),
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
  });
  const alarmSent = alarmResult?.ok === true;
  if (!alarmSent) {
    console.warn('[research-scanner] 텔레그램 알림 전달 실패');
  }

  return { highRelevanceCount: highRelevance.length, alarmSent };
}

async function _generateWeeklyReport(papers) {
  const topPapers = papers
    .filter((paper) => paper.relevance_score >= 5)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 10);

  if (topPapers.length === 0) return;

  const lines = [`📊 다윈팀 주간 리서치 리포트 (${kst.today()})`];
  lines.push(`이번 주 평가: ${papers.length}건 | 적합성 5점+: ${topPapers.length}건`);
  lines.push('');
  topPapers.forEach((paper, index) => {
    lines.push(`${index + 1}. [${paper.relevance_score}점] ${paper.korean_summary}`);
  });

  await postAlarm({
    message: lines.join('\n'),
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
  });
}

async function run() {
  const startTime = Date.now();
  console.log(`[research-scanner] 시작: ${kst.datetimeStr()}`);
  await rag.initSchema();

  const allPapers = await _collectPapers();
  const unique = _dedupePapers(allPapers);
  console.log(`[research-scanner] 중복 제거 후: ${unique.length}건 (전체 ${allPapers.length}건)`);

  const evaluated = [];
  for (const paper of unique.slice(0, MAX_EVALUATIONS_PER_RUN)) {
    const evaluation = await evaluator.evaluatePaper(paper);
    evaluated.push({ ...paper, ...evaluation });
    await _sleep(EVALUATION_DELAY_MS);
  }

  const storedCount = await _storeEvaluatedPapers(evaluated);
  const { highRelevanceCount, alarmSent } = await _alertHighRelevance(unique.length, evaluated, storedCount, startTime);

  if (new Date().getDay() === 0) {
    await _generateWeeklyReport(evaluated);
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  if (durationSec > DURATION_WARNING_THRESHOLD_SEC) {
    console.warn(`[research-scanner] 실행 시간 경고: ${durationSec}초 (기준 ${DURATION_WARNING_THRESHOLD_SEC}초 초과)`);
  }
  console.log(`[research-scanner] 완료: ${storedCount}건 저장, ${highRelevanceCount}건 후보 알림, 전달=${alarmSent ? '성공' : '실패/없음'}, ${durationSec}초`);

  return {
    total: unique.length,
    evaluated: evaluated.length,
    stored: storedCount,
    highRelevance: highRelevanceCount,
    alarmSent,
    durationSec,
  };
}

module.exports = {
  run,
  ACTIVE_DOMAINS,
};

if (require.main === module) {
  run()
    .then((result) => {
      console.log('결과:', JSON.stringify(result));
      if (result.total === 0) {
        console.error('[research-scanner] 수집 0건 — 네트워크 장애 가능!');
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('실패:', err.message);
      process.exit(1);
    });
}

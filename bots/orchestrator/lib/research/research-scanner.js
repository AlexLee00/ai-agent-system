'use strict';

/**
 * 다윈팀 자율 연구 스캐너
 */

const arxivClient = require('./arxiv-client');
const hfClient = require('./hf-papers-client');
const evaluator = require('./research-evaluator');
const applicator = require('./applicator');
const keywordEvolver = require('./keyword-evolver');
const monitor = require('./research-monitor');
const researchTasks = require('./research-tasks');
const githubClient = require('../../../../packages/core/lib/github-client');
const { createLogger } = require('../../../../packages/core/lib/central-logger');
const {
  analyzeRepoStructure,
  extractCodePatterns,
  generateAnalysisSummary,
} = require('../../../../packages/core/lib/skills/darwin/github-analysis');
const rag = require('../../../../packages/core/lib/rag');
const hiringContract = require('../../../../packages/core/lib/hiring-contract');
const registry = require('../../../../packages/core/lib/agent-registry');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const kst = require('../../../../packages/core/lib/kst');

const MAX_EVALUATIONS_PER_RUN = 40;
const EVALUATION_DELAY_MS = 1_000;
const DURATION_WARNING_THRESHOLD_SEC = 300;
const DOMAIN_DELAY_MS = 3_000;
const ARXIV_RESULTS_PER_DOMAIN = 10;
const SCHEMA = 'reservation';
const TABLE = 'rag_research';
const MAX_DAILY_PROPOSALS = 2;
const AUTO_TASK_MIN_STARS = 100;
const AUTO_TASK_MIN_FILES = 20;
const MAX_WEEKLY_TASKS = 3;
const logger = createLogger('scanner', { team: 'darwin' });

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _extractGitHubRepo(paper) {
  const text = [
    paper?.summary,
    paper?.korean_summary,
    paper?.title,
    paper?.reason,
    paper?.url,
    paper?.source_url,
  ].filter(Boolean).join(' ');

  const match = text.match(/github\.com\/([^/\s)"']+)\/([^/\s)"'.]+)/i);
  if (!match) return null;

  return {
    owner: String(match[1] || '').trim(),
    repo: String(match[2] || '').trim().replace(/\.git$/i, ''),
  };
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

function _safeTaskId(prefix, paper, owner, repo) {
  const paperPart = String(paper?.arxiv_id || paper?.title || Date.now())
    .trim()
    .replace(/[^a-z0-9_-]/gi, '-')
    .slice(0, 80);
  return `${prefix}-${paperPart}-${String(owner || '').replace(/[^a-z0-9_-]/gi, '-')}-${String(repo || '').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function _maybeCreateGitHubTask(paper, github, source) {
  const owner = String(github?.owner || '').trim();
  const repo = String(github?.repo || '').trim();
  const stars = Number(github?.stars || 0);
  const files = Number(github?.files || 0);

  if (!owner || !repo) return null;
  if (stars < AUTO_TASK_MIN_STARS || files < AUTO_TASK_MIN_FILES) return null;
  if (researchTasks.hasTaskForRepo(owner, repo, ['github_analysis'])) return null;

  return researchTasks.createTask({
    id: _safeTaskId('GH', paper, owner, repo),
    title: `${owner}/${repo} 심층 GitHub 분석`,
    type: 'github_analysis',
    target: { owner, repo },
    description: `${source}에서 발견한 고적합 논문 관련 저장소 심층 분석`,
    assignee: 'pipe',
    priority: 2,
    sourcePaper: {
      arxiv_id: paper?.arxiv_id || '',
      title: paper?.title || '',
      relevance_score: Number(paper?.relevance_score || 0),
      domain: paper?.domain || '',
    },
    source,
  });
}

async function _selectSearchers() {
  const domains = Object.keys(arxivClient.DOMAIN_KEYWORDS);
  let teamAgents = [];

  try {
    teamAgents = await registry.getAgentsByTeam('darwin');
  } catch (err) {
    console.warn(`[research-scanner] 다윈 agent registry 조회 실패: ${err.message}`);
  }

  const selected = [];

  for (const domain of domains) {
    const exactMatch = teamAgents.find((agent) => {
      const agentName = String(agent?.name || '').trim().toLowerCase();
      return agentName === String(domain).trim().toLowerCase()
        && !selected.some((item) => item.name === agent.name);
    });

    if (exactMatch) {
      selected.push({
        name: exactMatch.name,
        domain,
        score: Number(exactMatch.score || 0),
        hired: true,
        exact: true,
      });
      continue;
    }

    try {
      const best = await hiringContract.selectBestAgent('searcher', 'darwin', {
        taskHint: domain,
        excludeNames: selected.map((item) => item.name),
        mode: 'balanced',
      });
      if (best) {
        selected.push({ name: best.name, domain, score: Number(best.score || 0), hired: true, exact: false });
        continue;
      }
    } catch (err) {
      console.warn(`[research-scanner] searcher 고용 실패 (${domain}): ${err.message}`);
    }
    selected.push({ name: domain, domain, score: 0, hired: false, exact: false });
  }

  logger.info(`고용된 searcher: ${selected.map((item) => `${item.name}(${item.domain})`).join(', ')}`);
  return selected;
}

async function _collectPapers(searchers) {
  const arxivResults = [];
  for (const { name, domain } of searchers) {
    const papers = await arxivClient.searchByDomain(domain, ARXIV_RESULTS_PER_DOMAIN);
    arxivResults.push(...papers);
    logger.info(`${name}→arXiv ${domain}: ${papers.length}건`);
    await _sleep(DOMAIN_DELAY_MS);
  }

  const trending = await hfClient.fetchTrending();
  logger.info(`HF 트렌딩: ${trending.length}건`);

  const keywordPapers = [];
  for (const keyword of hfClient.HF_KEYWORDS.slice(0, 3)) {
    const papers = await hfClient.searchByKeyword(keyword);
    keywordPapers.push(...papers);
    logger.info(`HF 검색 ${keyword}: ${papers.length}건`);
  }

  return [...arxivResults, ...trending, ...keywordPapers];
}

async function _enrichWithGitHub(evaluated) {
  let enriched = 0;
  let tasksRegistered = 0;

  for (const paper of evaluated) {
    if (Number(paper?.relevance_score || 0) < 7) continue;
    if (paper.github) continue;

    const repoRef = _extractGitHubRepo(paper);
    if (!repoRef) continue;

    const owner = repoRef.owner;
    const repoName = repoRef.repo;

    try {
      console.log(`[research-scanner] GitHub 분석: ${owner}/${repoName}`);

      const repoInfo = await githubClient.getRepoInfo(owner, repoName);
      const tree = await githubClient.getTree(owner, repoName, repoInfo.default_branch);
      const structure = analyzeRepoStructure({ tree });

      const topFiles = (structure.keyFiles || [])
        .filter((file) => /\.(js|py|ts|go|rs)$/.test(file.path))
        .slice(0, 3);

      const fileContents = await githubClient.readFiles(
        owner,
        repoName,
        topFiles.map((file) => file.path),
        repoInfo.default_branch,
        200
      );

      const codePatterns = fileContents
        .filter((file) => !file.error)
        .map((file) => extractCodePatterns(file));

      const { summary } = generateAnalysisSummary({ repoInfo, structure, codePatterns });

      paper.github = {
        owner,
        repo: repoName,
        stars: Number(repoInfo.stars || 0),
        language: repoInfo.language || '',
        files: Number(structure.summary?.totalFiles || 0),
        summary,
      };

      const task = _maybeCreateGitHubTask(paper, paper.github, 'scanner_github_enrichment');
      if (task) {
        tasksRegistered += 1;
        console.log(`[research-scanner] 연구 과제 자동 등록: ${task.id} (${owner}/${repoName})`);
      }

      enriched += 1;
      console.log(`[research-scanner] GitHub 분석 완료: ${owner}/${repoName} (⭐${repoInfo.stars || 0})`);
      await _sleep(2_000);
    } catch (err) {
      console.warn(`[research-scanner] GitHub 분석 실패 (${owner}/${repoName}): ${err.message}`);
    }
  }

  return { githubEnriched: enriched, tasksRegistered };
}

async function _storeExperienceIfNeeded(paper) {
  if ((paper.relevance_score || 0) < 7) return false;
  try {
    await rag.storeExperience({
      userInput: `arXiv 논문 발견: ${paper.title}`,
      intent: 'research_discovery',
      response: paper.korean_summary,
      result: 'success',
      why: `적합성 ${paper.relevance_score}점, 도메인 ${paper.domain || 'unknown'}`,
      sourceBot: 'research-scanner',
      details: {
        arxiv_id: paper.arxiv_id,
        domain: paper.domain,
        relevance_score: paper.relevance_score,
      },
      team: 'darwin',
    });
    return true;
  } catch (err) {
    console.warn(`[research-scanner] 경험 저장 실패 (${paper.arxiv_id}): ${err.message}`);
    return false;
  }
}

async function _storeEvaluatedPapers(evaluated) {
  let storedCount = 0;
  let experienceCount = 0;

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
          github_repo: paper.github ? `${paper.github.owner}/${paper.github.repo}` : '',
          github_stars: Number(paper.github?.stars || 0),
          scanned_at: new Date().toISOString(),
        },
        'research-scanner'
      );
      storedCount += 1;
      if (await _storeExperienceIfNeeded(paper)) {
        experienceCount += 1;
      }
    } catch (err) {
      console.warn(`[research-scanner] 저장 실패 (${paper.arxiv_id}): ${err.message}`);
    }
  }

  return { storedCount, experienceCount };
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

async function _loadWeeklyResearchRows() {
  return pgPool.query(SCHEMA, `
    SELECT content, metadata, created_at
    FROM ${SCHEMA}.${TABLE}
    WHERE created_at >= now() - interval '7 days'
      AND COALESCE(metadata->>'type', '') != 'daily_metrics'
    ORDER BY created_at DESC
    LIMIT 200
  `, []);
}

function _extractWeeklyRepo(row) {
  const repoValue = String(row?.metadata?.github_repo || '').trim();
  if (repoValue.includes('/')) {
    const [owner, repo] = repoValue.split('/');
    if (owner && repo) {
      return { owner: owner.trim(), repo: repo.trim().replace(/\.git$/i, '') };
    }
  }

  const extracted = _extractGitHubRepo({
    summary: row?.content,
    title: row?.metadata?.title,
    reason: row?.metadata?.reason,
  });
  return extracted;
}

function _registerWeeklyResearchTasks(weekData) {
  let tasksRegistered = 0;
  const candidates = weekData
    .filter((row) => Number(row?.metadata?.relevance_score || 0) >= 8)
    .sort((a, b) => Number(b?.metadata?.relevance_score || 0) - Number(a?.metadata?.relevance_score || 0));

  for (const row of candidates) {
    if (tasksRegistered >= MAX_WEEKLY_TASKS) break;

    const repoRef = _extractWeeklyRepo(row);
    if (!repoRef) continue;
    if (researchTasks.hasTaskForRepo(repoRef.owner, repoRef.repo, ['github_analysis'])) continue;

    const task = researchTasks.createTask({
      id: _safeTaskId('WEEKLY-GH', row?.metadata || {}, repoRef.owner, repoRef.repo),
      title: `${repoRef.owner}/${repoRef.repo} 주간 트렌드 GitHub 분석`,
      type: 'github_analysis',
      target: { owner: repoRef.owner, repo: repoRef.repo },
      description: '주간 리서치 8점+ 논문과 연결된 GitHub 저장소 심층 분석',
      assignee: 'pipe',
      priority: 2,
      source: 'weekly_research_report',
      sourcePaper: {
        arxiv_id: row?.metadata?.arxiv_id || '',
        title: String(row?.content || '').split('\n')[0] || '',
        relevance_score: Number(row?.metadata?.relevance_score || 0),
        domain: row?.metadata?.domain || '',
      },
    });

    tasksRegistered += 1;
    console.log(`[research-scanner] 주간 연구 과제 등록: ${task.id} (${repoRef.owner}/${repoRef.repo})`);
  }

  return tasksRegistered;
}

async function _generateWeeklyReport() {
  const weekData = await _loadWeeklyResearchRows();
  if (!weekData || weekData.length === 0) return { report: '', keywordEvolutionCount: 0, tasksRegistered: 0 };

  const sevenPlus = weekData.filter((row) => Number(row.metadata?.relevance_score || 0) >= 7).length;
  const fiveToSix = weekData.filter((row) => {
    const score = Number(row.metadata?.relevance_score || 0);
    return score >= 5 && score < 7;
  }).length;

  const lines = [
    '# 🔬 다윈팀 주간 리서치 리포트',
    `> ${kst.today()} (자동 생성)`,
    '',
    '## 수집 현황',
    `- 총 수집: ${weekData.length}건`,
    `- 적합성 7점+: ${sevenPlus}건`,
    `- 적합성 5~6점: ${fiveToSix}건`,
    '',
    '## 도메인별 현황',
  ];

  const byDomain = {};
  for (const row of weekData) {
    const domain = row.metadata?.domain || 'unknown';
    if (!byDomain[domain]) byDomain[domain] = { total: 0, high: 0 };
    byDomain[domain].total += 1;
    if (Number(row.metadata?.relevance_score || 0) >= 7) byDomain[domain].high += 1;
  }
  for (const [domain, stats] of Object.entries(byDomain).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`- ${domain}: ${stats.total}건 (7점+: ${stats.high}건)`);
  }

  lines.push('', '## TOP 10 논문');
  const topPapers = weekData
    .filter((row) => Number(row.metadata?.relevance_score || 0) >= 5)
    .sort((a, b) => Number(b.metadata?.relevance_score || 0) - Number(a.metadata?.relevance_score || 0))
    .slice(0, 10);
  topPapers.forEach((paper, index) => {
    lines.push(`${index + 1}. [${paper.metadata?.relevance_score}점] ${String(paper.content || '').split('\n')[0]}`);
    if (paper.metadata?.arxiv_id) {
      lines.push(`   https://arxiv.org/abs/${paper.metadata.arxiv_id}`);
    }
  });

  lines.push('', '## 키워드 진화');
  let keywordEvolutionCount = 0;
  const activeDomains = Object.entries(byDomain)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([domain]) => domain);

  const keywordSuggestions = await Promise.all(
    activeDomains.map(async (domain) => {
      const suggested = await keywordEvolver.suggestKeywords(domain);
      return { domain, suggested };
    })
  );

  for (const { domain, suggested } of keywordSuggestions) {
    if (suggested.length > 0) {
      keywordEvolutionCount += suggested.length;
      lines.push(`📈 ${domain}: ${suggested.join(', ')}`);
    }
  }

  const tasksRegistered = _registerWeeklyResearchTasks(weekData);
  if (tasksRegistered > 0) {
    lines.push('', '## 자동 등록 과제', `- GitHub 심층 분석 과제 ${tasksRegistered}건 등록`);
  }

  const trendText = await monitor.weeklyTrend();
  if (trendText) {
    lines.push('', '## 모니터링 추세', trendText);
  }

  const report = lines.join('\n');
  await postAlarm({
    message: report.slice(0, 4000),
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
  });

  return { report, keywordEvolutionCount, tasksRegistered };
}

async function run() {
  const startTime = Date.now();
  console.log(`[research-scanner] 시작: ${kst.datetimeStr()}`);
  await rag.initSchema();

  const searchers = await _selectSearchers();
  const allPapers = await _collectPapers(searchers);
  const unique = _dedupePapers(allPapers);
  console.log(`[research-scanner] 중복 제거 후: ${unique.length}건 (전체 ${allPapers.length}건)`);

  const evaluated = [];
  let evaluationFailures = 0;
  for (const paper of unique.slice(0, MAX_EVALUATIONS_PER_RUN)) {
    const evaluation = await evaluator.evaluatePaper(paper);
    evaluated.push({ ...paper, ...evaluation });
    if (evaluation.reason === '평가 실패') {
      evaluationFailures += 1;
    }
    await _sleep(EVALUATION_DELAY_MS);
  }

  const enrichment = await _enrichWithGitHub(evaluated);
  const { storedCount, experienceCount } = await _storeEvaluatedPapers(evaluated);
  const { highRelevanceCount, alarmSent } = await _alertHighRelevance(unique.length, evaluated, storedCount, startTime);
  const highRelevance = evaluated.filter((paper) => paper.relevance_score >= 7);
  const proposalCandidates = [...highRelevance]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, MAX_DAILY_PROPOSALS);
  const proposalResults = [];
  for (const paper of proposalCandidates) {
    try {
      const applied = await applicator.apply(paper);
      proposalResults.push({ arxiv_id: paper.arxiv_id, ...applied });
      await _sleep(3_000);
    } catch (err) {
      console.warn(`[research-scanner] 적용 파이프라인 실패 (${paper.arxiv_id}): ${err.message}`);
    }
  }
  const proposalCount = proposalResults.filter((item) => item.proposal).length;
  const verifiedCount = proposalResults.filter((item) => item.verification?.passed).length;
  let keywordEvolutionCount = 0;
  let weeklyTasksRegistered = 0;

  if (new Date().getDay() === 0) {
    const weekly = await _generateWeeklyReport();
    keywordEvolutionCount = Number(weekly?.keywordEvolutionCount || 0);
    weeklyTasksRegistered = Number(weekly?.tasksRegistered || 0);
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  if (durationSec > DURATION_WARNING_THRESHOLD_SEC) {
    console.warn(`[research-scanner] 실행 시간 경고: ${durationSec}초 (기준 ${DURATION_WARNING_THRESHOLD_SEC}초 초과)`);
  }
  const result = {
    totalRaw: allPapers.length,
    total: unique.length,
    evaluated: evaluated.length,
    stored: storedCount,
    experiencesStored: experienceCount,
    highRelevance: highRelevanceCount,
    alarmSent,
    evaluationFailures,
    githubAnalyzed: Number(enrichment?.githubEnriched || 0),
    tasksRegistered: Number(enrichment?.tasksRegistered || 0) + weeklyTasksRegistered,
    durationSec,
    keywordEvolutionCount,
    proposals: proposalCount,
    verified: verifiedCount,
    searchers: searchers.map(({ name, domain, score, hired }) => ({ name, domain, score, hired })),
  };

  const metrics = monitor.collectMetrics(result, Date.now() - startTime);
  await monitor.storeMetrics(metrics);
  await monitor.checkAnomalies(metrics);
  console.log(`[research-scanner] 메트릭: ${JSON.stringify(metrics)}`);
  console.log(`[research-scanner] 완료: ${storedCount}건 저장, ${experienceCount}건 경험 저장, GitHub 분석 ${result.githubAnalyzed}건, 과제 등록 ${result.tasksRegistered}건, ${highRelevanceCount}건 후보 알림, 제안 ${proposalCount}건/검증통과 ${verifiedCount}건, 전달=${alarmSent ? '성공' : '실패/없음'}, ${durationSec}초`);

  return result;
}

module.exports = {
  run,
  _selectSearchers,
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

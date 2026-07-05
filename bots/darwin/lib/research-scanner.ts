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
const githubClient = require('../../../packages/core/lib/github-client');
const { createLogger } = require('../../../packages/core/lib/central-logger');
const {
  analyzeRepoStructure,
  extractCodePatterns,
  generateAnalysisSummary,
} = require('../../../packages/core/lib/skills/darwin/github-analysis');
const rag = require('../../../packages/core/lib/rag');
const eventLake = require('../../../packages/core/lib/event-lake');
const hiringContract = require('../../../packages/core/lib/hiring-contract');
const registry = require('../../../packages/core/lib/agent-registry');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');
const telemetry = require('./telemetry');

const MAX_EVALUATIONS_PER_RUN = _readPositiveIntEnv('DARWIN_MAX_EVALUATIONS_PER_RUN', 40, { min: 1, max: 100 });
const EVALUATION_CONCURRENCY = _readPositiveIntEnv('DARWIN_EVALUATION_CONCURRENCY', 6, { min: 1, max: 8 });
const DURATION_WARNING_THRESHOLD_SEC = 300;
const ARXIV_DOMAIN_CONCURRENCY = _readPositiveIntEnv('DARWIN_ARXIV_DOMAIN_CONCURRENCY', 2, { min: 1, max: 3 });
const ARXIV_RESULTS_PER_DOMAIN = _readPositiveIntEnv('DARWIN_ARXIV_RESULTS_PER_DOMAIN', 10, { min: 1, max: 50 });
const SCHEMA = 'reservation';
const TABLE = 'rag_research';
const MAX_DAILY_PROPOSALS = 2;
const AUTO_TASK_MIN_STARS = 100;
const AUTO_TASK_MIN_FILES = 20;
const MAX_WEEKLY_TASKS = 3;
const ALARM_RATE_LIMIT_COOLDOWN_MS = _readPositiveIntEnv('DARWIN_ALARM_RATE_LIMIT_COOLDOWN_MS', 15 * 60_000, { min: 1_000, max: 60 * 60_000 });
const logger = createLogger('scanner', { team: 'darwin' });

function _weeklyResearchAlarmMeta(kind = 'weekly_research_report') {
  const date = kst.today();
  const hourBucket = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
  const eventType = kind === 'weekly_research_summary'
    ? 'darwin_weekly_research_summary'
    : 'darwin_weekly_research_report';
  return {
    alarmType: 'report',
    visibility: 'notify',
    actionability: 'none',
    eventType,
    incidentKey: `darwin:research-scanner:${kind}:${date}:${hourBucket}`,
    dedupeMinutes: 45,
  };
}

function _readPositiveIntEnv(name: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;

  const min = Number.isFinite(options.min) ? Number(options.min) : 1;
  const max = Number.isFinite(options.max) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, value));
}

type DomainStats = { total: number; high: number };

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

interface GitHubEnrichment {
  owner: string;
  repo: string;
  stars: number;
  language: string;
  files: number;
  summary: string;
}

interface ResearchPaper {
  arxiv_id?: string;
  title: string;
  summary?: string;
  korean_summary?: string;
  reason?: string;
  url?: string;
  source_url?: string;
  domain?: string;
  source?: string;
  keyword?: string;
  upvotes?: number;
  authors?: string;
  published?: string;
  relevance_score?: number;
  evaluation_failed?: boolean;
  failure_code?: string;
  github?: GitHubEnrichment;
}

interface SearcherSelection {
  name: string;
  domain: string;
  score: number;
  hired: boolean;
  exact: boolean;
}

interface WeeklyResearchRow {
  content?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

interface ScanResult {
  dryRun?: boolean;
  totalRaw: number;
  total: number;
  evaluated: number;
  stored: number;
  experiencesStored: number;
  highRelevance: number;
  alarmSent: boolean;
  alarmFailure?: string;
  alarmBypassed?: boolean;
  evaluationFailures: number;
  githubAnalyzed: number;
  tasksRegistered: number;
  durationSec: number;
  keywordEvolutionCount: number;
  proposals: number;
  verified: number;
  weeklySummaryAlarmSent?: boolean;
  weeklySummaryAlarmFailure?: string;
  registrySynced?: number;
  registrySyncFailures?: number;
  searchers: Array<{
    name: string;
    domain: string;
    score: number;
    hired: boolean;
  }>;
}

interface AlarmPostResult {
  ok?: boolean;
  error?: unknown;
  body?: Record<string, unknown>;
  skipped?: boolean;
  retryAfterMs?: number;
}

interface ProposalApplySummary {
  arxiv_id?: string;
  proposal?: string | null;
  verification?: {
    passed?: boolean;
  } | null;
}

interface RunOptions {
  dryRun?: boolean;
  observeOnly?: boolean;
  maxDomains?: number;
  maxEvaluations?: number;
}

function toErrorMessage(err: unknown): string {
  return typeof err === 'object' && err !== null && 'message' in err
    ? String((err as { message?: unknown }).message || 'unknown error')
    : String(err || 'unknown error');
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isRateLimitError(error: unknown): boolean {
  const text = String(error || '').toLowerCase();
  return /rate[_\s-]?limit|rate[_\s-]?limited|too many requests|429/i.test(text);
}

let _alarmRateLimitCooldownUntil = 0;
let _alarmRateLimitCooldownReason = '';

function _alarmRateLimitRemainingMs(): number {
  return Math.max(0, _alarmRateLimitCooldownUntil - Date.now());
}

function _resetAlarmRateLimitCooldown(): void {
  _alarmRateLimitCooldownUntil = 0;
  _alarmRateLimitCooldownReason = '';
}

function _activateAlarmRateLimitCooldown(reason: unknown): void {
  _alarmRateLimitCooldownUntil = Date.now() + ALARM_RATE_LIMIT_COOLDOWN_MS;
  _alarmRateLimitCooldownReason = String(reason || 'rate_limit');
}

function _alarmFailureReason(result: AlarmPostResult | null | undefined): string {
  return String(
    result?.error
      || result?.body?.delivery_error
      || result?.body?.reason
      || result?.body?.error
      || 'not_delivered'
  ).slice(0, 240);
}

function _postAlarmRetryDelayMs(error: unknown, attempt: number): number {
  if (_isRateLimitError(error)) {
    return Math.min(60_000, 20_000 * attempt);
  }
  return 1000 * attempt;
}

async function _postAlarmWithRetry(payload: Record<string, unknown>, label: string, maxAttempts = 3): Promise<AlarmPostResult | null> {
  const cooldownRemaining = _alarmRateLimitRemainingMs();
  if (cooldownRemaining > 0) {
    console.warn(`[research-scanner] ${label} 알림 rate-limit cooldown: ${Math.ceil(cooldownRemaining / 1000)}초 남음`);
    return {
      ok: false,
      skipped: true,
      error: 'rate_limit_cooldown',
      retryAfterMs: cooldownRemaining,
      body: {
        reason: _alarmRateLimitCooldownReason || 'rate_limit_cooldown',
        retry_after_ms: cooldownRemaining,
      },
    };
  }

  let lastResult: AlarmPostResult | null = null;
  let lastError = 'unknown_error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastResult = await postAlarm({
        message: payload.message || `[darwin research-scanner] ${label}`,
        team: payload.team || 'darwin',
        fromBot: payload.fromBot || 'research-scanner',
        alertLevel: payload.alertLevel || 2,
        alarmType: payload.alarmType || 'work',
        visibility: payload.visibility || 'notify',
        eventType: payload.eventType || label,
        incidentKey: payload.incidentKey || `darwin:research-scanner:${label}`,
        ...payload,
      });
      if (lastResult?.ok === true) {
        _resetAlarmRateLimitCooldown();
        return lastResult;
      }

      lastError = _alarmFailureReason(lastResult);
    } catch (err) {
      lastResult = null;
      lastError = toErrorMessage(err);
    }

    console.warn(`[research-scanner] ${label} 알림 전달 실패 (${attempt}/${maxAttempts}): ${lastError}`);
    if (attempt < maxAttempts) {
      await _sleep(_postAlarmRetryDelayMs(lastError, attempt));
    }
  }

  if (_isRateLimitError(lastError)) {
    _activateAlarmRateLimitCooldown(lastError);
  }

  return lastResult || { ok: false, error: lastError };
}

async function _mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Array.isArray(items) || items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function _extractGitHubRepo(paper: Partial<ResearchPaper>): GitHubRepoRef | null {
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

function _dedupePapers(papers: ResearchPaper[]): ResearchPaper[] {
  const seen = new Set();
  const unique: ResearchPaper[] = [];

  for (const paper of papers) {
    const key = String(paper.arxiv_id || paper.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(paper);
  }

  return unique;
}

function _paperRegistryId(paper: Partial<ResearchPaper>): string {
  const raw = String(
    paper.arxiv_id
    || paper.source_url
    || paper.url
    || paper.title
    || ''
  ).trim();
  return raw || `paper-${Date.now()}`;
}

function _paperAuthors(paper: Partial<ResearchPaper>): string[] {
  const authors = paper.authors;
  if (Array.isArray(authors)) return authors.map((item) => String(item || '').trim()).filter(Boolean);
  return String(authors || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function _paperKeywords(paper: Partial<ResearchPaper>): string[] {
  return [
    paper.keyword,
    paper.domain,
    paper.source,
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

function _stageRank(stage: string): number {
  const stages = ['discovered', 'evaluated', 'planned', 'implemented', 'verified', 'applied', 'measured', 'retired'];
  const index = stages.indexOf(stage);
  return index >= 0 ? index : 0;
}

function _registryStageForPaper(paper: Partial<ResearchPaper>, plannedPaperIds: Set<string>): string {
  const paperId = _paperRegistryId(paper);
  if (plannedPaperIds.has(paperId)) return 'planned';
  if (paper.evaluation_failed === true) return 'discovered';
  return 'evaluated';
}

async function _syncResearchRegistry(
  evaluated: ResearchPaper[],
  proposalResults: ProposalApplySummary[] = []
): Promise<{ synced: number; failures: number }> {
  const plannedPaperIds = new Set(
    proposalResults
      .filter((item) => item?.proposal)
      .map((item) => String(item.arxiv_id || '').trim())
      .filter(Boolean)
  );
  let synced = 0;
  let failures = 0;

  for (const paper of evaluated) {
    const paperId = _paperRegistryId(paper);
    const stage = _registryStageForPaper(paper, plannedPaperIds);
    const metadata = {
      domain: paper.domain || '',
      relevance_score: Number(paper.relevance_score || 0),
      reason: paper.reason || '',
      evaluation_failed: paper.evaluation_failed === true,
      failure_code: paper.failure_code || '',
      github_repo: paper.github ? `${paper.github.owner}/${paper.github.repo}` : '',
      github_stars: Number(paper.github?.stars || 0),
      registry_stage_source: 'research-scanner',
      registry_stage_rank: _stageRank(stage),
      synced_at: new Date().toISOString(),
    };

    try {
      await pgPool.run('public', `
        INSERT INTO public.darwin_research_registry (
          paper_id, title, authors, source, url, discovered_at, stage, keywords, metadata, inserted_at, updated_at
        ) VALUES (
          $1, $2, $3::text[], $4, $5, COALESCE($6::timestamp, NOW()), $7, $8::text[], $9::jsonb, NOW(), NOW()
        )
        ON CONFLICT (paper_id) DO UPDATE SET
          title = EXCLUDED.title,
          authors = CASE WHEN COALESCE(array_length(EXCLUDED.authors, 1), 0) > 0 THEN EXCLUDED.authors ELSE public.darwin_research_registry.authors END,
          source = EXCLUDED.source,
          url = COALESCE(NULLIF(EXCLUDED.url, ''), public.darwin_research_registry.url),
          stage = CASE
            WHEN array_position(ARRAY['discovered','evaluated','planned','implemented','verified','applied','measured','retired'], EXCLUDED.stage)
              >= COALESCE(array_position(ARRAY['discovered','evaluated','planned','implemented','verified','applied','measured','retired'], public.darwin_research_registry.stage), 1)
            THEN EXCLUDED.stage
            ELSE public.darwin_research_registry.stage
          END,
          keywords = CASE WHEN COALESCE(array_length(EXCLUDED.keywords, 1), 0) > 0 THEN EXCLUDED.keywords ELSE public.darwin_research_registry.keywords END,
          metadata = COALESCE(public.darwin_research_registry.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          updated_at = NOW()
      `, [
        paperId,
        String(paper.title || 'Unknown').slice(0, 1000),
        _paperAuthors(paper),
        String(paper.source || 'unknown').slice(0, 50),
        String(paper.url || paper.source_url || (paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : '')).slice(0, 2000),
        paper.published || null,
        stage,
        _paperKeywords(paper),
        JSON.stringify(metadata),
      ]);
      synced += 1;
    } catch (err) {
      failures += 1;
      console.warn(`[research-scanner] registry sync 실패 (${paperId}): ${toErrorMessage(err)}`);
    }
  }

  return { synced, failures };
}

function _safeTaskId(prefix: string, paper: Partial<ResearchPaper>, owner: string, repo: string): string {
  const paperPart = String(paper?.arxiv_id || paper?.title || Date.now())
    .trim()
    .replace(/[^a-z0-9_-]/gi, '-')
    .slice(0, 80);
  return `${prefix}-${paperPart}-${String(owner || '').replace(/[^a-z0-9_-]/gi, '-')}-${String(repo || '').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function _maybeCreateGitHubTask(
  paper: Partial<ResearchPaper>,
  github: Partial<GitHubEnrichment>,
  source: string
) {
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
  let teamAgents: Array<{ name?: string; score?: number }> = [];

  try {
    teamAgents = await registry.getAgentsByTeam('darwin');
  } catch (err) {
    console.warn(`[research-scanner] 다윈 agent registry 조회 실패: ${toErrorMessage(err)}`);
  }

  const selected: SearcherSelection[] = [];

  for (const domain of domains) {
    const exactMatch = teamAgents.find((agent: { name?: string; score?: number }) => {
      const agentName = String(agent?.name || '').trim().toLowerCase();
      return agentName === String(domain).trim().toLowerCase()
        && !selected.some((item) => item.name === agent.name);
    });

    if (exactMatch) {
      selected.push({
        name: String(exactMatch.name || domain),
        domain,
        score: Number(exactMatch.score || 0),
        hired: true,
        exact: true,
      });
      continue;
    }

    try {
      const best: { name: string; score?: number } | null = await hiringContract.selectBestAgent('searcher', 'darwin', {
        taskHint: domain,
        excludeNames: selected.map((item) => item.name),
        mode: 'balanced',
      });
      if (best) {
        selected.push({ name: best.name, domain, score: Number(best.score || 0), hired: true, exact: false });
        continue;
      }
    } catch (err) {
      console.warn(`[research-scanner] searcher 고용 실패 (${domain}): ${toErrorMessage(err)}`);
    }
    selected.push({ name: domain, domain, score: 0, hired: false, exact: false });
  }

  logger.info(`고용된 searcher: ${selected.map((item) => `${item.name}(${item.domain})`).join(', ')}`);
  return selected;
}

async function _collectPapers(searchers: SearcherSelection[]): Promise<ResearchPaper[]> {
  const arxivBatches = await _mapWithConcurrency(
    searchers,
    ARXIV_DOMAIN_CONCURRENCY,
    async ({ name, domain }) => {
      const papers = await arxivClient.searchByDomain(domain, ARXIV_RESULTS_PER_DOMAIN);
      logger.info(`${name}→arXiv ${domain}: ${papers.length}건`);
      return papers;
    }
  );
  const arxivResults = arxivBatches.flat();

  const trending = await hfClient.fetchTrending();
  logger.info(`HF 트렌딩: ${trending.length}건`);

  const keywordPapers: ResearchPaper[] = [];
  for (const keyword of hfClient.HF_KEYWORDS.slice(0, 3)) {
    const papers = await hfClient.searchByKeyword(keyword);
    keywordPapers.push(...papers);
    logger.info(`HF 검색 ${keyword}: ${papers.length}건`);
  }

  return [...arxivResults, ...trending, ...keywordPapers];
}

async function _enrichWithGitHub(evaluated: ResearchPaper[]): Promise<{ githubEnriched: number; tasksRegistered: number }> {
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
        .filter((file: { path: string }) => /\.(js|py|ts|go|rs)$/.test(file.path))
        .slice(0, 3);

      const fileContents = await githubClient.readFiles(
        owner,
        repoName,
        topFiles.map((file: { path: string }) => file.path),
        repoInfo.default_branch,
        200
      );

      const codePatterns = fileContents
        .filter((file: { error?: unknown }) => !file.error)
        .map((file: unknown) => extractCodePatterns(file));

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
      eventLake.record({
        eventType: 'research_github_enriched',
        team: 'darwin',
        botName: 'scanner',
        severity: 'info',
        title: paper.title,
        message: `${owner}/${repoName} GitHub 분석 연결`,
        tags: ['research', 'github', paper.domain || 'unknown'],
        metadata: {
          arxiv_id: paper.arxiv_id || '',
          repo: `${owner}/${repoName}`,
          relevance_score: Number(paper.relevance_score || 0),
          task_registered: !!task,
        },
      }).catch(() => {});

      enriched += 1;
      console.log(`[research-scanner] GitHub 분석 완료: ${owner}/${repoName} (⭐${repoInfo.stars || 0})`);
      await _sleep(500);
    } catch (err) {
      console.warn(`[research-scanner] GitHub 분석 실패 (${owner}/${repoName}): ${toErrorMessage(err)}`);
    }
  }

  return { githubEnriched: enriched, tasksRegistered };
}

async function _storeExperienceIfNeeded(paper: ResearchPaper): Promise<boolean> {
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
    console.warn(`[research-scanner] 경험 저장 실패 (${paper.arxiv_id}): ${toErrorMessage(err)}`);
    return false;
  }
}

async function _storeEvaluatedPapers(evaluated: ResearchPaper[]): Promise<{ storedCount: number; experienceCount: number }> {
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
          evaluation_failed: paper.evaluation_failed === true,
          failure_code: paper.failure_code || '',
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
      console.warn(`[research-scanner] 저장 실패 (${paper.arxiv_id}): ${toErrorMessage(err)}`);
    }
  }

  return { storedCount, experienceCount };
}

async function _alertHighRelevance(
  uniqueCount: number,
  evaluated: ResearchPaper[],
  storedCount: number,
  startTime: number
): Promise<{ highRelevanceCount: number; alarmSent: boolean; alarmFailure: string }> {
  const highRelevance = evaluated.filter((paper) => Number(paper.relevance_score || 0) >= 7);
  if (highRelevance.length === 0) return { highRelevanceCount: 0, alarmSent: false, alarmFailure: '' };

  const lines = [
    `🔬 다윈팀 주간 리서치 (${kst.today()})`,
    `수집: ${uniqueCount}건 | 평가: ${evaluated.length}건 | 저장: ${storedCount}건`,
    '',
    `⭐ 적합성 7점+ 논문 ${highRelevance.length}건:`,
  ];

  highRelevance.forEach((paper: ResearchPaper, index: number) => {
    lines.push(`${index + 1}. [${paper.relevance_score}점] ${paper.korean_summary}`);
    lines.push(`   ${paper.title.slice(0, 80)}`);
    lines.push(`   https://arxiv.org/abs/${paper.arxiv_id}`);
  });

  lines.push('', `소요: ${Math.round((Date.now() - startTime) / 1000)}초`);

  const alarmResult = await _postAlarmWithRetry({
    message: lines.join('\n'),
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
    ..._weeklyResearchAlarmMeta('weekly_research_report'),
    payload: {
      event_type: 'darwin_weekly_research_report',
      report: true,
      high_relevance_count: highRelevance.length,
      collected_count: uniqueCount,
      evaluated_count: evaluated.length,
      stored_count: storedCount,
    },
  }, 'weekly_research_report');
  const alarmSent = alarmResult?.ok === true;
  const alarmFailure = alarmSent ? '' : _alarmFailureReason(alarmResult);
  if (!alarmSent) {
    console.warn(`[research-scanner] 텔레그램 알림 전달 실패: ${alarmFailure}`);
  }

  return { highRelevanceCount: highRelevance.length, alarmSent, alarmFailure };
}

async function _loadWeeklyResearchRows(): Promise<WeeklyResearchRow[]> {
  return pgPool.query(SCHEMA, `
    SELECT content, metadata, created_at
    FROM ${SCHEMA}.${TABLE}
    WHERE created_at >= now() - interval '7 days'
      AND COALESCE(metadata->>'type', '') != 'daily_metrics'
    ORDER BY created_at DESC
    LIMIT 200
  `, []);
}

function _extractWeeklyRepo(row: WeeklyResearchRow): GitHubRepoRef | null {
  const repoValue = String(row?.metadata?.github_repo || '').trim();
  if (repoValue.includes('/')) {
    const [owner, repo] = repoValue.split('/');
    if (owner && repo) {
      return { owner: owner.trim(), repo: repo.trim().replace(/\.git$/i, '') };
    }
  }

  const extracted = _extractGitHubRepo({
    summary: row?.content,
    title: String(row?.metadata?.title || ''),
    reason: String(row?.metadata?.reason || ''),
  });
  return extracted;
}

function _registerWeeklyResearchTasks(weekData: WeeklyResearchRow[]): number {
  let tasksRegistered = 0;
  const candidates = weekData
    .filter((row: WeeklyResearchRow) => Number(row?.metadata?.relevance_score || 0) >= 8)
    .sort((a: WeeklyResearchRow, b: WeeklyResearchRow) => Number(b?.metadata?.relevance_score || 0) - Number(a?.metadata?.relevance_score || 0));

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

async function _generateWeeklyReport(): Promise<{
  report: string;
  keywordEvolutionCount: number;
  tasksRegistered: number;
  alarmSent: boolean;
  alarmFailure: string;
}> {
  const weekData = await _loadWeeklyResearchRows();
  if (!weekData || weekData.length === 0) {
    return { report: '', keywordEvolutionCount: 0, tasksRegistered: 0, alarmSent: false, alarmFailure: '' };
  }

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

  const byDomain: Record<string, DomainStats> = {};
  for (const row of weekData) {
    const domain = String(row.metadata?.domain || 'unknown');
    if (!byDomain[domain]) byDomain[domain] = { total: 0, high: 0 };
    byDomain[domain].total += 1;
    if (Number(row.metadata?.relevance_score || 0) >= 7) byDomain[domain].high += 1;
  }
  for (const [domain, stats] of Object.entries(byDomain).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`- ${domain}: ${stats.total}건 (7점+: ${stats.high}건)`);
  }

  lines.push('', '## TOP 10 논문');
  const topPapers = weekData
    .filter((row: WeeklyResearchRow) => Number(row.metadata?.relevance_score || 0) >= 5)
    .sort((a: WeeklyResearchRow, b: WeeklyResearchRow) => Number(b.metadata?.relevance_score || 0) - Number(a.metadata?.relevance_score || 0))
    .slice(0, 10);
  topPapers.forEach((paper: WeeklyResearchRow, index: number) => {
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
  const alarmResult = await _postAlarmWithRetry({
    message: report.slice(0, 4000),
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
    ..._weeklyResearchAlarmMeta('weekly_research_summary'),
    payload: {
      event_type: 'darwin_weekly_research_summary',
      report: true,
      keyword_evolution_count: keywordEvolutionCount,
      tasks_registered: tasksRegistered,
    },
  }, 'weekly_research_summary');
  const alarmSent = alarmResult?.ok === true;
  const alarmFailure = alarmSent
    ? ''
    : String(
        alarmResult?.error
        || alarmResult?.body?.delivery_error
        || alarmResult?.body?.reason
        || alarmResult?.body?.error
        || 'not_delivered'
      ).slice(0, 240);

  return { report, keywordEvolutionCount, tasksRegistered, alarmSent, alarmFailure };
}

function _parseCliArgs(argv: string[]): RunOptions {
  const options: RunOptions = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--observe-only') options.observeOnly = true;
    else if (arg === '--max-domains') {
      const value = Number.parseInt(String(argv[index + 1] || ''), 10);
      if (Number.isFinite(value) && value > 0) options.maxDomains = value;
      index += 1;
    } else if (arg.startsWith('--max-domains=')) {
      const value = Number.parseInt(arg.split('=').slice(1).join('='), 10);
      if (Number.isFinite(value) && value > 0) options.maxDomains = value;
    } else if (arg === '--max-evaluations') {
      const value = Number.parseInt(String(argv[index + 1] || ''), 10);
      if (Number.isFinite(value) && value > 0) options.maxEvaluations = value;
      index += 1;
    } else if (arg.startsWith('--max-evaluations=')) {
      const value = Number.parseInt(arg.split('=').slice(1).join('='), 10);
      if (Number.isFinite(value) && value > 0) options.maxEvaluations = value;
    }
  }
  return options;
}

async function run(options: RunOptions = {}): Promise<ScanResult> {
  const startTime = Date.now();
  const dryRun = Boolean(options.dryRun || process.env.DARWIN_RESEARCH_DRY_RUN === '1');
  const observeOnly = !dryRun && Boolean(options.observeOnly || process.env.DARWIN_RESEARCH_OBSERVE_ONLY === '1');
  const maxEvaluations = Math.max(1, Math.min(Number(options.maxEvaluations || MAX_EVALUATIONS_PER_RUN), MAX_EVALUATIONS_PER_RUN));
  console.log(`[research-scanner] 시작: ${kst.datetimeStr()}`);
  telemetry.recordTelemetry({
    phase: 'research_scanner',
    event: 'start',
    dryRun,
    observeOnly,
    maxEvaluations,
  });
  if (!dryRun) {
    await rag.initSchema();
  }

  const searchers = await _selectSearchers();
  const activeSearchers = Number.isFinite(Number(options.maxDomains))
    ? searchers.slice(0, Math.max(1, Number(options.maxDomains)))
    : searchers;
  const allPapers = await _collectPapers(activeSearchers);
  telemetry.recordTelemetry({
    phase: 'research_scanner.collect',
    event: 'end',
    collected: allPapers.length,
    searchers: activeSearchers.length,
  });
  const unique = _dedupePapers(allPapers);
  console.log(`[research-scanner] 중복 제거 후: ${unique.length}건 (전체 ${allPapers.length}건)`);

  const evaluated = await _mapWithConcurrency(
    unique.slice(0, maxEvaluations),
    EVALUATION_CONCURRENCY,
    async (paper) => {
      const evaluation = await evaluator.evaluatePaper(paper);
      return { ...paper, ...evaluation };
    }
  );
  const evaluationFailures = evaluated.filter((paper) => paper.evaluation_failed === true).length;
  telemetry.recordTelemetry({
    phase: 'research_scanner.evaluate',
    event: 'end',
    evaluated: evaluated.length,
    evaluationFailures,
  });

  const enrichment = dryRun || observeOnly ? { githubEnriched: 0, tasksRegistered: 0 } : await _enrichWithGitHub(evaluated);
  const { storedCount, experienceCount } = dryRun
    ? { storedCount: 0, experienceCount: 0 }
    : await _storeEvaluatedPapers(evaluated);
  const { highRelevanceCount, alarmSent, alarmFailure } = dryRun
    ? {
        highRelevanceCount: evaluated.filter((paper) => Number(paper.relevance_score || 0) >= 7).length,
        alarmSent: false,
        alarmFailure: '',
      }
    : observeOnly
      ? (() => {
          const observedHighRelevance = evaluated.filter((paper) => Number(paper.relevance_score || 0) >= 7).length;
          return {
            highRelevanceCount: observedHighRelevance,
            alarmSent: false,
            alarmFailure: observedHighRelevance > 0 ? 'observe_only' : '',
          };
        })()
    : await _alertHighRelevance(unique.length, evaluated, storedCount, startTime);
  const alarmBypassed = observeOnly && highRelevanceCount > 0;
  const highRelevance = evaluated.filter((paper) => Number(paper.relevance_score || 0) >= 7);
  const proposalCandidates = [...highRelevance]
    .sort((a, b) => Number(b.relevance_score || 0) - Number(a.relevance_score || 0))
    .slice(0, MAX_DAILY_PROPOSALS);
  const proposalResults = [];
  if (!dryRun && !observeOnly) {
    for (const paper of proposalCandidates) {
      try {
        const applied = await applicator.apply(paper);
        proposalResults.push({ arxiv_id: paper.arxiv_id, ...applied });
        await _sleep(500);
      } catch (err) {
        console.warn(`[research-scanner] 적용 파이프라인 실패 (${paper.arxiv_id}): ${toErrorMessage(err)}`);
      }
    }
  } else if (proposalCandidates.length > 0) {
    console.log(`[research-scanner] ${dryRun ? 'dry-run' : 'observe-only'}: 제안 적용 ${proposalCandidates.length}건 스킵`);
  }
  const proposalCount = proposalResults.filter((item: any) => item.proposal).length;
  const verifiedCount = proposalResults.filter((item: any) => item.verification?.passed).length;
  const registrySync = dryRun
    ? { synced: 0, failures: 0 }
    : await _syncResearchRegistry(evaluated, proposalResults);
  let keywordEvolutionCount = 0;
  let weeklyTasksRegistered = 0;
  let weeklySummaryAlarmSent = false;
  let weeklySummaryAlarmFailure = '';

  if (!dryRun && !observeOnly && new Date().getDay() === 0) {
    const weekly = await _generateWeeklyReport();
    keywordEvolutionCount = Number(weekly?.keywordEvolutionCount || 0);
    weeklyTasksRegistered = Number(weekly?.tasksRegistered || 0);
    weeklySummaryAlarmSent = weekly?.alarmSent === true;
    weeklySummaryAlarmFailure = String(weekly?.alarmFailure || '');
    telemetry.recordTelemetry({
      phase: 'research_scanner.weekly_report',
      event: 'end',
      keywordEvolutionCount,
      tasksRegistered: weeklyTasksRegistered,
      alarmSent: weeklySummaryAlarmSent,
      alarmFailure: weeklySummaryAlarmFailure,
    });
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  if (durationSec > DURATION_WARNING_THRESHOLD_SEC) {
    console.warn(`[research-scanner] 실행 시간 경고: ${durationSec}초 (기준 ${DURATION_WARNING_THRESHOLD_SEC}초 초과)`);
  }
  const result = {
    dryRun,
    totalRaw: allPapers.length,
    total: unique.length,
    evaluated: evaluated.length,
    stored: storedCount,
    experiencesStored: experienceCount,
    highRelevance: highRelevanceCount,
    alarmSent,
    alarmFailure,
    alarmBypassed,
    evaluationFailures,
    githubAnalyzed: Number(enrichment?.githubEnriched || 0),
    tasksRegistered: Number(enrichment?.tasksRegistered || 0) + weeklyTasksRegistered,
    durationSec,
    keywordEvolutionCount,
    proposals: proposalCount,
    verified: verifiedCount,
    weeklySummaryAlarmSent,
    weeklySummaryAlarmFailure,
    registrySynced: registrySync.synced,
    registrySyncFailures: registrySync.failures,
    searchers: activeSearchers.map(({ name, domain, score, hired }) => ({ name, domain, score, hired })),
  };

  const metrics = monitor.collectMetrics(result, Date.now() - startTime);
  if (!dryRun) {
    await monitor.storeMetrics(metrics);
    if (!observeOnly) {
      await monitor.checkAnomalies(metrics);
    }
  }
  console.log(`[research-scanner] 메트릭: ${JSON.stringify(metrics)}`);
  console.log(`[research-scanner] 완료: ${storedCount}건 저장, ${experienceCount}건 경험 저장, GitHub 분석 ${result.githubAnalyzed}건, 과제 등록 ${result.tasksRegistered}건, ${highRelevanceCount}건 후보 알림, 제안 ${proposalCount}건/검증통과 ${verifiedCount}건, 전달=${alarmSent ? '성공' : '실패/없음'}, ${durationSec}초`);
  telemetry.recordTelemetry({
    phase: 'research_scanner',
    event: 'end',
    ok: true,
    durationSec,
    stored: storedCount,
    highRelevance: highRelevanceCount,
    proposals: proposalCount,
    verified: verifiedCount,
  });

  return result;
}

module.exports = {
  run,
  _selectSearchers,
  _testOnly_weeklyResearchAlarmMeta: _weeklyResearchAlarmMeta,
  _testOnly_postAlarmWithRetry: _postAlarmWithRetry,
  _testOnly_postAlarmRetryDelayMs: _postAlarmRetryDelayMs,
  _testOnly_alarmRateLimitRemainingMs: _alarmRateLimitRemainingMs,
  _testOnly_resetAlarmRateLimitCooldown: _resetAlarmRateLimitCooldown,
  _testOnly_syncResearchRegistry: _syncResearchRegistry,
};

if (require.main === module) {
  run(_parseCliArgs(process.argv))
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

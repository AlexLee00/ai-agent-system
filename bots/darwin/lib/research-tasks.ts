'use strict';

/**
 * 다윈 연구 과제 관리
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');

interface HubLlmResponse {
  text?: string;
}

interface PgPool {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<unknown>;
  query: (schema: string, sql: string, params?: unknown[]) => Promise<any[]>;
}

interface GitHubRepoInfo {
  default_branch: string;
  name?: string;
  stars?: number;
  [key: string]: unknown;
}

interface GitHubTreeEntry {
  path: string;
  [key: string]: unknown;
}

interface GitHubFileContent {
  path: string;
  error?: unknown;
  [key: string]: unknown;
}

interface GitHubClient {
  getRepoInfo: (owner: string, repo: string) => Promise<GitHubRepoInfo>;
  getTree: (owner: string, repo: string, branch: string) => Promise<GitHubTreeEntry[]>;
  readFiles: (
    owner: string,
    repo: string,
    paths: string[],
    branch: string,
    maxFiles?: number
  ) => Promise<GitHubFileContent[]>;
}

interface EnvModule {
  PROJECT_ROOT: string;
}

interface RepoStructure {
  keyFiles?: Array<{ path: string }>;
  keyDirs?: unknown[];
  summary?: {
    totalFiles?: number;
    languages?: Record<string, number>;
  };
}

interface CodePatternSummary {
  path: string;
  functions: unknown[];
  classes: unknown[];
  exports: unknown[];
  imports: unknown[];
  patterns: unknown;
  lines?: number;
}

interface AnalysisSummaryResult {
  summary: string;
}

const { callHubLlm }: {
  callHubLlm: (request: Record<string, unknown>) => Promise<HubLlmResponse | string>;
} = require('../../../packages/core/lib/hub-client');
const pgPool: PgPool = require('../../../packages/core/lib/pg-pool');
const githubClient: GitHubClient = require('../../../packages/core/lib/github-client');
const env: EnvModule = require('../../../packages/core/lib/env');
const {
  analyzeRepoStructure,
  extractCodePatterns,
  generateAnalysisSummary,
}: {
  analyzeRepoStructure: (input: { tree: GitHubTreeEntry[] }) => RepoStructure;
  extractCodePatterns: (file: GitHubFileContent) => CodePatternSummary;
  generateAnalysisSummary: (input: {
    repoInfo: GitHubRepoInfo;
    structure: RepoStructure;
    codePatterns: Array<Record<string, unknown>>;
  }) => AnalysisSummaryResult;
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/darwin/github-analysis.js'));

const REPO_ROOT = env.PROJECT_ROOT;
const TASKS_DIR = path.join(REPO_ROOT, 'docs/research/tasks');
const DOCS_DIR = path.join(REPO_ROOT, 'docs/research');
const RUNTIME_STATUS_KEYS = new Set([
  'status',
  'started_at',
  'completed_at',
  'result',
  'merged_at',
  'merge_error',
  'updated_at',
]);
let _statusInitPromise: Promise<unknown> | null = null;

type ResearchTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

interface ResearchTask {
  id: string;
  title: string;
  type: string;
  status?: ResearchTaskStatus | string;
  priority?: number;
  description?: string;
  assignee?: string;
  target?: { owner?: string; repo?: string };
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  result?: unknown;
  sourceAnalysis?: unknown;
  targetCategory?: string;
  skillName?: string;
  runtime_updated_at?: string | null;
  [key: string]: unknown;
}

interface TaskStatusRow {
  task_id: string;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  runtime?: Record<string, unknown>;
  updated_at?: string | null;
}

interface GitHubAnalysisResult {
  repoInfo: GitHubRepoInfo;
  structure: {
    totalFiles: number;
    languages: Record<string, number>;
    keyDirs: unknown[];
    keyFiles: Array<{ path: string }>;
  };
  codePatterns: Array<{
    path: string;
    functions: number;
    classes: number;
    exports: number;
    imports: number;
    patterns: unknown;
    lines?: number;
  }>;
  summary: string;
  docPath: string;
}

interface SkillCreationResult {
  skillPath: string;
  syntaxOk: boolean;
  branch: string | null;
  linesOfCode: number;
}

function ensureDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

async function ensureTaskStatusSchema(): Promise<unknown> {
  if (_statusInitPromise) return _statusInitPromise;
  _statusInitPromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS agent.task_status (
        task_id TEXT PRIMARY KEY,
        task_type TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        runtime JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS idx_agent_task_status_status
      ON agent.task_status(status, updated_at DESC)
    `);
  })().catch((error) => {
    _statusInitPromise = null;
    throw error;
  });
  return _statusInitPromise;
}

function _taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function _loadAllTasks(): ResearchTask[] {
  ensureDir();
  return fs.readdirSync(TASKS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8')) as ResearchTask)
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}

async function _loadTaskStatusMap(taskIds: string[] = []): Promise<Map<string, TaskStatusRow>> {
  await ensureTaskStatusSchema();
  const ids = Array.from(new Set((taskIds || []).filter(Boolean)));
  if (ids.length === 0) return new Map();
  const rows = await pgPool.query(
    'agent',
    `SELECT task_id, status, started_at, completed_at, runtime, updated_at
       FROM agent.task_status
      WHERE task_id = ANY($1::text[])`,
    [ids],
  ).catch(() => []);
  const map = new Map<string, TaskStatusRow>();
  for (const row of rows || []) {
    map.set(row.task_id, row as TaskStatusRow);
  }
  return map;
}

function _mergeTaskWithStatus(task: ResearchTask, statusRow?: TaskStatusRow): ResearchTask {
  if (!statusRow) return task;
  return {
    ...task,
    status: statusRow.status || task.status,
    started_at: statusRow.started_at || task.started_at || null,
    completed_at: statusRow.completed_at || task.completed_at || null,
    ...(statusRow.runtime && typeof statusRow.runtime === 'object' ? statusRow.runtime : {}),
    runtime_updated_at: statusRow.updated_at || null,
  };
}

async function _upsertTaskRuntimeStatus(
  taskId: string,
  taskType?: string,
  updates: Record<string, unknown> = {}
): Promise<void> {
  await ensureTaskStatusSchema();
  const status = String(updates.status || 'pending').trim();
  const startedAt = updates.started_at || null;
  const completedAt = updates.completed_at || null;
  /** @type {Record<string, any>} */
  const runtime = { ...updates };
  delete runtime.status;
  delete runtime.started_at;
  delete runtime.completed_at;

  await pgPool.run(
    'agent',
    `INSERT INTO agent.task_status (
       task_id, task_type, status, started_at, completed_at, runtime, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
     ON CONFLICT (task_id) DO UPDATE SET
       task_type = COALESCE(EXCLUDED.task_type, agent.task_status.task_type),
       status = EXCLUDED.status,
       started_at = COALESCE(EXCLUDED.started_at, agent.task_status.started_at),
       completed_at = COALESCE(EXCLUDED.completed_at, agent.task_status.completed_at),
       runtime = COALESCE(agent.task_status.runtime, '{}'::jsonb) || EXCLUDED.runtime,
       updated_at = NOW()`,
    [
      taskId,
      taskType || null,
      status,
      startedAt,
      completedAt,
      JSON.stringify(runtime),
    ],
  );
}

function _normalizeRepoPart(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\.git$/i, '');
}

/**
 * @param {ResearchTask} task
 * @returns {ResearchTask}
 */
function createTask(task: ResearchTask): ResearchTask {
  ensureDir();
  const taskId = String(task.id || '').trim();
  if (!taskId) throw new Error('task id required');

  const filePath = _taskPath(taskId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ResearchTask;
  }

  const data: ResearchTask = {
    ...task,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    result: null,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/**
 * @param {string} taskId
 * @returns {Promise<ResearchTask|null>}
 */
async function loadTask(taskId: string): Promise<ResearchTask | null> {
  const filePath = _taskPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  const task = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ResearchTask;
  const statusMap = await _loadTaskStatusMap([taskId]).catch(() => new Map());
  return _mergeTaskWithStatus(task, statusMap.get(taskId));
}

/**
 * @returns {Promise<ResearchTask[]>}
 */
async function getPendingTasks(): Promise<ResearchTask[]> {
  const tasks = _loadAllTasks();
  const statusMap = await _loadTaskStatusMap(tasks.map((task) => task.id)).catch(() => new Map());
  return tasks
    .map((task) => _mergeTaskWithStatus(task, statusMap.get(task.id)))
    .filter((task) => task.status === 'pending')
    .sort((a, b) => Number(a.priority || 5) - Number(b.priority || 5));
}

/**
 * @returns {Promise<ResearchTask[]>}
 */
async function getCompletedTasks(): Promise<ResearchTask[]> {
  const tasks = _loadAllTasks();
  const statusMap = await _loadTaskStatusMap(tasks.map((task) => task.id)).catch(() => new Map());
  return tasks
    .map((task) => _mergeTaskWithStatus(task, statusMap.get(task.id)))
    .filter((task) => task.status === 'completed');
}

function hasTaskForRepo(owner: string, repo: string, types?: string[]): boolean {
  const targetOwner = _normalizeRepoPart(owner);
  const targetRepo = _normalizeRepoPart(repo);
  const allowedTypes = Array.isArray(types) && types.length > 0
    ? new Set(types.map((type) => String(type || '').trim().toLowerCase()))
    : null;

  return _loadAllTasks().some((task) => {
    const taskOwner = _normalizeRepoPart(task?.target?.owner);
    const taskRepo = _normalizeRepoPart(task?.target?.repo);
    const taskType = String(task?.type || '').trim().toLowerCase();
    const activeStatus = !['failed'].includes(String(task?.status || '').trim().toLowerCase());

    if (!activeStatus) return false;
    if (allowedTypes && !allowedTypes.has(taskType)) return false;
    return taskOwner === targetOwner && taskRepo === targetRepo;
  });
}

/**
 * @param {string} taskId
 * @param {Partial<ResearchTask>} updates
 * @returns {Promise<ResearchTask|null>}
 */
async function updateTask(taskId: string, updates: Partial<ResearchTask>): Promise<ResearchTask | null> {
  const filePath = _taskPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  const task = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ResearchTask;
  const patch = updates || {};
  const runtimeUpdates: Record<string, unknown> = {};
  const fileUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (RUNTIME_STATUS_KEYS.has(key)) runtimeUpdates[key] = value;
    else fileUpdates[key] = value;
  }
  if (Object.keys(fileUpdates).length > 0) {
    Object.assign(task, fileUpdates);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf8');
  }
  if (Object.keys(runtimeUpdates).length > 0) {
    await _upsertTaskRuntimeStatus(taskId, task.type, runtimeUpdates);
  }
  const statusMap = await _loadTaskStatusMap([taskId]).catch(() => new Map());
  return _mergeTaskWithStatus(task, statusMap.get(taskId));
}

/**
 * @param {ResearchTask} task
 * @returns {Promise<any>}
 */
async function executeGitHubAnalysis(task: ResearchTask): Promise<GitHubAnalysisResult> {
  const owner = task?.target?.owner;
  const repo = task?.target?.repo;
  if (!owner || !repo) throw new Error('github target owner/repo required');

  await updateTask(task.id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const repoInfo = await githubClient.getRepoInfo(owner, repo);
    const tree = await githubClient.getTree(owner, repo, repoInfo.default_branch);
    const structure = analyzeRepoStructure({ tree });

    const targetFiles = (structure.keyFiles || [])
      .filter((file) => /\.(js|py|ts|go|rs)$/.test(file.path))
      .slice(0, 10);

    const fileContents = await githubClient.readFiles(
      owner,
      repo,
      targetFiles.map((file) => file.path),
      repoInfo.default_branch,
      300
    );

    const codePatterns = fileContents
      .filter((file) => !file.error)
      .map((file) => extractCodePatterns(file))
      .map((pattern) => ({
        path: pattern.path,
        functions: pattern.functions.length,
        classes: pattern.classes.length,
        exports: pattern.exports.length,
        imports: pattern.imports.length,
        patterns: pattern.patterns,
      }));

    const { summary } = generateAnalysisSummary({ repoInfo, structure, codePatterns });
    const docPath = path.join(
      DOCS_DIR,
      `RESEARCH_${owner.toUpperCase()}_${repo.toUpperCase()}_ANALYSIS.md`
    );
    fs.writeFileSync(docPath, summary, 'utf8');

    const result = {
      repoInfo,
      structure: {
        totalFiles: Number(structure.summary?.totalFiles || 0),
        languages: structure.summary?.languages || {},
        keyDirs: (structure.keyDirs || []).slice(0, 10),
        keyFiles: (structure.keyFiles || []).slice(0, 15),
      },
      codePatterns,
      summary,
      docPath,
    };

    await updateTask(task.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
    });

    return result;
      } catch (err) {
        await updateTask(task.id, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          result: {
            error:
              typeof err === 'object' && err !== null && 'message' in err
                ? String((err as { message?: unknown }).message || 'unknown error')
                : String(err || 'unknown error'),
          },
        });
        throw err;
      }
}

function _runGit(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function _extractCodeBlock(text: unknown): string {
  const match = String(text || '').match(/```(?:javascript|js)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : String(text || '').trim();
}

/**
 * @param {ResearchTask} task
 * @returns {Promise<any>}
 */
async function executeSkillCreation(task: ResearchTask): Promise<SkillCreationResult> {
  await updateTask(task.id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const skillDir = task.targetCategory || 'shared';
    const skillName = task.skillName || `auto-${String(task.id || '').toLowerCase()}`;
    const skillPath = path.join(REPO_ROOT, 'packages', 'core', 'lib', 'skills', skillDir, `${skillName}.js`);

    const generated = await callHubLlm({
      callerTeam: 'darwin',
      agent: 'synthesis',
      taskType: 'skill_creation',
      abstractModel: 'anthropic_sonnet',
      systemPrompt: `당신은 팀 제이의 스킬 개발자입니다.
GitHub/논문에서 발견한 패턴을 Node.js 스킬 모듈로 구현하세요.

규칙:
- 순수 함수 중심
- CommonJS(module.exports)
- JSDoc 포함
- node --check 통과 가능한 코드
- 외부 네트워크/비밀값/I/O 의존 금지`,
      prompt: `## 과제: ${task.title}
## 설명: ${task.description}
## 소스 분석 결과:
${JSON.stringify(task.sourceAnalysis || {}, null, 2)}

파일 경로: packages/core/lib/skills/${skillDir}/${skillName}.js`,
      timeoutMs: 45_000,
    });

    const generatedText = typeof generated === 'string' ? generated : generated?.text || '';
    const code = _extractCodeBlock(generatedText);
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, code, 'utf8');

    let syntaxOk = true;
    try {
      execFileSync('node', ['--check', skillPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      syntaxOk = false;
    }

    let branchName = null;
    if (syntaxOk) {
      branchName = `darwin/skill-${skillName}`;
      try {
        _runGit(['checkout', 'main']);
        try {
          _runGit(['checkout', '-b', branchName]);
        } catch (error) {
          const stderr =
            typeof error === 'object' && error !== null && 'stderr' in error
              ? String((error as { stderr?: unknown }).stderr || '')
              : '';
          const message =
            typeof error === 'object' && error !== null && 'message' in error
              ? String((error as { message?: unknown }).message || '')
              : String(error || '');
          if (String(stderr || message || '').includes('already exists')) {
            _runGit(['checkout', branchName]);
          } else {
            throw error;
          }
        }
        _runGit(['add', path.relative(REPO_ROOT, skillPath)]);
        _runGit(['commit', '-m', `feat(skills): auto-create ${skillName} skill`]);
      } finally {
        try {
          _runGit(['checkout', 'main']);
        } catch {}
      }
    }

    const result = {
      skillPath: path.relative(REPO_ROOT, skillPath),
      syntaxOk,
      branch: branchName,
      linesOfCode: code.split('\n').length,
    };

    await updateTask(task.id, {
      status: syntaxOk ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
      result,
    });

    return result;
  } catch (err) {
    await updateTask(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      result: {
        error:
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message?: unknown }).message || 'unknown error')
            : String(err || 'unknown error'),
      },
    });
    throw err;
  }
}

function autoCreateSkillTaskFromAnalysis(
  analysisResult: Partial<GitHubAnalysisResult> & {
    structure?: Partial<GitHubAnalysisResult['structure']> & { summary?: { totalFiles?: number } };
    codePatterns?: Array<{ functions?: number; classes?: number; lines?: number }>;
  },
  sourceTaskId: string
): ResearchTask | null {
  const repoName = String(analysisResult?.repoInfo?.name || '');
  const codePatterns = Array.isArray(analysisResult?.codePatterns) ? analysisResult.codePatterns : [];
  if (!repoName) return null;

  const hasRichPatterns = codePatterns.some((item) =>
    Number(item.functions || 0) > 5
    || Number(item.classes || 0) > 2
    || Number(item.lines || 0) > 200
  );
  const stars = Number(analysisResult?.repoInfo?.stars || 0);
  const totalFiles = Number(analysisResult?.structure?.totalFiles || analysisResult?.structure?.summary?.totalFiles || 0);
  const hasSignificantRepo = stars >= 500 && totalFiles >= 50;
  if (!hasRichPatterns && !hasSignificantRepo) return null;

  const repoPart = repoName.split('/')[1] || repoName;
  const skillName = repoPart.toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-patterns';

  return createTask({
    id: `SKILL-${sourceTaskId}-${Date.now()}`,
    title: `${repoName} 패턴 → 스킬 자동 생성`,
    type: 'skill_creation',
    target: {
      owner: repoName.split('/')[0] || '',
      repo: repoPart,
    },
    description: hasRichPatterns
      ? `${codePatterns.length}개 파일에서 풍부한 패턴 발견`
      : `⭐${stars} 유의미 레포 — ${totalFiles}파일 심층 분석 필요`,
    assignee: 'edison',
    priority: 3,
    sourceAnalysis: {
      repoInfo: analysisResult?.repoInfo,
      patternCount: codePatterns.length,
      triggerReason: hasRichPatterns ? 'rich_patterns' : 'significant_repo',
    },
    targetCategory: 'shared',
    skillName,
  });
}

module.exports = {
  TASKS_DIR,
  ensureDir,
  createTask,
  loadTask,
  getPendingTasks,
  getCompletedTasks,
  hasTaskForRepo,
  updateTask,
  ensureTaskStatusSchema,
  executeGitHubAnalysis,
  executeSkillCreation,
  autoCreateSkillTaskFromAnalysis,
};

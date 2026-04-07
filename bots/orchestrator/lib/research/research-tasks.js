'use strict';

/**
 * 다윈 연구 과제 관리
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const githubClient = require('../../../../packages/core/lib/github-client');
const {
  analyzeRepoStructure,
  extractCodePatterns,
  generateAnalysisSummary,
} = require('../../../../packages/core/lib/skills/darwin/github-analysis');

const TASKS_DIR = path.join(__dirname, '../../../../docs/research/tasks');
const DOCS_DIR = path.join(__dirname, '../../../../docs/research');
const REPO_ROOT = path.join(__dirname, '../../../..');

function ensureDir() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

function _taskPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function _loadAllTasks() {
  ensureDir();
  return fs.readdirSync(TASKS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8')))
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}

function _normalizeRepoPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\.git$/i, '');
}

function createTask(task) {
  ensureDir();
  const taskId = String(task.id || '').trim();
  if (!taskId) throw new Error('task id required');

  const filePath = _taskPath(taskId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  const data = {
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

function loadTask(taskId) {
  const filePath = _taskPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getPendingTasks() {
  return _loadAllTasks()
    .filter((task) => task.status === 'pending')
    .sort((a, b) => Number(a.priority || 5) - Number(b.priority || 5));
}

function getCompletedTasks() {
  return _loadAllTasks().filter((task) => task.status === 'completed');
}

function hasTaskForRepo(owner, repo, types) {
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

function updateTask(taskId, updates) {
  const filePath = _taskPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  Object.assign(task, updates || {});
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf8');
  return task;
}

async function executeGitHubAnalysis(task) {
  const owner = task?.target?.owner;
  const repo = task?.target?.repo;
  if (!owner || !repo) throw new Error('github target owner/repo required');

  updateTask(task.id, { status: 'running', started_at: new Date().toISOString() });

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

    updateTask(task.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
    });

    return result;
  } catch (err) {
    updateTask(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      result: { error: err.message },
    });
    throw err;
  }
}

function _runGit(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function _extractCodeBlock(text) {
  const match = String(text || '').match(/```(?:javascript|js)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : String(text || '').trim();
}

async function executeSkillCreation(task) {
  updateTask(task.id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const skillDir = task.targetCategory || 'shared';
    const skillName = task.skillName || `auto-${String(task.id || '').toLowerCase()}`;
    const skillPath = path.join(REPO_ROOT, 'packages', 'core', 'lib', 'skills', skillDir, `${skillName}.js`);

    const generated = await callWithFallback({
      systemPrompt: `당신은 팀 제이의 스킬 개발자입니다.
GitHub/논문에서 발견한 패턴을 Node.js 스킬 모듈로 구현하세요.

규칙:
- 순수 함수 중심
- CommonJS(module.exports)
- JSDoc 포함
- node --check 통과 가능한 코드
- 외부 네트워크/비밀값/I/O 의존 금지`,
      userPrompt: `## 과제: ${task.title}
## 설명: ${task.description}
## 소스 분석 결과:
${JSON.stringify(task.sourceAnalysis || {}, null, 2)}

파일 경로: packages/core/lib/skills/${skillDir}/${skillName}.js`,
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 3000, temperature: 0.3 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 3000, temperature: 0.3 },
      ],
      logMeta: { team: 'darwin', bot: 'edison', requestType: 'skill_creation' },
      timeoutMs: 45_000,
    });

    const code = _extractCodeBlock(generated?.text || generated);
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
          if (String(error.stderr || error.message || '').includes('already exists')) {
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

    updateTask(task.id, {
      status: syntaxOk ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
      result,
    });

    return result;
  } catch (err) {
    updateTask(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      result: { error: err.message },
    });
    throw err;
  }
}

function autoCreateSkillTaskFromAnalysis(analysisResult, sourceTaskId) {
  const repoName = String(analysisResult?.repoInfo?.name || '');
  const codePatterns = Array.isArray(analysisResult?.codePatterns) ? analysisResult.codePatterns : [];
  if (!repoName || codePatterns.length === 0) return null;

  const richPatterns = codePatterns.filter((item) => Number(item.functions || 0) > 10 || Number(item.classes || 0) > 3);
  if (richPatterns.length === 0) return null;

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
    description: `${richPatterns.length}개 파일에서 풍부한 함수/클래스 패턴 발견`,
    assignee: 'edison',
    priority: 3,
    sourceAnalysis: analysisResult,
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
  executeGitHubAnalysis,
  executeSkillCreation,
  autoCreateSkillTaskFromAnalysis,
};

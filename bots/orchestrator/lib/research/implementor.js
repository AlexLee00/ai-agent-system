'use strict';

/**
 * 다윈 자동 구현기 (edison)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { createLogger } = require('../../../../packages/core/lib/central-logger');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const proposalStore = require('./proposal-store');
const autonomyLevel = require('./autonomy-level');

const REPO_ROOT = path.join(__dirname, '../../../..');
const ALLOWED_PREFIXES = ['packages/', 'bots/', 'docs/', 'scripts/', 'config/'];
const logger = createLogger('implementor', { team: 'darwin' });

function _runGit(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function _getCurrentBranch() {
  return _runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
}

function _isCleanWorktree() {
  return _runGit(['status', '--porcelain']) === '';
}

function _sanitizeBranchName(proposalId) {
  return `darwin/${String(proposalId).replace(/[^a-zA-Z0-9/_-]+/g, '-').slice(0, 96)}`;
}

function _createStashLabel(proposalId) {
  return `darwin-auto-${String(proposalId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

function _normalizeRepoPath(filePath) {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`invalid_output_path:${filePath}`);
  }

  const clean = path.posix.normalize(normalized);
  if (clean.startsWith('../') || clean === '..' || clean.includes('/../')) {
    throw new Error(`path_traversal_blocked:${filePath}`);
  }
  if (!ALLOWED_PREFIXES.some((prefix) => clean.startsWith(prefix))) {
    throw new Error(`output_path_not_allowed:${filePath}`);
  }
  return clean;
}

function _stashPushIfNeeded(proposalId) {
  if (_isCleanWorktree()) return { created: false, label: null };
  const label = _createStashLabel(proposalId);
  _runGit(['stash', 'push', '-u', '-m', label]);
  return { created: true, label };
}

function _stashPopIfNeeded(stashState) {
  if (!stashState?.created || !stashState.label) return;
  const stashList = _runGit(['stash', 'list']);
  const line = String(stashList || '')
    .split('\n')
    .find((entry) => entry.includes(stashState.label));
  if (!line) return;
  const stashRef = String(line.split(':')[0] || '').trim();
  if (!stashRef) return;
  _runGit(['stash', 'pop', stashRef]);
}

function _deleteBranchIfExists(branchName) {
  if (!branchName) return;
  try {
    _runGit(['branch', '-D', branchName]);
  } catch {
    // ignore
  }
}

function _hasStagedChanges() {
  try {
    _runGit(['diff', '--cached', '--quiet']);
    return false;
  } catch {
    return true;
  }
}

function _extractFiles(rawText) {
  const text = String(rawText?.text || rawText || '');
  const files = [];
  const pattern = /---\s*FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)(?=\n---\s*FILE:|\s*$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const filePath = _normalizeRepoPath(String(match[1] || '').trim());
    const content = String(match[2] || '').trim();
    if (!filePath || !content) continue;
    files.push({ path: filePath, content });
  }
  return files;
}

function _writeFiles(files) {
  const changed = [];
  for (const file of files) {
    const fullPath = path.join(REPO_ROOT, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf8');
    changed.push(file.path);
  }
  return changed;
}

function _checkSyntax(paths) {
  const results = [];
  for (const filePath of paths) {
    if (!filePath.endsWith('.js')) {
      results.push({ path: filePath, ok: true });
      continue;
    }
    try {
      execFileSync('node', ['--check', filePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.push({ path: filePath, ok: true });
    } catch (error) {
      results.push({
        path: filePath,
        ok: false,
        error: String(error.stderr || error.stdout || error.message || '').slice(0, 300),
      });
    }
  }
  return results;
}

async function triggerImplementation(proposalId) {
  const proposal = proposalStore.loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  const originalBranch = _getCurrentBranch();
  const branchName = proposal.branch || _sanitizeBranchName(proposalId);
  let stashState = null;
  let branchCheckedOut = false;
  let committed = false;
  proposalStore.updateStatus(proposalId, 'implementing', { branch: branchName, implementation_started_at: new Date().toISOString() });
  logger.info(`구현 시작: ${proposalId} -> ${branchName}`);

  try {
    stashState = _stashPushIfNeeded(proposalId);
    _runGit(['checkout', '-b', branchName]);
    branchCheckedOut = true;
  } catch (error) {
    if (String(error.stderr || error.message || '').includes('already exists')) {
      _runGit(['checkout', branchName]);
      branchCheckedOut = true;
    } else {
      throw error;
    }
  }

  try {
    const implementationResult = await callWithFallback({
      systemPrompt: `당신은 팀 제이의 프로토타입 개발자(edison)입니다.
연구 제안을 실제 Node.js 코드로 구현하세요.

규칙:
- CommonJS(require/module.exports)
- 각 파일은 --- FILE: path/to/file.js --- 형식으로 구분
- node --check 통과 가능한 코드
- 기존 패턴을 따르고 외부 비밀값 하드코딩 금지`,
      userPrompt: `논문: ${proposal.paper?.title || proposal.title || 'unknown'}

적용 방안:
${proposal.proposal || ''}

프로토타입:
${proposal.prototype || ''}

현재 상태:
${JSON.stringify(proposal.verification || {})}`,
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4000, temperature: 0.3 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 4000, temperature: 0.3 },
      ],
      logMeta: { team: 'darwin', bot: 'edison', requestType: 'auto_implementation' },
      timeoutMs: 45_000,
    });

    const files = _extractFiles(implementationResult);
    logger.info(`LLM 출력 파싱 완료: ${files.length}개 파일`);
    if (files.length === 0) {
      _runGit(['checkout', originalBranch]);
      branchCheckedOut = false;
      _deleteBranchIfExists(branchName);
      proposalStore.updateStatus(proposalId, 'implementation_failed', {
        error: 'no_files_extracted',
      });
      throw new Error('no files extracted from edison output');
    }

    const changedFiles = _writeFiles(files);
    const syntaxChecks = _checkSyntax(changedFiles);
    const syntaxPassed = syntaxChecks.every((item) => item.ok);
    logger.info(`구현 커밋 준비: ${changedFiles.length}개 파일, syntax=${syntaxPassed ? 'pass' : 'partial-fail'}`);

    _runGit(['add', ...changedFiles]);
    if (!_hasStagedChanges()) {
      _runGit(['checkout', originalBranch]);
      branchCheckedOut = false;
      _deleteBranchIfExists(branchName);
      proposalStore.updateStatus(proposalId, 'implementation_failed', {
        error: 'no_effective_changes',
      });
      throw new Error('edison produced no effective file changes');
    }
    _runGit(['commit', '-m', `feat(darwin): auto-implement ${proposalId}`]);
    committed = true;

    proposalStore.updateStatus(proposalId, 'implemented', {
      branch: branchName,
      changed_files: changedFiles,
      syntax_checks: syntaxChecks,
      syntax_passed: syntaxPassed,
      implemented_at: new Date().toISOString(),
    });

    await postAlarm({
      message: [
        '🔧 다윈 자동 구현 완료',
        `📄 ${proposal.title || proposal.paper?.title || proposalId}`,
        `🌿 브랜치: ${branchName}`,
        `📂 파일 ${changedFiles.length}개`,
        `✅ 문법 검증: ${syntaxPassed ? '통과' : '일부 실패'}`,
      ].join('\n'),
      team: 'darwin',
      alertLevel: syntaxPassed ? 2 : 3,
      fromBot: 'implementor',
    });

    const verifier = require('./verifier');
    setImmediate(() => verifier.triggerVerification(proposalId, branchName));
    return { ok: true, branchName, changedFiles, syntaxChecks };
  } catch (error) {
    logger.error(`구현 실패: ${proposalId} -> ${error.message}`);
    autonomyLevel.recordError(error);
    proposalStore.updateStatus(proposalId, 'implementation_failed', {
      branch: branchName,
      error: error.message,
    });
    await postAlarm({
      message: `❌ 다윈 자동 구현 실패\n📄 ${proposal.title || proposalId}\n사유: ${error.message}`,
      team: 'darwin',
      alertLevel: 3,
      fromBot: 'implementor',
    });
    throw error;
  } finally {
    try {
      if (branchCheckedOut) _runGit(['checkout', originalBranch]);
    } catch {}
    try {
      if (!committed) _deleteBranchIfExists(branchName);
    } catch {}
    try {
      _stashPopIfNeeded(stashState);
    } catch {}
  }
}

module.exports = {
  triggerImplementation,
  _extractFiles,
};

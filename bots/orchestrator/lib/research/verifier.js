'use strict';

/**
 * 다윈 자동 검증기 (proof-r)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const rag = require('../../../../packages/core/lib/rag');
const proposalStore = require('./proposal-store');
const autonomyLevel = require('./autonomy-level');

const REPO_ROOT = path.join(__dirname, '../../../..');

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

function _listChangedFiles(baseBranch = 'main') {
  const output = _runGit(['diff', '--name-only', `${baseBranch}...HEAD`]);
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function _syntaxCheck(files) {
  const failures = [];
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    try {
      execFileSync('node', ['--check', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failures.push({
        file,
        error: String(error.stderr || error.stdout || error.message || '').slice(0, 300),
      });
    }
  }
  return failures;
}

function _loadContents(files) {
  return files.map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
  }));
}

async function triggerVerification(proposalId, branchName) {
  const proposal = proposalStore.loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  const originalBranch = _getCurrentBranch();
  proposalStore.updateStatus(proposalId, 'verifying', {
    verification_started_at: new Date().toISOString(),
    branch: branchName,
  });

  try {
    _runGit(['checkout', branchName]);
    const changedFiles = _listChangedFiles('main');
    const syntaxFailures = _syntaxCheck(changedFiles);
    const fileContents = _loadContents(changedFiles).slice(0, 8);

    const verificationResult = await callWithFallback({
      systemPrompt: `당신은 팀 제이의 연구 검증자(proof-r)입니다.
다윈 자동 구현 결과를 검증하세요.

검증 항목:
1. 문법 정확성
2. 기존 코드와 충돌 가능성
3. 보안 문제
4. 성능 우려
5. 스타일/패턴 적합성

반드시 PASS 또는 FAIL을 명시하고, 5개 항목별 짧은 판정을 포함하세요.`,
      userPrompt: `제안 ID: ${proposalId}
논문: ${proposal.title || proposal.paper?.title || 'unknown'}
변경 파일:
${fileContents.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n')}

사전 문법 실패:
${JSON.stringify(syntaxFailures)}`,
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2200, temperature: 0.2 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 2200, temperature: 0.2 },
      ],
      logMeta: { team: 'darwin', bot: 'proof-r', requestType: 'auto_verification' },
      timeoutMs: 30_000,
    });

    const verificationText = String(verificationResult?.text || verificationResult || '').trim();
    const passed = syntaxFailures.length === 0 && /\bPASS\b/i.test(verificationText) && !/\bFAIL\b/i.test(verificationText);

    proposalStore.updateStatus(proposalId, passed ? 'verified' : 'verification_failed', {
      branch: branchName,
      files: changedFiles,
      verification_text: verificationText,
      syntax_failures: syntaxFailures,
      verified_at: new Date().toISOString(),
    });

    await rag.storeExperience({
      userInput: `Darwin auto verification ${proposalId}`,
      intent: 'darwin_auto_verification',
      response: verificationText.slice(0, 1500),
      result: passed ? 'success' : 'failure',
      team: 'darwin',
      sourceBot: 'proof-r',
      details: {
        proposal_id: proposalId,
        branch: branchName,
        files: changedFiles,
      },
      successOnly: false,
    });

    await postAlarm({
      message: passed
        ? `✅ proof-r 검증 통과\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n📂 ${changedFiles.length}개 파일`
        : `❌ proof-r 검증 실패\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n사유: ${verificationText.slice(0, 500)}`,
      team: 'darwin',
      alertLevel: passed ? 2 : 3,
      fromBot: 'proof-r',
      inlineKeyboard: passed ? [[
        { text: '✅ 머지 승인', callback_data: `darwin_merge:${proposalId}` },
        { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
      ]] : null,
    });

    return { ok: true, passed, changedFiles, verificationText };
  } catch (error) {
    autonomyLevel.recordError(error);
    proposalStore.updateStatus(proposalId, 'verification_failed', {
      branch: branchName,
      error: error.message,
    });
    await postAlarm({
      message: `❌ proof-r 검증 중 오류\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n사유: ${error.message}`,
      team: 'darwin',
      alertLevel: 3,
      fromBot: 'proof-r',
    });
    throw error;
  } finally {
    try {
      _runGit(['checkout', originalBranch]);
    } catch {}
  }
}

async function mergeVerifiedProposal(proposalId) {
  const proposal = proposalStore.loadProposal(proposalId);
  if (!proposal?.branch) throw new Error(`branch missing for proposal: ${proposalId}`);

  const merged = await mergeBranch(proposal.branch, proposalId);
  proposalStore.updateStatus(proposalId, 'merged', {
    merged_at: new Date().toISOString(),
    merged_branch: proposal.branch,
  });
  await postAlarm({
    message: `🎉 다윈 제안 머지 완료\n📄 ${proposal.title || proposalId}\n🌿 ${proposal.branch}`,
    team: 'darwin',
    alertLevel: 2,
    fromBot: 'proof-r',
  });
  return merged;
}

async function mergeBranch(branchName, label) {
  const originalBranch = _getCurrentBranch();
  try {
    _runGit(['checkout', 'main']);
    _runGit(['merge', '--no-ff', branchName, '-m', `merge(darwin): ${label}`]);
    return { ok: true, branch: branchName };
  } catch (error) {
    autonomyLevel.recordError(error);
    throw error;
  } finally {
    try {
      _runGit(['checkout', originalBranch]);
    } catch {}
  }
}

module.exports = {
  triggerVerification,
  mergeVerifiedProposal,
  mergeBranch,
};

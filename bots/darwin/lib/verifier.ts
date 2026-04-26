'use strict';

/**
 * 다윈 자동 검증기 (proof-r)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
const { createLogger } = require('../../../packages/core/lib/central-logger');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const eventLake = require('../../../packages/core/lib/event-lake');
const rag = require('../../../packages/core/lib/rag');
const { runFullVerification } = require('../../../packages/core/lib/skills/verify-loop');
const proposalStore = require('./proposal-store');
const autonomyLevel = require('./autonomy-level');

const REPO_ROOT = path.join(__dirname, '../../../..');
const logger = createLogger('verifier', { team: 'darwin' });

type ExecFileOptions = Omit<import('child_process').ExecFileSyncOptionsWithStringEncoding, 'encoding'>;

interface HubLlmResponse {
  text?: string;
}

interface AlarmPayload {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>> | null;
}

interface EventLake {
  record(payload: Record<string, unknown>): Promise<string | null>;
}

interface ProposalPaper {
  title?: string;
}

interface ProposalRecord {
  branch?: string;
  title?: string;
  paper?: ProposalPaper;
  changed_files?: string[];
  [key: string]: unknown;
}

interface ProposalStore {
  loadProposal(proposalId: string): ProposalRecord | null;
  updateStatus(
    proposalId: string,
    status: string,
    extra?: Record<string, unknown>
  ): ProposalRecord | null;
}

interface AutonomyLevelModule {
  requiresApproval(): boolean;
  recordError(error: unknown): void;
}

interface VerificationReport {
  overall: boolean;
  summary?: string;
  report?: unknown;
}

interface FullVerificationRunner {
  (input: {
    files: string[];
    cwd: string;
    baseBranch: string;
  }): VerificationReport;
}

const eventLakeTyped: EventLake = eventLake;
const proposalStoreTyped: ProposalStore = proposalStore;
const autonomyLevelTyped: AutonomyLevelModule = autonomyLevel;
const runFullVerificationTyped: FullVerificationRunner = runFullVerification;

function toErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    return String(maybe.stderr || maybe.stdout || maybe.message || 'unknown error');
  }
  return String(error || 'unknown error');
}

function _runGit(args: string[], opts: ExecFileOptions = {}): string {
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

function _deleteBranchIfExists(branchName: string | null | undefined): void {
  if (!branchName) return;
  try {
    _runGit(['branch', '-D', branchName]);
  } catch {
    // ignore
  }
}

function _listChangedFiles(baseBranch = 'main') {
  const output = _runGit(['diff', '--name-only', `${baseBranch}...HEAD`]);
  return output ? output.split('\n').map((line: string) => line.trim()).filter(Boolean) : [];
}

function _loadContents(files: string[]): Array<{ path: string; content: string }> {
  return files.map((file: string) => ({
    path: file,
    content: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
  }));
}

function _decideVerificationPass(verification: VerificationReport, verificationText: string): boolean {
  const text = String(verificationText || '').trim();
  const explicitPass = /\b(?:종합 판정|overall(?: verdict)?|final verdict)\s*:\s*PASS\b/i.test(text);
  const explicitFail = /\b(?:종합 판정|overall(?: verdict)?|final verdict)\s*:\s*FAIL\b/i.test(text);
  const leadPass = /^PASS\b/i.test(text);
  const leadFail = /^FAIL\b/i.test(text);

  if (explicitPass) return verification.overall && !explicitFail;
  if (explicitFail) return false;
  if (leadPass) return verification.overall && !leadFail;
  if (leadFail) return false;

  return verification.overall && /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text);
}

function _resolveVerificationFiles(proposal: ProposalRecord | null): string[] {
  const preferred = Array.isArray(proposal?.changed_files) ? proposal.changed_files : [];
  const existing = preferred.filter((file: string) => {
    if (typeof file !== 'string' || !file) return false;
    return fs.existsSync(path.join(REPO_ROOT, file));
  });
  if (existing.length > 0) return existing;
  return _listChangedFiles('main');
}

async function triggerVerification(proposalId: string, branchName: string): Promise<{ ok: true; passed: boolean; changedFiles: string[]; verificationText: string }> {
  const proposal = proposalStoreTyped.loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  const originalBranch = _getCurrentBranch();
  proposalStoreTyped.updateStatus(proposalId, 'verifying', {
    verification_started_at: new Date().toISOString(),
    branch: branchName,
  });
  logger.info(`검증 시작: ${proposalId} -> ${branchName}`);

  try {
    _runGit(['checkout', branchName]);
    const changedFiles = _resolveVerificationFiles(proposal);
    const verification = runFullVerificationTyped({
      files: changedFiles,
      cwd: REPO_ROOT,
      baseBranch: 'main',
    });
    const fileContents = _loadContents(changedFiles).slice(0, 8);

    const verificationResult = await callHubLlm({
      callerTeam: 'darwin',
      agent: 'review',
      taskType: 'auto_verification',
      abstractModel: 'anthropic_sonnet',
      systemPrompt: `당신은 팀 제이의 연구 검증자(proof-r)입니다.
다윈 자동 구현 결과를 검증하세요.

검증 항목:
1. 문법 정확성
2. 기존 코드와 충돌 가능성
3. 보안 문제
4. 성능 우려
5. 스타일/패턴 적합성

반드시 PASS 또는 FAIL을 명시하고, 5개 항목별 짧은 판정을 포함하세요.`,
      prompt: `제안 ID: ${proposalId}
논문: ${proposal.title || proposal.paper?.title || 'unknown'}
변경 파일:
${fileContents.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n')}

사전 자동 검증 리포트:
${verification.summary}`,
      timeoutMs: 30_000,
    }) as HubLlmResponse | string;

    const verificationText = String(
      (typeof verificationResult === 'string' ? verificationResult : verificationResult?.text) || ''
    ).trim();
    const passed = _decideVerificationPass(verification, verificationText);
    const requiresApproval = autonomyLevelTyped.requiresApproval();
    logger.info(`검증 완료: ${proposalId} -> ${passed ? 'PASS' : 'FAIL'}`, { files: changedFiles.length });

    proposalStoreTyped.updateStatus(proposalId, passed ? 'verified' : 'verification_failed', {
      branch: branchName,
      files: changedFiles,
      error: null,
      verification_text: verificationText,
      verification_report: verification.report,
      verification_summary: verification.summary,
      verified_at: new Date().toISOString(),
    });

    await rag.storeExperience({
      userInput: `Darwin auto verification ${proposalId}`,
      intent: 'darwin_auto_verification',
      response: verificationText.slice(0, 1500),
      result: passed ? 'success' : 'failure',
      why: verification.summary || (passed ? 'syntax 통과, security 위험 미감지' : 'syntax/security/diff 중 하나 이상 실패'),
      team: 'darwin',
      sourceBot: 'proof-r',
      details: {
        proposal_id: proposalId,
        branch: branchName,
        files: changedFiles,
        verification_report: verification.report,
      },
      successOnly: false,
    });

    await eventLakeTyped.record({
      eventType: passed ? 'verification_passed' : 'verification_failed',
      team: 'darwin',
      botName: 'proof-r',
      severity: passed ? 'info' : 'warn',
      title: String(proposal.title || proposalId).slice(0, 140),
      message: verificationText.slice(0, 500),
      tags: ['verification', passed ? 'passed' : 'failed'],
      metadata: {
        proposal_id: proposalId,
        branch: branchName,
        files: changedFiles,
      },
    }).catch(() => null);

    await postAlarm({
      message: passed
        ? `✅ proof-r 검증 통과\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n📂 ${changedFiles.length}개 파일${requiresApproval ? '' : '\n🚀 L5 완전자율 모드 — 자동 머지 진행'}`
        : `❌ proof-r 검증 실패\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n사유: ${verificationText.slice(0, 500)}`,
      team: 'darwin',
      alertLevel: passed ? 2 : 3,
      fromBot: 'proof-r',
      inlineKeyboard: passed && requiresApproval
        ? [[
            { text: '✅ 머지 승인', callback_data: `darwin_merge:${proposalId}` },
            { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
          ]]
        : !passed ? [[
            { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
          ]]
        : null,
    } as AlarmPayload);

    if (passed && !requiresApproval) {
      setImmediate(() => {
        mergeVerifiedProposal(proposalId).catch((error) => {
          logger.error(`자동 머지 실패: ${proposalId} -> ${error.message}`);
        });
      });
    }

    return { ok: true, passed, changedFiles, verificationText };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    logger.error(`검증 실패: ${proposalId} -> ${errorMessage}`);
    autonomyLevelTyped.recordError(error);
    proposalStoreTyped.updateStatus(proposalId, 'verification_failed', {
      branch: branchName,
      error: errorMessage,
    });
    await eventLakeTyped.record({
      eventType: 'verification_error',
      team: 'darwin',
      botName: 'proof-r',
      severity: 'error',
      title: String(proposal.title || proposalId).slice(0, 140),
      message: errorMessage,
      tags: ['verification', 'error'],
      metadata: {
        proposal_id: proposalId,
        branch: branchName,
      },
    }).catch(() => null);

    await postAlarm({
      message: `❌ proof-r 검증 중 오류\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n사유: ${errorMessage}`,
      team: 'darwin',
      alertLevel: 3,
      fromBot: 'proof-r',
      inlineKeyboard: null,
    } as AlarmPayload);
    throw error;
  } finally {
    try {
      _runGit(['checkout', originalBranch]);
    } catch {}
  }
}

async function mergeVerifiedProposal(proposalId: string): Promise<{ ok: true; branch: string }> {
  const proposal = proposalStoreTyped.loadProposal(proposalId);
  if (!proposal?.branch) throw new Error(`branch missing for proposal: ${proposalId}`);

  const merged = await mergeBranch(proposal.branch, proposalId);
  proposalStoreTyped.updateStatus(proposalId, 'merged', {
    merged_at: new Date().toISOString(),
    merged_branch: proposal.branch,
  });
  await postAlarm({
    message: `🎉 다윈 제안 머지 완료\n📄 ${proposal.title || proposalId}\n🌿 ${proposal.branch}`,
    team: 'darwin',
    alertLevel: 2,
    fromBot: 'proof-r',
  } as AlarmPayload);
  return merged;
}

async function mergeBranch(branchName: string, label: string): Promise<{ ok: true; branch: string }> {
  const originalBranch = _getCurrentBranch();
  try {
    _runGit(['checkout', 'main']);
    _runGit(['merge', '--no-ff', branchName, '-m', `merge(darwin): ${label}`]);
    _deleteBranchIfExists(branchName);
    return { ok: true, branch: branchName };
  } catch (error) {
    const stderr = toErrorMessage(error);
    if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(stderr)) {
      try {
        _runGit(['merge', '--abort']);
      } catch {}
      await postAlarm({
        message: `⚠️ 다윈 머지 충돌\n🌿 ${branchName}\n사유: ${stderr.slice(0, 500)}`,
        team: 'darwin',
        alertLevel: 3,
        fromBot: 'proof-r',
        inlineKeyboard: [[
            { text: '📝 수동 검토', callback_data: `darwin_manual:${label}` },
        ]],
      } as AlarmPayload);
    }
    autonomyLevelTyped.recordError(error);
    throw error;
  } finally {
    try {
      _runGit(['checkout', 'main']);
    } catch {
      try {
        _runGit(['checkout', originalBranch]);
      } catch {}
    }
  }
}

module.exports = {
  triggerVerification,
  mergeVerifiedProposal,
  mergeBranch,
};

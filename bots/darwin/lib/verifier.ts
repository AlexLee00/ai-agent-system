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
const failureTrajectory = require('../../../packages/core/lib/failure-trajectory');
const { runFullVerification } = require('../../../packages/core/lib/skills/verify-loop');
const env = require('../../../packages/core/lib/env');
const proposalStore = require('./proposal-store');
const autonomyLevel = require('./autonomy-level');
const {
  createLab,
  removeLab,
}: {
  createLab: (branchName: string) => { branchName: string; path: string };
  removeLab: (labPath: string) => { removed: boolean; pruned: boolean };
} = require('./worktree-lab');
const {
  assertOpsRootOnMain,
}: {
  assertOpsRootOnMain: (options?: Record<string, unknown>) => { ok: boolean; branch: string; action: string; message: string };
} = require('./ops-root-guard');
const {
  runSuccessPredicate,
  appendLearningLine,
}: {
  runSuccessPredicate: (rawPredicate: unknown, options: { cwd: string }) => {
    ok: boolean;
    predicate_results?: Array<Record<string, unknown>>;
    assertionResults: Array<Record<string, unknown>>;
    budget: Record<string, unknown> | null;
    failureReason: string | null;
    validation: { ok: boolean; errors: string[] };
  };
  appendLearningLine: (proposalId: string, reason: string, details?: Record<string, unknown>) => string;
} = require('./success-predicate');

const REPO_ROOT = env.PROJECT_ROOT;
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

interface FailureTrajectory {
  recordExecutionTrajectory(input: Record<string, unknown>): Promise<unknown>;
  recordFailureTrajectory(input: Record<string, unknown>): Promise<unknown>;
  searchFailureHints(query: string, options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
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
  transitionProposal?(
    proposalId: string,
    to: 'proposed' | 'implementing' | 'measured' | 'adopted' | 'archived',
    evidence?: Record<string, unknown>
  ): ProposalRecord | null;
}

interface AutonomyLevelModule {
  requiresApproval(): boolean;
  recordVerifiedSuccess(): void;
  recordMergeSuccess(): void;
  recordMergeFailure(error: unknown): void;
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
const failureTrajectoryTyped: FailureTrajectory = failureTrajectory;
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

function _listChangedFiles(baseBranch = 'main', cwd = REPO_ROOT) {
  const output = _runGit(['diff', '--name-only', `${baseBranch}...HEAD`], { cwd });
  return output ? output.split('\n').map((line: string) => line.trim()).filter(Boolean) : [];
}

function _loadContents(files: string[], cwd = REPO_ROOT): Array<{ path: string; content: string }> {
  return files.map((file: string) => ({
    path: file,
    content: fs.readFileSync(path.join(cwd, file), 'utf8'),
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

function _formatFailureHints(hints: Array<Record<string, unknown>> = []): string {
  if (!Array.isArray(hints) || hints.length === 0) return '없음';
  return hints.slice(0, 3).map((hit, index) => {
    const metadata = (hit.metadata || {}) as Record<string, unknown>;
    return [
      `${index + 1}. signature=${String(metadata.signature || 'unknown')}`,
      metadata.root_cause ? `root=${String(metadata.root_cause).slice(0, 180)}` : '',
      metadata.resolution_hint ? `hint=${String(metadata.resolution_hint).slice(0, 240)}` : '',
      metadata.test_result ? `test=${String(metadata.test_result).slice(0, 180)}` : '',
      metadata.stderr_tail ? `stderr=${String(metadata.stderr_tail).slice(0, 180)}` : '',
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

async function _loadFailureHintsForVerification(proposalId: string, proposal: ProposalRecord, changedFiles: string[], verification: VerificationReport): Promise<string> {
  const query = [
    proposalId,
    proposal.title,
    proposal.paper?.title,
    changedFiles.join('\n'),
    verification.summary,
  ].filter(Boolean).join('\n').slice(0, 4000);
  try {
    const hints = await failureTrajectoryTyped.searchFailureHints(query || proposalId, {
      team: 'darwin',
      agent: 'proof-r',
      intent: 'darwin_auto_verification',
      limit: 3,
    });
    return _formatFailureHints(hints);
  } catch (error) {
    logger.warn(`검증 실패 궤적 힌트 조회 실패: ${toErrorMessage(error)}`);
    return '조회 실패';
  }
}

async function _recordVerificationFailureTrajectory(
  proposalId: string,
  proposal: ProposalRecord,
  branchName: string,
  changedFiles: string[],
  failureText: string,
  verificationSummary = ''
): Promise<void> {
  try {
    await failureTrajectoryTyped.recordFailureTrajectory({
      team: 'darwin',
      agent: 'proof-r',
      intent: 'darwin_auto_verification',
      command: `darwin verifier ${proposalId}`,
      stderr: failureText,
      rootCause: failureText,
      resolutionHint: '유사 검증 실패를 다음 검증 프롬프트에 주입하고 syntax/security/diff 실패 원인을 우선 확인한다.',
      testResult: verificationSummary || 'verification_failed',
      recoveryResult: 'stored_for_next_darwin_verification',
      incidentKey: `darwin:verifier:${proposalId}`,
      metadata: {
        proposal_id: proposalId,
        branch: branchName,
        files: changedFiles,
        title: proposal.title || proposal.paper?.title || '',
      },
    });
  } catch (recordError) {
    logger.warn(`검증 실패 궤적 저장 실패: ${toErrorMessage(recordError)}`);
  }
}

async function _recordVerificationSuccessTrajectory(
  proposalId: string,
  proposal: ProposalRecord,
  branchName: string,
  changedFiles: string[],
  verificationText: string,
  verificationSummary = ''
): Promise<void> {
  try {
    await failureTrajectoryTyped.recordExecutionTrajectory({
      result: 'success',
      team: 'darwin',
      agent: 'proof-r',
      intent: 'darwin_auto_verification',
      command: `darwin verifier ${proposalId}`,
      stdout: verificationText,
      recoveryResult: 'verification_passed',
      resolutionHint: '유사 검증 요청에서 syntax/security/diff 통과 조건과 PASS 판정 패턴을 재사용한다.',
      testResult: verificationSummary || 'verification_passed',
      incidentKey: `darwin:verifier:${proposalId}`,
      metadata: {
        proposal_id: proposalId,
        branch: branchName,
        files: changedFiles,
        title: proposal.title || proposal.paper?.title || '',
      },
    });
  } catch (recordError) {
    logger.warn(`검증 성공 궤적 저장 실패: ${toErrorMessage(recordError)}`);
  }
}

function _resolveVerificationFiles(proposal: ProposalRecord | null, cwd = REPO_ROOT): string[] {
  const preferred = Array.isArray(proposal?.changed_files) ? proposal.changed_files : [];
  const existing = preferred.filter((file: string) => {
    if (typeof file !== 'string' || !file) return false;
    return fs.existsSync(path.join(cwd, file));
  });
  if (existing.length > 0) return existing;
  return _listChangedFiles('main', cwd);
}

async function triggerVerification(proposalId: string, branchName: string): Promise<{ ok: true; passed: boolean; changedFiles: string[]; verificationText: string }> {
  const proposal = proposalStoreTyped.loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  let lab: { branchName: string; path: string } | null = null;
  let passed = false;
  let keepLab = false;
  let deleteBranch = false;
  proposalStoreTyped.updateStatus(proposalId, 'verifying', {
    verification_started_at: new Date().toISOString(),
    branch: branchName,
  });
  logger.info(`검증 시작: ${proposalId} -> ${branchName}`);

  try {
    lab = createLab(branchName);
    const changedFiles = _resolveVerificationFiles(proposal, lab.path);
    const verification = runFullVerificationTyped({
      files: changedFiles,
      cwd: lab.path,
      baseBranch: 'main',
    });
    const successPredicate = proposal.successPredicate && typeof proposal.successPredicate === 'object'
      ? proposal.successPredicate as Record<string, unknown>
      : {};
    const predicateResult = runSuccessPredicate(successPredicate, { cwd: lab.path });
    passed = predicateResult.ok;
    const verificationText = passed
      ? `PASS successPredicate assertions=${predicateResult.assertionResults.length}`
      : `FAIL successPredicate reason=${predicateResult.failureReason || 'unknown'} errors=${predicateResult.validation?.errors?.join(',') || 'none'}`;
    const requiresApproval = autonomyLevelTyped.requiresApproval();
    logger.info(`검증 완료: ${proposalId} -> ${passed ? 'PASS' : 'FAIL'}`, { files: changedFiles.length });
    if (!passed) {
      await _recordVerificationFailureTrajectory(
        proposalId,
        proposal,
        branchName,
        changedFiles,
        verificationText,
        verification.summary || ''
      );
    } else {
      await _recordVerificationSuccessTrajectory(
        proposalId,
        proposal,
        branchName,
        changedFiles,
        verificationText,
        verification.summary || ''
      );
    }

    if (passed && proposalStoreTyped.transitionProposal) {
      proposalStoreTyped.transitionProposal(proposalId, 'measured', {
        reason: 'verification_passed',
        branch: branchName,
        files: changedFiles,
        error: null,
        verification_text: verificationText,
        verification_report: verification.report,
        verification_summary: verification.summary,
        verified_at: new Date().toISOString(),
        predicate_results: predicateResult.predicate_results || predicateResult.assertionResults,
        metrics_evidence: [{
          targetMetric: successPredicate.targetMetric || null,
          source: 'successPredicate',
        }],
        budget: predicateResult.budget,
      });
    } else if (!passed && proposalStoreTyped.transitionProposal) {
      proposalStoreTyped.updateStatus(proposalId, 'implementing', {
        branch: branchName,
        files: changedFiles,
        error: null,
        verification_text: verificationText,
        verification_report: verification.report,
        verification_summary: verification.summary,
        predicate_results: predicateResult.assertionResults,
        predicate_failure_reason: predicateResult.failureReason,
        verified_at: new Date().toISOString(),
      });
      appendLearningLine(proposalId, String(predicateResult.failureReason || 'verification_failed'), {
        branch: branchName,
        files: changedFiles,
        predicate_results: predicateResult.assertionResults,
      });
      deleteBranch = true;
    } else {
      proposalStoreTyped.updateStatus(proposalId, passed ? 'measured' : 'implementing', {
        branch: branchName,
        files: changedFiles,
        error: null,
        verification_text: verificationText,
        verification_report: verification.report,
        verification_summary: verification.summary,
        verified_at: new Date().toISOString(),
        predicate_results: predicateResult.assertionResults,
        predicate_failure_reason: passed ? undefined : predicateResult.failureReason,
      });
      if (!passed) {
        appendLearningLine(proposalId, String(predicateResult.failureReason || 'verification_failed'), {
          branch: branchName,
          files: changedFiles,
          predicate_results: predicateResult.assertionResults,
        });
        deleteBranch = true;
      }
    }

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
        ? `✅ proof-r 검증 통과\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n📂 ${changedFiles.length}개 파일\n🧾 measured 상태로 전이 — adopt review 대기`
        : `❌ proof-r 검증 실패\n📄 ${proposal.title || proposalId}\n🌿 ${branchName}\n사유: ${verificationText.slice(0, 500)}`,
      team: 'darwin',
      alertLevel: passed ? 2 : 3,
      fromBot: 'proof-r',
      inlineKeyboard: passed && requiresApproval
        ? [[
            { text: '🧾 채택 검토', callback_data: `darwin_manual:${proposalId}` },
            { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
          ]]
        : !passed ? [[
            { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
          ]]
        : null,
    } as AlarmPayload);

    if (passed) {
      autonomyLevelTyped.recordVerifiedSuccess();
    } else {
      autonomyLevelTyped.recordMergeFailure(new Error(`predicate_failed: ${verificationText.slice(0, 500)}`));
    }

    return { ok: true, passed, changedFiles, verificationText };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    logger.error(`검증 실패: ${proposalId} -> ${errorMessage}`);
    autonomyLevelTyped.recordError(error);
    await _recordVerificationFailureTrajectory(proposalId, proposal, branchName, [], errorMessage, 'verification_error');
    if (proposalStoreTyped.transitionProposal) {
      try {
        proposalStoreTyped.transitionProposal(proposalId, 'archived', {
          reason: 'verification_error',
          branch: branchName,
          error: errorMessage,
        });
      } catch {
        proposalStoreTyped.updateStatus(proposalId, 'archived', {
          archive_reason: 'verification_error',
          branch: branchName,
          error: errorMessage,
        });
      }
    } else {
      proposalStoreTyped.updateStatus(proposalId, 'archived', {
        archive_reason: 'verification_error',
        branch: branchName,
        error: errorMessage,
      });
    }
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
    keepLab = process.env.DARWIN_KEEP_FAILED_LAB === 'true';
    throw error;
  } finally {
    if (lab && (!keepLab || passed)) {
      try {
        removeLab(lab.path);
      } catch {}
    }
    if (deleteBranch) {
      try {
        _deleteBranchIfExists(branchName);
      } catch {}
    }
  }
}

async function mergeVerifiedProposal(proposalId: string): Promise<{ ok: true; branch: string }> {
  const proposal = proposalStoreTyped.loadProposal(proposalId);
  if (!proposal?.branch) {
    const error = new Error(`branch missing for proposal: ${proposalId}`);
    autonomyLevelTyped.recordMergeFailure(error);
    throw error;
  }

  const merged = await mergeBranch(proposal.branch, proposalId);
  if (proposalStoreTyped.transitionProposal) {
    proposalStoreTyped.transitionProposal(proposalId, 'adopted', {
      reason: 'merge_succeeded',
      merged_at: new Date().toISOString(),
      merged_branch: proposal.branch,
    });
  } else {
    proposalStoreTyped.updateStatus(proposalId, 'adopted', {
      merged_at: new Date().toISOString(),
      merged_branch: proposal.branch,
    });
  }
  autonomyLevelTyped.recordMergeSuccess();
  await postAlarm({
    message: `🎉 다윈 제안 머지 완료\n📄 ${proposal.title || proposalId}\n🌿 ${proposal.branch}`,
    team: 'darwin',
    alertLevel: 2,
    fromBot: 'proof-r',
  } as AlarmPayload);
  return merged;
}

async function mergeBranch(branchName: string, label: string): Promise<{ ok: true; branch: string }> {
  const guard = assertOpsRootOnMain({ context: `verifier:merge:${label}` });
  if (!guard.ok) throw new Error(`ops_root_not_main:${guard.branch}`);
  try {
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
    autonomyLevelTyped.recordMergeFailure(error);
    throw error;
  }
}

module.exports = {
  triggerVerification,
  mergeVerifiedProposal,
  mergeBranch,
  _formatFailureHints,
  _recordVerificationSuccessTrajectory,
  _testOnly_REPO_ROOT: REPO_ROOT,
};

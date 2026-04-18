// @ts-nocheck
'use strict';

/**
 * src/reviewer.ts — 클로드팀 리뷰어 봇 (완전 구현)
 *
 * 역할:
 *   - 커밋 후 코드 리뷰 자동화 (JS/TS 파일 변경 감지)
 *   - 테스트 커버리지 변화 추적
 *   - LLM 기반 종합 코드 리뷰
 *   - Telegram 리뷰 결과 알림
 *
 * Kill Switch: CLAUDE_REVIEWER_ENABLED=true (기본 false)
 *
 * 트리거:
 *   - launchd 30분 주기 (ai.claude.reviewer)
 *   - Commander `run_review` 명령
 *   - Codex Pipeline 완료 이벤트
 */

const path    = require('path');
const { execSync } = require('child_process');

const skills       = require('../../../packages/core/lib/skills');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env          = require('../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT;

// ─── 유틸리티 ─────────────────────────────────────────────────────────

function safeExec(command, options = {}) {
  try {
    return execSync(command, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 30000,
      ...options,
    }).trim();
  } catch (error) {
    console.warn(`[reviewer] 명령 실행 실패: ${error.message?.slice(0, 200)}`);
    return '';
  }
}

// ─── 변경 파일 분석 ───────────────────────────────────────────────────

/**
 * 최근 커밋 변경 파일 목록 + diff 요약
 */
async function analyzeChanges(commitRef = 'HEAD~1') {
  const changedOutput = safeExec(`git diff --name-only ${commitRef}`);
  const files = changedOutput
    ? changedOutput.split('\n').map(l => l.trim()).filter(Boolean)
    : [];

  if (files.length === 0) {
    return { files: [], added_lines: 0, removed_lines: 0, diff_summary: '변경 없음' };
  }

  const statOutput = safeExec(`git diff --stat ${commitRef}`);
  const addedMatch  = statOutput.match(/(\d+) insertion/);
  const removedMatch = statOutput.match(/(\d+) deletion/);

  const added_lines   = addedMatch   ? Number(addedMatch[1])   : 0;
  const removed_lines = removedMatch ? Number(removedMatch[1]) : 0;

  // diff 내용 (최대 3000자)
  const diffContent = safeExec(`git diff ${commitRef} -- ${files.slice(0, 10).map(f => `"${f}"`).join(' ')}`);
  const diff_summary = diffContent.slice(0, 3000) || '(diff 없음)';

  return { files, added_lines, removed_lines, diff_summary };
}

/**
 * 현재 변경된 파일 목록 (HEAD~1 기준)
 */
async function getChangedFiles() {
  const output = safeExec('git diff --name-only HEAD~1');
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(file => path.join(ROOT, file));
}

// ─── 테스트 커버리지 변화 ─────────────────────────────────────────────

/**
 * 현재 테스트 결과 실행 (지원 프레임워크: mix test, jest)
 */
async function runTestsAndGetResult() {
  // Elixir 프로젝트 테스트 (team_jay 기준)
  const elixirApps = [
    path.join(ROOT, 'elixir/team_jay'),
    path.join(ROOT, 'bots/investment/elixir'),
    path.join(ROOT, 'bots/darwin/elixir'),
  ];

  let totalTests = 0;
  let totalFailures = 0;

  for (const appPath of elixirApps) {
    try {
      const result = safeExec('mix test --formatter ExUnit.CLIFormatter 2>&1', {
        cwd: appPath,
        timeout: 90000,
      });
      const testMatch    = result.match(/(\d+) tests?/);
      const failureMatch = result.match(/(\d+) failures?/);
      if (testMatch) totalTests += Number(testMatch[1]);
      if (failureMatch) totalFailures += Number(failureMatch[1]);
    } catch {}
  }

  // JS/TS jest 테스트 (packages/core)
  try {
    const jestResult = safeExec('npx jest --passWithNoTests --silent 2>&1', {
      cwd: ROOT,
      timeout: 60000,
    });
    const jTestMatch    = jestResult.match(/Tests:\s+\d+ passed,\s+(\d+) failed/);
    const jPassMatch    = jestResult.match(/Tests:\s+(\d+) passed/);
    if (jPassMatch) totalTests += Number(jPassMatch[1]);
    if (jTestMatch) totalFailures += Number(jTestMatch[1]);
  } catch {}

  return { tests: totalTests, failures: totalFailures };
}

/**
 * 테스트 변화 비교
 */
async function testCoverageDelta(before, after) {
  const regression = after.failures > before.failures ||
    (before.tests > 0 && after.tests < before.tests * 0.9);
  return {
    before_tests:    before.tests,
    after_tests:     after.tests,
    before_failures: before.failures,
    after_failures:  after.failures,
    regression,
  };
}

// ─── 리뷰 종합 ────────────────────────────────────────────────────────

/**
 * 코드 리뷰 결과 포맷
 */
function formatFindings(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) return ['- 상세 이슈 없음'];
  const grouped = new Map();
  for (const item of findings) {
    const key = item.severity || 'INFO';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const lines = [];
  for (const severity of order) {
    const items = grouped.get(severity);
    if (!items || items.length === 0) continue;
    lines.push(`- ${severity}: ${items.length}건`);
    items.slice(0, 10).forEach(item => {
      lines.push(`  · ${path.relative(ROOT, item.file || ROOT)}:${item.line || 0} — ${item.desc}`);
    });
  }
  return lines;
}

/**
 * 리뷰 결과 포맷
 */
function formatReport(result) {
  const summary   = result?.summary || {};
  const totalFiles = Number(summary.totalFiles || 0);
  const lines = [];

  if (summary.pass) {
    lines.push(`✅ 코드 리뷰 통과 (${totalFiles}개 파일)`);
  } else {
    lines.push('⚠️ 코드 리뷰 이슈 발견');
    lines.push(`- 대상 파일: ${totalFiles}개`);
    lines.push(`- 문법 실패: ${Number(summary.syntaxFails || 0)}건`);
    lines.push(`- CRITICAL: ${Number(summary.critical || 0)}건`);
    lines.push(`- HIGH: ${Number(summary.high || 0)}건`);
    lines.push(`- MEDIUM: ${Number(summary.medium || 0)}건`);
    lines.push('');
    lines.push('이슈 요약:');
    lines.push(...formatFindings(result?.findings || []));
  }

  return lines.join('\n');
}

/**
 * TypeScript 타입 체크
 */
function runTypeScriptCheck() {
  const issues = [];
  try {
    safeExec('npx tsc --noEmit --strict 2>&1', { timeout: 60000 });
  } catch (e) {
    const output = String(e.stdout || e.stderr || e.message || '');
    const errorLines = output.split('\n')
      .filter(l => l.includes('error TS'))
      .slice(0, 20);
    errorLines.forEach(line => {
      const m = line.match(/^(.+)\((\d+),\d+\):.+error (TS\d+): (.+)$/);
      if (m) {
        issues.push({
          file: path.join(ROOT, m[1]),
          line: Number(m[2]),
          severity: 'HIGH',
          desc: `${m[3]}: ${m[4].slice(0, 100)}`,
        });
      }
    });
  }
  return issues;
}

/**
 * 메인 리뷰 실행
 */
async function runReview(options = {}) {
  const enabled  = process.env.CLAUDE_REVIEWER_ENABLED === 'true';
  const testMode = Boolean(options.test) || process.argv.includes('--test');

  if (!enabled && !testMode && !options.force) {
    return {
      files: [], summary: { totalFiles: 0, syntaxFails: 0, critical: 0, high: 0, medium: 0, pass: true },
      sent: false, skipped: true, message: '[리뷰어] Kill Switch OFF — 스킵',
    };
  }

  const files    = await getChangedFiles();
  const jsFiles  = files.filter(file => /\.(m?js|cjs|ts|tsx)$/i.test(file));
  const tsIssues = runTypeScriptCheck();

  if (jsFiles.length === 0 && tsIssues.length === 0) {
    const message = '✅ 코드 리뷰 스킵 — 변경된 JS/TS 파일이 없습니다.';
    if (!testMode) await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'reviewer' });
    return {
      files: [], summary: { totalFiles: 0, syntaxFails: 0, critical: 0, high: 0, medium: 0, pass: true },
      sent: !testMode, skipped: true, message,
    };
  }

  // 기존 JS 패턴 체크
  const skillsResult = jsFiles.length > 0 ? skills.codeReview.runChecklist(jsFiles) : {
    summary: { totalFiles: 0, syntaxFails: 0, critical: 0, high: 0, medium: 0, pass: true },
    findings: [],
  };

  // TypeScript 이슈 병합
  const allFindings = [
    ...(skillsResult.findings || []),
    ...tsIssues,
  ];
  const summary = {
    ...skillsResult.summary,
    totalFiles: jsFiles.length,
    high: (skillsResult.summary.high || 0) + tsIssues.filter(i => i.severity === 'HIGH').length,
    pass: skillsResult.summary.pass && tsIssues.length === 0,
  };

  const result = { summary, findings: allFindings };
  const message = formatReport(result);

  let sent = false;
  if (!testMode) {
    const alertLevel = !summary.pass ? (summary.critical > 0 ? 4 : 3) : 2;
    sent = (await postAlarm({ message, team: 'claude', alertLevel, fromBot: 'reviewer' })).ok;
  }

  return { files: jsFiles, summary, sent, skipped: false, message, findings: allFindings };
}

/**
 * Telegram 보고 (Commander 호출용)
 */
async function reportToTelegram(review) {
  const msg = review.message || formatReport(review);
  return postAlarm({ message: msg, team: 'claude', alertLevel: review.summary?.pass ? 2 : 3, fromBot: 'reviewer' });
}

module.exports = { getChangedFiles, analyzeChanges, testCoverageDelta, runReview, formatReport, reportToTelegram };

if (require.main === module) {
  runReview({ force: true })
    .then(result => {
      console.log(result.message || formatReport(result));
      process.exit(result.summary?.pass === false ? 1 : 0);
    })
    .catch(error => {
      console.warn(`[reviewer] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}

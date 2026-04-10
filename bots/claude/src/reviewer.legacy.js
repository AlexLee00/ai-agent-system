#!/usr/bin/env node
'use strict';

const path = require('path');
const { execSync } = require('child_process');

const skills = require('../../../packages/core/lib/skills');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env = require('../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT;

function safeExec(command, options = {}) {
  try {
    return execSync(command, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      ...options,
    }).trim();
  } catch (error) {
    console.warn(`[reviewer] 명령 실행 실패: ${error.message}`);
    return '';
  }
}

async function getChangedFiles() {
  const output = safeExec('git diff --name-only HEAD~1');
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.join(ROOT, file));
}

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
    items.slice(0, 10).forEach((item) => {
      lines.push(`  · ${path.relative(ROOT, item.file)}:${item.line || 0} — ${item.desc}`);
    });
  }
  return lines;
}

function formatReport(result) {
  const summary = result?.summary || {};
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

async function runReview(options = {}) {
  const testMode = Boolean(options.test) || process.argv.includes('--test');
  const files = await getChangedFiles();
  const jsFiles = files.filter((file) => /\.(m?js|cjs)$/i.test(file));

  if (jsFiles.length === 0) {
    const message = '✅ 코드 리뷰 스킵 — 변경된 JS 파일이 없습니다.';
    if (!testMode) await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'reviewer' });
    return {
      files: [],
      summary: { totalFiles: 0, syntaxFails: 0, critical: 0, high: 0, medium: 0, pass: true },
      sent: !testMode,
      skipped: true,
      message,
    };
  }

  const result = skills.codeReview.runChecklist(jsFiles);
  const message = formatReport(result);
  let sent = false;
  if (!testMode) {
    sent = (await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'reviewer' })).ok;
  }

  return {
    files: jsFiles,
    summary: result.summary,
    sent,
    skipped: false,
    message,
    findings: result.findings,
  };
}

module.exports = { getChangedFiles, runReview, formatReport };

if (require.main === module) {
  runReview()
    .then((result) => {
      console.log(result.message || formatReport(result));
      process.exit(result.summary?.pass === false ? 1 : 0);
    })
    .catch((error) => {
      console.warn(`[reviewer] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
